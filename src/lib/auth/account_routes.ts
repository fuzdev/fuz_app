/**
 * Account route specs for cookie-based session management.
 *
 * Returns `RouteSpec[]` — caller applies them to Hono via `apply_route_specs`.
 *
 * Provides:
 * - `POST /login` — Exchange username + password for signed session cookie
 * - `POST /logout` — Clear session cookie and revoke auth session
 * - `GET /verify` — Check if current session is valid
 * - `GET /sessions` — List auth sessions for current account
 * - `POST /sessions/:id/revoke` — Revoke a single auth session (account-scoped)
 * - `POST /sessions/revoke-all` — Revoke all auth sessions for current account
 * - `POST /tokens/create` — Create an API token
 * - `GET /tokens` — List API tokens for current account
 * - `POST /tokens/:id/revoke` — Revoke an API token (account-scoped)
 * - `POST /password` — Change password (revokes all sessions and API tokens)
 *
 * Signup is separate — see `signup_routes.ts` for invite-gated account creation.
 * Defaults are closed/safe: accounts are created through bootstrap, admin action, or invite.
 *
 * @module
 */

import {z} from 'zod';
import {Blake3Hash} from '@fuzdev/fuz_util/hash_blake3.js';

import type {SessionOptions} from './session_cookie.js';
import {clear_session_cookie} from './session_middleware.js';
import {create_session_and_set_cookie} from './session_lifecycle.js';
import {
	to_session_account,
	SessionAccountJson,
	AuthSessionJson,
	ClientApiTokenJson,
	UsernameProvided,
} from './account_schema.js';
import {
	hash_session_token,
	query_session_revoke_by_hash,
	query_session_revoke_for_account,
	query_session_revoke_all_for_account,
	query_session_list_for_account,
} from './session_queries.js';
import {
	query_account_by_username_or_email,
	query_update_account_password,
} from './account_queries.js';
import {
	query_create_api_token,
	query_api_token_enforce_limit,
	query_api_token_list_for_account,
	query_revoke_api_token_for_account,
	query_revoke_all_api_tokens_for_account,
} from './api_token_queries.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import {generate_api_token} from './api_token.js';
import {get_request_context, require_request_context} from './request_context.js';
import {get_route_input, get_route_params, type RouteSpec} from '../http/route_spec.js';
import {get_client_ip} from '../http/proxy.js';
import {rate_limit_exceeded_response, type RateLimiter} from '../rate_limiter.js';
import {Password, PasswordProvided} from './password.js';
import type {RouteFactoryDeps} from './deps.js';
import {ERROR_AUTHENTICATION_REQUIRED, ERROR_INVALID_CREDENTIALS} from '../http/error_schemas.js';

/**
 * Create the account status route spec.
 *
 * Handles both authenticated and unauthenticated requests:
 * - Authenticated: returns `{account}` with 200
 * - Unauthenticated: returns 401 with optional `bootstrap_available` flag
 *
 * This eliminates the need for a separate `/health` fetch on page load —
 * the frontend gets both session state and bootstrap availability in one request.
 *
 * @param options - optional configuration (bootstrap_status for bootstrap detection)
 * @returns a single account status route spec
 */
export const create_account_status_route_spec = (options?: AccountStatusOptions): RouteSpec => ({
	method: 'GET',
	path: options?.path ?? '/api/account/status',
	auth: {type: 'none'},
	description: 'Current account info (unauthenticated: 401 with bootstrap status)',
	input: z.null(),
	output: z.looseObject({account: z.looseObject({})}),
	errors: {
		401: z.looseObject({
			error: z.literal(ERROR_AUTHENTICATION_REQUIRED),
			bootstrap_available: z.boolean().optional(),
		}),
	},
	handler: (c) => {
		const ctx = get_request_context(c);
		if (ctx) {
			return c.json({account: to_session_account(ctx.account), permits: ctx.permits});
		}
		return c.json(
			{
				error: ERROR_AUTHENTICATION_REQUIRED,
				...(options?.bootstrap_status?.available ? {bootstrap_available: true} : {}),
			},
			401,
		);
	},
});

/** Options for the account status route spec. */
export interface AccountStatusOptions {
	/** Override the default path (`/api/account/status`). */
	path?: string;
	/** Runtime bootstrap status — when available, 401 responses include `bootstrap_available`. */
	bootstrap_status?: {available: boolean};
}

/** Default maximum sessions per account. */
export const DEFAULT_MAX_SESSIONS = 5;

/** Default maximum API tokens per account. */
export const DEFAULT_MAX_TOKENS = 10;

/**
 * Shared options for route factories that create sessions and rate-limit by IP.
 *
 * Extended by `AccountRouteOptions` and `SignupRouteOptions`.
 * Consumers can destructure these from `AppServerContext` once and spread into multiple factories.
 */
export interface AuthSessionRouteOptions {
	session_options: SessionOptions<string>;
	/** Rate limiter for auth attempts, keyed by client IP. Pass `null` to disable. */
	ip_rate_limiter: RateLimiter | null;
}

/**
 * Per-factory configuration for account route specs.
 */
export interface AccountRouteOptions extends AuthSessionRouteOptions {
	/** Rate limiter for login attempts, keyed by submitted username. Pass `null` to disable. */
	login_account_rate_limiter: RateLimiter | null;
	/** Max active sessions per account. Evicts oldest on login. Default 5, `null` disables. */
	max_sessions?: number | null;
	/** Max API tokens per account. Evicts oldest on creation. Default 10, `null` disables. */
	max_tokens?: number | null;
}

/**
 * Create account route specs for session-based auth.
 *
 * All session/token revocation is account-scoped to prevent cross-account attacks.
 *
 * @param deps - stateless capabilities (keyring, password, log)
 * @param options - per-factory configuration (session_options, ip_rate_limiter, login_account_rate_limiter)
 * @returns route specs (not yet applied to Hono)
 */
export const create_account_route_specs = (
	deps: RouteFactoryDeps,
	options: AccountRouteOptions,
): Array<RouteSpec> => {
	const {keyring, password, on_audit_event} = deps;
	const {
		session_options,
		ip_rate_limiter,
		login_account_rate_limiter,
		max_sessions = DEFAULT_MAX_SESSIONS,
		max_tokens = DEFAULT_MAX_TOKENS,
	} = options;

	return [
		{
			method: 'POST',
			path: '/login',
			auth: {type: 'none'},
			description: 'Exchange credentials for session',
			input: z.strictObject({
				username: UsernameProvided,
				password: PasswordProvided,
			}),
			output: z.strictObject({ok: z.literal(true)}),
			rate_limit: 'both',
			errors: {401: z.looseObject({error: z.literal(ERROR_INVALID_CREDENTIALS)})},
			handler: async (c, route) => {
				// Per-IP rate limit check (before any DB/password work)
				const ip = ip_rate_limiter ? get_client_ip(c) : null;
				if (ip_rate_limiter && ip) {
					const check = ip_rate_limiter.check(ip);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				const {username: raw_username, password: pw} = get_route_input<{
					username: string;
					password: string;
				}>(c);
				const username = raw_username.trim().toLowerCase();

				// Per-account rate limit check (after input parsing, before DB work)
				if (login_account_rate_limiter) {
					const check = login_account_rate_limiter.check(username);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				const account = await query_account_by_username_or_email(route, username);
				if (!account) {
					// enumeration prevention: verify_dummy equalizes timing, and both failure
					// paths return identical errors with identical rate limiting behavior
					await password.verify_dummy(pw);
					if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
					if (login_account_rate_limiter) login_account_rate_limiter.record(username);
					void audit_log_fire_and_forget(
						route,
						{
							event_type: 'login',
							outcome: 'failure',
							ip: get_client_ip(c),
							metadata: {username},
						},
						deps.log,
						on_audit_event,
					);
					return c.json({error: ERROR_INVALID_CREDENTIALS}, 401);
				}

				const valid = await password.verify_password(pw, account.password_hash);
				if (!valid) {
					if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
					if (login_account_rate_limiter) login_account_rate_limiter.record(username);
					void audit_log_fire_and_forget(
						route,
						{
							event_type: 'login',
							outcome: 'failure',
							account_id: account.id,
							ip: get_client_ip(c),
							metadata: {username},
						},
						deps.log,
						on_audit_event,
					);
					return c.json({error: ERROR_INVALID_CREDENTIALS}, 401);
				}

				// Successful login — reset rate limits
				if (ip_rate_limiter && ip) ip_rate_limiter.reset(ip);
				if (login_account_rate_limiter) login_account_rate_limiter.reset(username);

				await create_session_and_set_cookie({
					keyring,
					deps: route,
					c,
					account_id: account.id,
					session_options,
					max_sessions,
				});
				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'login',
						account_id: account.id,
						ip: get_client_ip(c),
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true});
			},
		},
		{
			method: 'POST',
			path: '/logout',
			auth: {type: 'authenticated'},
			description: 'Revoke current session and clear cookie',
			input: z.null(),
			output: z.strictObject({ok: z.literal(true), username: z.string()}),
			handler: async (c, route) => {
				const ctx = require_request_context(c);
				const session_token: string | null = c.get(session_options.context_key) ?? null;
				if (session_token) {
					const token_hash = hash_session_token(session_token);
					await query_session_revoke_by_hash(route, token_hash);
				}
				clear_session_cookie(c, session_options);
				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'logout',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						ip: get_client_ip(c),
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true, username: ctx.account.username});
			},
		},
		{
			method: 'GET',
			path: '/verify',
			auth: {type: 'authenticated'},
			description: 'Check session validity',
			input: z.null(),
			output: z.strictObject({ok: z.literal(true), account: SessionAccountJson}),
			handler: (c) => {
				const ctx = require_request_context(c);
				return c.json({ok: true, account: to_session_account(ctx.account)});
			},
		},
		{
			method: 'GET',
			path: '/sessions',
			auth: {type: 'authenticated'},
			description: 'List auth sessions for current account',
			input: z.null(),
			output: z.strictObject({sessions: z.array(AuthSessionJson)}),
			handler: async (c, route) => {
				const ctx = require_request_context(c);
				const sessions = await query_session_list_for_account(route, ctx.account.id);
				return c.json({sessions});
			},
		},
		{
			method: 'POST',
			path: '/sessions/:id/revoke',
			auth: {type: 'authenticated'},
			description: 'Revoke a single auth session (account-scoped)',
			params: z.strictObject({id: Blake3Hash}),
			input: z.null(),
			output: z.strictObject({ok: z.literal(true), revoked: z.boolean()}),
			handler: async (c, route) => {
				const ctx = require_request_context(c);
				const {id} = get_route_params<{id: string}>(c);
				const revoked = await query_session_revoke_for_account(route, id, ctx.account.id);
				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'session_revoke',
						outcome: revoked ? 'success' : 'failure',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						ip: get_client_ip(c),
						metadata: {session_id: id},
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true, revoked});
			},
		},
		{
			method: 'POST',
			path: '/sessions/revoke-all',
			auth: {type: 'authenticated'},
			description: 'Revoke all auth sessions for current account',
			input: z.null(),
			output: z.strictObject({ok: z.literal(true), count: z.number()}),
			handler: async (c, route) => {
				const ctx = require_request_context(c);
				const count = await query_session_revoke_all_for_account(route, ctx.account.id);
				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'session_revoke_all',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						ip: get_client_ip(c),
						metadata: {count},
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true, count});
			},
		},
		{
			method: 'POST',
			path: '/tokens/create',
			auth: {type: 'authenticated'},
			description: 'Create API token (shown once)',
			input: z.strictObject({
				name: z.string().default('CLI token'),
			}),
			output: z.strictObject({
				ok: z.literal(true),
				token: z.string(),
				id: z.string(),
				name: z.string(),
			}),
			handler: async (c, route) => {
				const ctx = require_request_context(c);
				const {name} = get_route_input<{name: string}>(c);

				const {token, id, token_hash} = generate_api_token();
				await query_create_api_token(route, id, ctx.account.id, name, token_hash);

				if (max_tokens != null) {
					await query_api_token_enforce_limit(route, ctx.account.id, max_tokens);
				}

				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'token_create',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						ip: get_client_ip(c),
						metadata: {token_id: id, name},
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true, token, id, name});
			},
		},
		{
			method: 'GET',
			path: '/tokens',
			auth: {type: 'authenticated'},
			description: 'List API tokens for current account',
			input: z.null(),
			output: z.strictObject({tokens: z.array(ClientApiTokenJson)}),
			handler: async (c, route) => {
				const ctx = require_request_context(c);
				const tokens = await query_api_token_list_for_account(route, ctx.account.id);
				return c.json({tokens});
			},
		},
		{
			method: 'POST',
			path: '/tokens/:id/revoke',
			auth: {type: 'authenticated'},
			description: 'Revoke an API token (account-scoped)',
			params: z.strictObject({id: z.string().regex(/^tok_[A-Za-z0-9_-]{12}$/)}),
			input: z.null(),
			output: z.strictObject({ok: z.literal(true), revoked: z.boolean()}),
			handler: async (c, route) => {
				const ctx = require_request_context(c);
				const {id} = get_route_params<{id: string}>(c);
				const revoked = await query_revoke_api_token_for_account(route, id, ctx.account.id);
				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'token_revoke',
						outcome: revoked ? 'success' : 'failure',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						ip: get_client_ip(c),
						metadata: {token_id: id},
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true, revoked});
			},
		},
		{
			method: 'POST',
			path: '/password',
			auth: {type: 'authenticated'},
			description: 'Change password (revokes all sessions and API tokens)',
			input: z.strictObject({
				current_password: PasswordProvided,
				new_password: Password,
			}),
			output: z.strictObject({
				ok: z.literal(true),
				sessions_revoked: z.number(),
				tokens_revoked: z.number(),
			}),
			rate_limit: login_account_rate_limiter ? 'both' : 'ip',
			handler: async (c, route) => {
				// per-IP rate limit check (before argon2 work)
				const ip = ip_rate_limiter ? get_client_ip(c) : null;
				if (ip_rate_limiter && ip) {
					const check = ip_rate_limiter.check(ip);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				const ctx = require_request_context(c);
				const {current_password, new_password} = get_route_input<{
					current_password: string;
					new_password: string;
				}>(c);

				// per-account rate limit check (after context resolution, before argon2 work)
				if (login_account_rate_limiter) {
					const check = login_account_rate_limiter.check(ctx.account.id);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				const valid = await password.verify_password(current_password, ctx.account.password_hash);
				if (!valid) {
					if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
					if (login_account_rate_limiter) login_account_rate_limiter.record(ctx.account.id);
					void audit_log_fire_and_forget(
						route,
						{
							event_type: 'password_change',
							outcome: 'failure',
							actor_id: ctx.actor.id,
							account_id: ctx.account.id,
							ip: get_client_ip(c),
						},
						deps.log,
						on_audit_event,
					);
					return c.json({error: ERROR_INVALID_CREDENTIALS}, 401);
				}

				// successful verification — reset rate limiters
				if (ip_rate_limiter && ip) ip_rate_limiter.reset(ip);
				if (login_account_rate_limiter) login_account_rate_limiter.reset(ctx.account.id);

				const new_hash = await password.hash_password(new_password);
				await query_update_account_password(route, ctx.account.id, new_hash, ctx.actor.id);

				// revoke all sessions and API tokens (force re-auth everywhere)
				const sessions_revoked = await query_session_revoke_all_for_account(route, ctx.account.id);
				const tokens_revoked = await query_revoke_all_api_tokens_for_account(route, ctx.account.id);

				clear_session_cookie(c, session_options);
				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'password_change',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						ip: get_client_ip(c),
						metadata: {sessions_revoked, tokens_revoked},
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true, sessions_revoked, tokens_revoked});
			},
		},
	];
};
