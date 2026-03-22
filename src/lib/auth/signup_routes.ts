/**
 * Signup route spec for account creation.
 *
 * Public endpoint that creates an account. When `open_signup` is disabled
 * (default), a matching unclaimed invite is required. When enabled, anyone
 * can sign up without an invite. Follows the `bootstrap_routes.ts` pattern.
 *
 * @module
 */

import {z} from 'zod';

import {create_session_and_set_cookie} from './session_lifecycle.js';
import {query_create_account_with_actor} from './account_queries.js';
import {query_invite_find_unclaimed_match, query_invite_claim} from './invite_queries.js';
import type {Invite} from './invite_schema.js';
import {Username, Email} from './account_schema.js';
import {Password} from './password.js';
import {get_route_input, type RouteSpec} from '../http/route_spec.js';
import {get_client_ip} from '../http/proxy.js';
import {rate_limit_exceeded_response, type RateLimiter} from '../rate_limiter.js';
import type {RouteFactoryDeps} from './deps.js';
import {ERROR_NO_MATCHING_INVITE, ERROR_SIGNUP_CONFLICT} from '../http/error_schemas.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import type {AppSettings} from './app_settings_schema.js';
import {is_pg_unique_violation} from '../db/pg_error.js';
import type {AuthSessionRouteOptions} from './account_routes.js';

/**
 * Per-factory configuration for signup route specs.
 */
export interface SignupRouteOptions extends AuthSessionRouteOptions {
	/** Rate limiter for signup attempts, keyed by submitted username. Pass `null` to disable. */
	signup_account_rate_limiter: RateLimiter | null;
	/** Mutable ref to app settings — when `open_signup` is true, invite check is skipped. */
	app_settings: AppSettings;
}

/**
 * Create signup route specs for account creation.
 *
 * @param deps - stateless capabilities
 * @param options - per-factory configuration
 * @returns route specs (not yet applied to Hono)
 */
export const create_signup_route_specs = (
	deps: RouteFactoryDeps,
	options: SignupRouteOptions,
): Array<RouteSpec> => {
	const {keyring, password, on_audit_event} = deps;
	const {session_options, ip_rate_limiter, signup_account_rate_limiter, app_settings} = options;

	return [
		{
			method: 'POST',
			path: '/signup',
			auth: {type: 'none'},
			description: 'Create account (invite-gated or open signup)',
			transaction: false, // manages its own transaction for TOCTOU safety
			input: z.strictObject({
				username: Username,
				password: Password,
				email: Email.optional(),
			}),
			output: z.strictObject({ok: z.literal(true)}),
			rate_limit: signup_account_rate_limiter ? 'both' : 'ip',
			errors: {
				403: z.looseObject({error: z.literal(ERROR_NO_MATCHING_INVITE)}),
				409: z.looseObject({error: z.literal(ERROR_SIGNUP_CONFLICT)}),
			},
			handler: async (c, route) => {
				// Per-IP rate limit check (before any work)
				const ip = ip_rate_limiter ? get_client_ip(c) : null;
				if (ip_rate_limiter && ip) {
					const check = ip_rate_limiter.check(ip);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				const {
					username,
					password: pw,
					email,
				} = get_route_input<{
					username: string;
					password: string;
					email?: string;
				}>(c);

				// Per-account rate limit check (after input parsing, before DB work)
				const account_key = username.toLowerCase();
				if (signup_account_rate_limiter) {
					const check = signup_account_rate_limiter.check(account_key);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				// Check for matching invite (unless open signup is enabled)
				let invite: Invite | undefined;
				if (!app_settings.open_signup) {
					invite = await query_invite_find_unclaimed_match(
						{db: route.background_db},
						email ?? null,
						username,
					);
					if (!invite) {
						if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
						if (signup_account_rate_limiter) signup_account_rate_limiter.record(account_key);
						return c.json({error: ERROR_NO_MATCHING_INVITE}, 403);
					}
				}

				// Create account, optionally claim invite, and create session atomically.
				// Username/email uniqueness enforced by DB unique constraints.
				const password_hash = await password.hash_password(pw);

				let result: {id: string};
				try {
					result = await route.background_db.transaction(async (tx) => {
						const tx_deps = {db: tx};

						const {account} = await query_create_account_with_actor(tx_deps, {
							username,
							password_hash,
							email,
						});

						if (invite) {
							const claimed = await query_invite_claim(tx_deps, invite.id, account.id);
							if (!claimed) {
								// Race: invite was claimed between the find and this claim
								throw new SignupConflictError(ERROR_NO_MATCHING_INVITE);
							}
						}

						await create_session_and_set_cookie({
							keyring,
							deps: tx_deps,
							c,
							account_id: account.id,
							session_options,
						});

						return account;
					});
				} catch (e: unknown) {
					if (e instanceof SignupConflictError) {
						if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
						if (signup_account_rate_limiter) signup_account_rate_limiter.record(account_key);
						return c.json({error: e.error}, 403);
					}
					// Unique constraint violation: username or email already exists.
					if (is_pg_unique_violation(e)) {
						if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
						if (signup_account_rate_limiter) signup_account_rate_limiter.record(account_key);
						return c.json({error: ERROR_SIGNUP_CONFLICT}, 409);
					}
					throw e;
				}

				// Reset rate limiters on success
				if (ip_rate_limiter && ip) ip_rate_limiter.reset(ip);
				if (signup_account_rate_limiter) signup_account_rate_limiter.reset(account_key);

				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'signup',
						account_id: result.id,
						ip: get_client_ip(c),
						metadata: invite ? {invite_id: invite.id, username} : {open_signup: true, username},
					},
					deps.log,
					on_audit_event,
				);
				return c.json({ok: true});
			},
		},
	];
};

/** Thrown inside the signup transaction to signal a conflict that should roll back. */
class SignupConflictError extends Error {
	error: string;
	constructor(error: string) {
		super(error);
		this.error = error;
	}
}
