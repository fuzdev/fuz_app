/**
 * Signup route spec for account creation.
 *
 * Public endpoint that creates an account. When `open_signup` is disabled
 * (default), a matching unclaimed invite is required. When enabled, anyone
 * can sign up without an invite. Follows the `auth/bootstrap_routes.ts` pattern.
 *
 * @module
 */

import type {Account, Actor} from './account_schema.ts';

import {create_session_and_set_cookie} from './session_middleware.ts';
import {query_create_account_with_actor} from './account_queries.ts';
import {query_app_settings_load} from './app_settings_queries.ts';
import {
	query_invite_find_unclaimed_match_for_update,
	query_invite_claim_unscoped,
} from './invite_queries.ts';
import type {Invite} from './invite_schema.ts';
import {create_signup_route_shape, type SignupInput} from './signup_route_schema.ts';
import {get_route_input, type RouteSpec} from '../http/route_spec.ts';
import {get_client_ip} from '../http/client_ip.ts';
import {rate_limit_exceeded_response, type RateLimiter} from '../rate_limiter.ts';
import type {RouteFactoryDeps} from './deps.ts';
import {ERROR_NO_MATCHING_INVITE, ERROR_SIGNUP_CONFLICT} from '../http/error_schemas.ts';
import {is_pg_unique_violation} from '../db/pg_error.ts';
import type {AuthSessionRouteOptions} from './account_routes.ts';

/**
 * Default minimum wall-clock time (ms) for a signup denial (403 / 409) response.
 *
 * Parallel to login's `DEFAULT_LOGIN_FAIL_FLOOR_MS`. Without a floor, an
 * attacker can distinguish `ERROR_NO_MATCHING_INVITE` (cheap — bails before
 * Argon2 + tx) from `ERROR_SIGNUP_CONFLICT` (Argon2 + tx + rollback) via
 * response time and use the gap as a username-enumeration oracle. Picked
 * to exceed the p99 of every denial code path (Argon2id dominates at
 * ~100ms, plus DB + overhead). 429 stays fast by design (same precedent
 * as login) so rate-limit DoS handling stays cheap.
 */
export const DEFAULT_SIGNUP_FAIL_FLOOR_MS = 250;

/**
 * Default uniform jitter window (±ms) layered on the floor.
 *
 * Random jitter prevents a stable clamp point from leaking whenever a
 * path occasionally exceeds the floor. `Math.random` is sufficient —
 * we only need unpredictability of the exact delay, not cryptographic
 * guarantees.
 */
export const DEFAULT_SIGNUP_FAIL_JITTER_MS = 25;

const signup_fail_delay = (floor_ms: number, jitter_ms: number): Promise<void> => {
	if (floor_ms <= 0) return Promise.resolve();
	const jitter = jitter_ms > 0 ? Math.floor(Math.random() * (jitter_ms * 2 + 1)) - jitter_ms : 0;
	return new Promise((resolve) => setTimeout(resolve, floor_ms + jitter));
};

/**
 * Per-factory configuration for signup route specs.
 */
export interface SignupRouteOptions extends AuthSessionRouteOptions {
	/** Rate limiter for signup attempts, keyed by submitted username. Pass `null` to disable. */
	signup_account_rate_limiter: RateLimiter | null;
	/**
	 * Minimum wall-clock time (ms) for signup denial responses (403 / 409).
	 * Set to `0` or a negative number to disable (e.g., in tests). Default
	 * `DEFAULT_SIGNUP_FAIL_FLOOR_MS`. 429 responses are not floored.
	 */
	signup_fail_floor_ms?: number;
	/**
	 * Uniform jitter window (±ms) layered on the floor. Set to `0` to
	 * disable jitter while keeping the floor. Default
	 * `DEFAULT_SIGNUP_FAIL_JITTER_MS`.
	 */
	signup_fail_jitter_ms?: number;
}
// `create_signup_route_specs` spreads the shape and attaches the live handler
// below.

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
	const {keyring, password} = deps;
	const {
		session_options,
		ip_rate_limiter,
		signup_account_rate_limiter,
		signup_fail_floor_ms = DEFAULT_SIGNUP_FAIL_FLOOR_MS,
		signup_fail_jitter_ms = DEFAULT_SIGNUP_FAIL_JITTER_MS,
	} = options;

	return [
		{
			...create_signup_route_shape({
				signup_account_rate_limited: signup_account_rate_limiter !== null,
			}),
			handler: async (c, route) => {
				// Per-IP rate limit check (before any work). 429 stays fast.
				const ip = ip_rate_limiter ? get_client_ip(c) : null;
				if (ip_rate_limiter && ip) {
					const check = ip_rate_limiter.check(ip);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				const {username, password: pw, email} = get_route_input<SignupInput>(c);

				// Per-account rate limit check (after input parsing, before DB work).
				// 429 stays fast — same precedent as login.
				const account_key = username.toLowerCase();
				if (signup_account_rate_limiter) {
					const check = signup_account_rate_limiter.check(account_key);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				// Load the open-signup toggle fresh from the DB on every
				// request — the authoritative source, so multiple server
				// processes never serve a stale in-memory value. Bounded by
				// the per-IP + per-account rate limiters above.
				const {open_signup} = await query_app_settings_load(route);

				// Start the denial-time floor concurrently with failure work.
				// Observed response time for 403 / 409 is `max(work, delay)`
				// so the cheap `no_match` path (no Argon2, find returns
				// nothing) and the expensive `signup_conflict` path (Argon2
				// + tx + rollback) converge — closes the username-enumeration
				// timing oracle. Mirrors login's `login_fail_delay`. Started
				// after rate-limit checks so 429 stays fast.
				const delay = signup_fail_delay(signup_fail_floor_ms, signup_fail_jitter_ms);

				// Hash before the transaction so the connection isn't held
				// across the ~100ms Argon2id. Paid unconditionally — bounded
				// by the per-IP + per-account rate limiters above.
				const password_hash = await password.hash_password(pw);

				// `invite` is assigned inside the tx by the FOR UPDATE find;
				// captured at the outer scope so the failure-audit catch
				// branch can still reference `invite.id` after the tx rolls
				// back on PG unique violation.
				let invite: Invite | undefined;

				const emit_failure_audit = (
					reason: 'no_match' | 'signup_conflict' | 'internal_error',
				): void => {
					deps.audit.emit(route, {
						event_type: 'signup',
						outcome: 'failure',
						ip: get_client_ip(c),
						metadata: {
							username,
							reason,
							...(invite && {invite_id: invite.id}),
							...(email != null && {email}),
							...(open_signup && {open_signup: true}),
						},
					});
				};

				let result: {account: Account; actor: Actor};
				try {
					result = await route.db.transaction(async (tx) => {
						const tx_deps = {db: tx};

						// Find + claim run inside the same transaction so the
						// row lock makes them atomic. Concurrent signups for
						// the same (username, email) tuple block on the lock
						// and observe the post-commit state on retry — the
						// loser's `find_for_update` returns no row (winner
						// flipped `claimed_at`) and falls through to
						// `ERROR_NO_MATCHING_INVITE`. No race window.
						if (!open_signup) {
							invite = await query_invite_find_unclaimed_match_for_update(
								tx_deps,
								email ?? null,
								username,
							);
							if (!invite) {
								throw new NoMatchingInviteError();
							}
						}

						const {account, actor} = await query_create_account_with_actor(tx_deps, {
							username,
							password_hash,
							email,
						});

						if (invite) {
							// Guaranteed to succeed: FOR UPDATE held the row
							// for the duration of the tx, so no concurrent
							// claim could flip `claimed_at` between the find
							// and this UPDATE.
							await query_invite_claim_unscoped(tx_deps, invite.id, account.id);
						}

						await create_session_and_set_cookie({
							keyring,
							deps: tx_deps,
							c,
							account_id: account.id,
							session_options,
						});

						return {account, actor};
					});
				} catch (e: unknown) {
					if (e instanceof NoMatchingInviteError) {
						if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
						if (signup_account_rate_limiter) signup_account_rate_limiter.record(account_key);
						emit_failure_audit('no_match');
						await delay;
						return c.json({error: ERROR_NO_MATCHING_INVITE}, 403);
					}
					// Unique constraint violation: username or email already exists.
					if (is_pg_unique_violation(e)) {
						if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
						if (signup_account_rate_limiter) signup_account_rate_limiter.record(account_key);
						emit_failure_audit('signup_conflict');
						await delay;
						return c.json({error: ERROR_SIGNUP_CONFLICT}, 409);
					}
					// Unclassified failure (e.g. session create error, Argon2
					// fault on hash, DB outage mid-tx). Tx is rolled back so
					// no account persists, but the *attempt* should leave a
					// forensic trail — emit `outcome: 'failure'` with reason
					// `internal_error` before rethrowing. 5xx responses are
					// not floored: they aren't response-time-controlled
					// enumeration oracles.
					emit_failure_audit('internal_error');
					throw e;
				}

				// Reset rate limiters on success
				if (ip_rate_limiter && ip) ip_rate_limiter.reset(ip);
				if (signup_account_rate_limiter) signup_account_rate_limiter.reset(account_key);

				deps.audit.emit(route, {
					event_type: 'signup',
					account_id: result.account.id,
					ip: get_client_ip(c),
					metadata: invite ? {invite_id: invite.id, username} : {open_signup: true, username},
				});
				return c.json({
					ok: true,
					account: {id: result.account.id, username: result.account.username},
					actor: {id: result.actor.id},
				});
			},
		},
	];
};

/**
 * Thrown inside the signup transaction to signal `ERROR_NO_MATCHING_INVITE`
 * when the FOR UPDATE find returns no row (and `open_signup` is off).
 * Caught by the handler to roll back the tx and emit the failure audit.
 */
class NoMatchingInviteError extends Error {}
