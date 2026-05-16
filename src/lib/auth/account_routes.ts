/**
 * Account route specs for cookie-based session management.
 *
 * Returns `RouteSpec[]` — caller applies them to Hono via `apply_route_specs`.
 *
 * Four REST flows remain here; each has a concrete reason to stay REST
 * rather than moving to `auth/account_actions.ts`:
 *
 * - `POST /login` — issues a signed `Set-Cookie` and pre-handler rate-limits
 *   by IP + per-canonical-account before password hashing.
 * - `POST /logout` — clears the session cookie.
 * - `POST /password` — cookie clear + revoke-all cascade; rate-limit-shaped
 *   error envelope on 429.
 * - `GET /verify` — empty-body nginx `auth_request` probe. Programmatic
 *   callers should use the `account_verify` RPC action for the typed payload.
 *
 * Session listing/revocation and API token CRUD are on the RPC endpoint —
 * see `auth/account_actions.ts`. Signup is in `auth/signup_routes.ts`. Defaults are
 * closed/safe: accounts are created through bootstrap, admin action, or
 * invite.
 *
 * @module
 */

import {z} from 'zod';

import type {SessionOptions} from './session_cookie.js';
import {clear_session_cookie, create_session_and_set_cookie} from './session_middleware.js';
import {
	ActorSummaryJson,
	RoleGrantSummaryJson,
	SessionAccountJson,
	to_session_account,
} from './account_schema.js';
import {UsernameProvided} from '../primitive_schemas.js';
import {
	hash_session_token,
	query_session_revoke_all_for_account,
	query_session_revoke_by_hash_unscoped,
} from './session_queries.js';
import {
	query_account_by_username_or_email,
	query_update_account_password,
} from './account_queries.js';
import {query_revoke_all_api_tokens_for_account} from './api_token_queries.js';
import {
	build_account_context,
	build_request_context,
	get_request_context,
	require_request_context,
	resolve_acting_actor,
} from './request_context.js';
import {ACCOUNT_ID_KEY, CREDENTIAL_TYPE_KEY} from '../hono_context.js';
import {get_route_input, type RouteSpec} from '../http/route_spec.js';
import {get_client_ip} from '../http/proxy.js';
import {rate_limit_exceeded_response, type RateLimiter} from '../rate_limiter.js';
import {Password, PasswordProvided} from './password.js';
import type {RouteFactoryDeps} from './deps.js';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INVALID_CREDENTIALS,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_REQUEST_BODY,
} from '../http/error_schemas.js';

/** Input for `GET /api/account/status`. No parameters — caller is the subject. */
export const AccountStatusInput = z.null();
export type AccountStatusInput = z.infer<typeof AccountStatusInput>;

/**
 * Output for `GET /api/account/status` on the authenticated path.
 *
 * `account` is always populated for authenticated callers. `actor` and
 * `role_grants` are populated when the caller's account has a unique actor or
 * the request supplies `?acting=<actor_id>`; on multi-actor accounts
 * without an `acting` query, `actor` is `null` and `role_grants` is empty so
 * the frontend can show a persona picker without a separate roundtrip.
 */
export const AccountStatusOutput = z.strictObject({
	account: SessionAccountJson,
	actor: ActorSummaryJson.nullable(),
	role_grants: z.array(RoleGrantSummaryJson),
});
export type AccountStatusOutput = z.infer<typeof AccountStatusOutput>;

/** Error body for `GET /api/account/status` on the unauthenticated path. */
export const AccountStatusUnauthenticatedError = z.looseObject({
	error: z.literal(ERROR_AUTHENTICATION_REQUIRED),
	bootstrap_available: z.boolean().optional(),
});
export type AccountStatusUnauthenticatedError = z.infer<typeof AccountStatusUnauthenticatedError>;

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
	auth: {account: 'none', actor: 'none'},
	description: 'Current account info (unauthenticated: 401 with bootstrap status)',
	input: AccountStatusInput,
	output: AccountStatusOutput,
	errors: {
		401: AccountStatusUnauthenticatedError,
	},
	handler: async (c, route) => {
		const account_id: string | null = c.get(ACCOUNT_ID_KEY) ?? null;
		if (!account_id) {
			return c.json(
				{
					error: ERROR_AUTHENTICATION_REQUIRED,
					...(options?.bootstrap_status?.available ? {bootstrap_available: true} : {}),
				},
				401,
			);
		}
		// Honor a pre-populated request context. The dispatcher's authorization
		// phase doesn't run for `auth: 'none'` routes, but a caller (test
		// harness, or future middleware) may still populate the context — use
		// it directly to avoid redundant lookups.
		const existing = get_request_context(c);
		if (existing && existing.account.id === account_id) {
			const role_grants: Array<RoleGrantSummaryJson> = existing.role_grants.map((p) => ({
				id: p.id,
				role: p.role,
				scope_kind: p.scope_kind,
				scope_id: p.scope_id,
				created_at: p.created_at,
				expires_at: p.expires_at,
				granted_by: p.granted_by,
			}));
			return c.json({
				account: to_session_account(existing.account),
				actor: existing.actor ? {id: existing.actor.id, name: existing.actor.name} : null,
				role_grants,
			});
		}
		// Resolve actor + role_grants when the caller is unambiguous (single-actor
		// account, or supplied `?acting=<uuid>`). On multi-actor accounts
		// without `acting`, fall back to account-only so the frontend can
		// surface a persona picker.
		const acting = c.req.query('acting') ?? undefined;
		const acting_result = await resolve_acting_actor(route, account_id, acting);
		if (acting_result.ok) {
			const ctx = await build_request_context(route, account_id, acting_result.actor_id);
			if (ctx) {
				const role_grants: Array<RoleGrantSummaryJson> = ctx.role_grants.map((p) => ({
					id: p.id,
					role: p.role,
					scope_kind: p.scope_kind,
					scope_id: p.scope_id,
					created_at: p.created_at,
					expires_at: p.expires_at,
					granted_by: p.granted_by,
				}));
				return c.json({
					account: to_session_account(ctx.account),
					actor: {id: ctx.actor.id, name: ctx.actor.name},
					role_grants,
				});
			}
		}
		const account_ctx = await build_account_context(route, account_id);
		if (!account_ctx) {
			return c.json(
				{
					error: ERROR_AUTHENTICATION_REQUIRED,
					...(options?.bootstrap_status?.available ? {bootstrap_available: true} : {}),
				},
				401,
			);
		}
		return c.json({
			account: to_session_account(account_ctx.account),
			actor: null,
			role_grants: [],
		});
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
 * Default minimum wall-clock time (ms) for a login failure (401) response.
 *
 * Picked to exceed the p99 of every 401 code path (Argon2id dominates at
 * ~100ms, plus DB + overhead). The handler races failure work against
 * `sleep(floor + jitter)` via `await`, so observed response time = max(work,
 * delay). Found-vs-not-found and rate-limit-skipped-vs-not paths converge.
 * Only 401 is padded — 429 stays fast by design to keep rate-limit DoS
 * handling cheap.
 */
export const DEFAULT_LOGIN_FAIL_FLOOR_MS = 250;

/**
 * Default uniform jitter window (±ms) layered on the floor.
 *
 * Random jitter prevents a stable clamp point from leaking whenever a path
 * occasionally exceeds the floor. `Math.random` is sufficient — we only need
 * unpredictability of the exact delay, not cryptographic guarantees.
 */
export const DEFAULT_LOGIN_FAIL_JITTER_MS = 25;

const login_fail_delay = (floor_ms: number, jitter_ms: number): Promise<void> => {
	if (floor_ms <= 0) return Promise.resolve();
	const jitter = jitter_ms > 0 ? Math.floor(Math.random() * (jitter_ms * 2 + 1)) - jitter_ms : 0;
	return new Promise((resolve) => setTimeout(resolve, floor_ms + jitter));
};

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
	/**
	 * Minimum wall-clock time (ms) for login 401 responses. Set to `0` or a
	 * negative number to disable (e.g., in tests). Default
	 * `DEFAULT_LOGIN_FAIL_FLOOR_MS`.
	 */
	login_fail_floor_ms?: number;
	/**
	 * Uniform jitter window (±ms) layered on the floor. Set to `0` to disable
	 * jitter while keeping the floor. Default `DEFAULT_LOGIN_FAIL_JITTER_MS`.
	 */
	login_fail_jitter_ms?: number;
}

// -- Input/output schemas ---------------------------------------------------

/** Input for `POST /login`. Accepts a username or email in the `username` field. */
export const LoginInput = z.strictObject({
	username: UsernameProvided,
	password: PasswordProvided,
});
export type LoginInput = z.infer<typeof LoginInput>;

/** Output for `POST /login`. The signed session cookie is the operative side effect. */
export const LoginOutput = z.strictObject({
	ok: z.literal(true),
});
export type LoginOutput = z.infer<typeof LoginOutput>;

/** Input for `POST /logout`. Session identity flows through the cookie. */
export const LogoutInput = z.null();
export type LogoutInput = z.infer<typeof LogoutInput>;

/** Output for `POST /logout`. Includes the revoked account's username for UI redraw. */
export const LogoutOutput = z.strictObject({
	ok: z.literal(true),
	username: z.string(),
});
export type LogoutOutput = z.infer<typeof LogoutOutput>;

/** Input for `POST /password`. `current_password` is minimally validated; `new_password` enforces the full policy. */
export const PasswordChangeInput = z.strictObject({
	current_password: PasswordProvided,
	new_password: Password,
});
export type PasswordChangeInput = z.infer<typeof PasswordChangeInput>;

/** Output for `POST /password`. Counts are returned so the UI can summarize the revoke-all cascade. */
export const PasswordChangeOutput = z.strictObject({
	ok: z.literal(true),
	sessions_revoked: z.number(),
	tokens_revoked: z.number(),
});
export type PasswordChangeOutput = z.infer<typeof PasswordChangeOutput>;

/**
 * Create account route specs for session-based auth.
 *
 * The returned specs cover the three flows that stay REST after the RPC
 * migration (login, logout, password change). Self-service session/token
 * management and verify are on `auth/account_actions.ts`.
 *
 * @param deps - stateless capabilities (keyring, password, log)
 * @param options - per-factory configuration (session_options, ip_rate_limiter, login_account_rate_limiter)
 * @returns route specs (not yet applied to Hono)
 */
export const create_account_route_specs = (
	deps: RouteFactoryDeps,
	options: AccountRouteOptions,
): Array<RouteSpec> => {
	const {keyring, password} = deps;
	const {
		session_options,
		ip_rate_limiter,
		login_account_rate_limiter,
		max_sessions = DEFAULT_MAX_SESSIONS,
		login_fail_floor_ms = DEFAULT_LOGIN_FAIL_FLOOR_MS,
		login_fail_jitter_ms = DEFAULT_LOGIN_FAIL_JITTER_MS,
	} = options;

	return [
		{
			method: 'GET',
			path: '/verify',
			auth: {account: 'required', actor: 'none'},
			description: 'Session-validity probe for nginx auth_request (empty body, 200 or 401)',
			input: z.null(),
			output: z.null(),
			handler: (c) => {
				require_request_context(c);
				return c.body(null, 200);
			},
		},
		{
			method: 'POST',
			path: '/login',
			auth: {account: 'none', actor: 'none'},
			description: 'Exchange credentials for session',
			input: LoginInput,
			output: LoginOutput,
			rate_limit: 'both',
			errors: {
				400: z.looseObject({
					error: z.enum([ERROR_INVALID_JSON_BODY, ERROR_INVALID_REQUEST_BODY]),
				}),
				401: z.looseObject({error: z.literal(ERROR_INVALID_CREDENTIALS)}),
			},
			handler: async (c, route) => {
				// Per-IP rate limit check (before any DB/password work)
				const ip = ip_rate_limiter ? get_client_ip(c) : null;
				if (ip_rate_limiter && ip) {
					const check = ip_rate_limiter.check(ip);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				const {username: raw_username, password: pw} = get_route_input<LoginInput>(c);
				const username = raw_username.trim().toLowerCase();

				// DB lookup first so we can key the per-account rate limit by a canonical value
				// (account.id) rather than the submitted identifier. Otherwise an attacker could
				// alternate between username and email to double the per-account bucket.
				const account = await query_account_by_username_or_email(route, username);
				const account_rate_key = account ? account.id : username;

				// Per-account rate limit check (after DB lookup so the key is canonical)
				if (login_account_rate_limiter) {
					const check = login_account_rate_limiter.check(account_rate_key);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				// Start the minimum-delay timer concurrently with failure work.
				// Observed response time is max(work, delay) so all 401 paths
				// (found-wrong-pw, not-found) return in similar time.
				const delay = login_fail_delay(login_fail_floor_ms, login_fail_jitter_ms);

				if (!account) {
					// enumeration prevention: verify_dummy equalizes Argon2id timing;
					// login_fail_delay equalizes every other path difference.
					await password.verify_dummy(pw);
					if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
					if (login_account_rate_limiter) login_account_rate_limiter.record(account_rate_key);
					deps.audit.emit(route, {
						event_type: 'login',
						outcome: 'failure',
						ip: get_client_ip(c),
						metadata: {username},
					});
					await delay;
					return c.json({error: ERROR_INVALID_CREDENTIALS}, 401);
				}

				const valid = await password.verify_password(pw, account.password_hash);
				if (!valid) {
					if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
					if (login_account_rate_limiter) login_account_rate_limiter.record(account_rate_key);
					deps.audit.emit(route, {
						event_type: 'login',
						outcome: 'failure',
						account_id: account.id,
						ip: get_client_ip(c),
						metadata: {username},
					});
					await delay;
					return c.json({error: ERROR_INVALID_CREDENTIALS}, 401);
				}

				// Successful login — reset rate limits
				if (ip_rate_limiter && ip) ip_rate_limiter.reset(ip);
				if (login_account_rate_limiter) login_account_rate_limiter.reset(account_rate_key);

				await create_session_and_set_cookie({
					keyring,
					deps: route,
					c,
					account_id: account.id,
					session_options,
					max_sessions,
				});
				deps.audit.emit(route, {
					event_type: 'login',
					account_id: account.id,
					ip: get_client_ip(c),
				});
				return c.json({ok: true});
			},
		},
		{
			method: 'POST',
			path: '/logout',
			auth: {account: 'required', actor: 'none'},
			description: 'Revoke current session and clear cookie',
			input: LogoutInput,
			output: LogoutOutput,
			handler: async (c, route) => {
				const ctx = require_request_context(c);
				const session_token: string | null = c.get(session_options.context_key) ?? null;
				if (session_token) {
					const token_hash = hash_session_token(session_token);
					await query_session_revoke_by_hash_unscoped(route, token_hash);
				}
				clear_session_cookie(c, session_options);
				// Account-grain operation — no `actor_id` (which actor was
				// resolved per-request is incidental to "this account ended
				// its session"). Mirrors `login`.
				deps.audit.emit(route, {
					event_type: 'logout',
					account_id: ctx.account.id,
					ip: get_client_ip(c),
				});
				return c.json({ok: true, username: ctx.account.username});
			},
		},
		{
			method: 'POST',
			path: '/password',
			// `credential_types: ['session']` — see `docs/security.md` §Credential-channel gating.
			auth: {account: 'required', actor: 'none', credential_types: ['session']},
			description: 'Change password (revokes all sessions and API tokens)',
			input: PasswordChangeInput,
			output: PasswordChangeOutput,
			rate_limit: login_account_rate_limiter ? 'both' : 'ip',
			errors: {
				400: z.looseObject({
					error: z.enum([ERROR_INVALID_JSON_BODY, ERROR_INVALID_REQUEST_BODY]),
				}),
			},
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
				const {current_password, new_password} = get_route_input<PasswordChangeInput>(c);
				// Defense in depth — see `docs/security.md` §Credential-channel gating.
				const credential_type = c.get(CREDENTIAL_TYPE_KEY) ?? undefined;

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
					deps.audit.emit(route, {
						event_type: 'password_change',
						outcome: 'failure',
						account_id: ctx.account.id,
						ip: get_client_ip(c),
						metadata: {credential_type},
					});
					return c.json({error: ERROR_INVALID_CREDENTIALS}, 401);
				}

				// successful verification — reset rate limiters
				if (ip_rate_limiter && ip) ip_rate_limiter.reset(ip);
				if (login_account_rate_limiter) login_account_rate_limiter.reset(ctx.account.id);

				const new_hash = await password.hash_password(new_password);
				// Conditional UPDATE keyed on the verified hash: closes the
				// verify-write race with a concurrent password change that
				// already committed against the same starting hash. Account-grain
				// operation — `updated_by` stays null (the per-request actor is
				// incidental; password is account-level state).
				const updated = await query_update_account_password(
					route,
					ctx.account.id,
					new_hash,
					null,
					ctx.account.password_hash,
				);
				if (!updated) {
					// A concurrent password change committed first — our
					// `current_password` was correct at read-time but the row's
					// `password_hash` no longer matches. Mirrors the wrong-password
					// 401 shape; tag the failure metadata so admins reading the
					// audit log can distinguish "user typoed" from "two clients
					// raced." Sessions/tokens were already revoked by the winner;
					// no cookie clear here either.
					if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
					if (login_account_rate_limiter) login_account_rate_limiter.record(ctx.account.id);
					deps.audit.emit(route, {
						event_type: 'password_change',
						outcome: 'failure',
						account_id: ctx.account.id,
						ip: get_client_ip(c),
						metadata: {reason: 'concurrent_change', credential_type},
					});
					return c.json({error: ERROR_INVALID_CREDENTIALS}, 401);
				}

				// revoke all sessions and API tokens (force re-auth everywhere)
				const sessions_revoked = await query_session_revoke_all_for_account(route, ctx.account.id);
				const tokens_revoked = await query_revoke_all_api_tokens_for_account(route, ctx.account.id);

				clear_session_cookie(c, session_options);
				// Account-grain operation — no `actor_id`. The password is
				// account-level state; which per-request actor was resolved
				// has no semantic bearing on "this account changed its
				// password". Mirrors `login`/`logout`.
				deps.audit.emit(route, {
					event_type: 'password_change',
					account_id: ctx.account.id,
					ip: get_client_ip(c),
					metadata: {sessions_revoked, tokens_revoked, credential_type},
				});
				return c.json({ok: true, sessions_revoked, tokens_revoked});
			},
		},
	];
};
