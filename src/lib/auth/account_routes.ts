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

import type { SessionOptions } from './session_cookie.ts';
import { clear_session_cookie, create_session_and_set_cookie } from './session_middleware.ts';
import { RoleGrantSummaryJson, to_session_account } from './account_schema.ts';
import {
	account_status_route_shape,
	create_account_route_shapes,
	DEFAULT_MAX_SESSIONS,
	type LoginInput,
	type PasswordChangeInput
} from './account_route_schema.ts';
import {
	hash_session_token,
	query_session_revoke_all_for_account,
	query_session_revoke_by_hash_unscoped
} from './session_queries.ts';
import {
	query_account_by_username_or_email,
	query_update_account_password
} from './account_queries.ts';
import { query_revoke_all_api_tokens_for_account } from './api_token_queries.ts';
import {
	build_account_context,
	build_request_context,
	get_request_context,
	require_request_context,
	resolve_acting_actor
} from './request_context.ts';
import { ACCOUNT_ID_KEY, CREDENTIAL_TYPE_KEY } from '../hono_context.ts';
import { get_route_input, type RouteSpec } from '../http/route_spec.ts';
import { get_client_ip } from '../http/client_ip.ts';
import { rate_limit_exceeded_response, type RateLimiter } from '../rate_limiter.ts';
import type { RouteFactoryDeps } from './deps.ts';
import type { ConnectionCloser } from '../actions/connection_closer.ts';
import { ERROR_AUTHENTICATION_REQUIRED, ERROR_INVALID_CREDENTIALS } from '../http/error_schemas.ts';

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
	...account_status_route_shape,
	path: options?.path ?? account_status_route_shape.path,
	handler: async (c, route) => {
		const account_id: string | null = c.get(ACCOUNT_ID_KEY) ?? null;
		if (!account_id) {
			return c.json(
				{
					error: ERROR_AUTHENTICATION_REQUIRED,
					...(options?.bootstrap_status?.available ? { bootstrap_available: true } : {})
				},
				401
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
				granted_by: p.granted_by
			}));
			return c.json({
				account: to_session_account(existing.account),
				actor: existing.actor ? { id: existing.actor.id, name: existing.actor.name } : null,
				role_grants
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
					granted_by: p.granted_by
				}));
				return c.json({
					account: to_session_account(ctx.account),
					actor: { id: ctx.actor.id, name: ctx.actor.name },
					role_grants
				});
			}
		}
		const account_ctx = await build_account_context(route, account_id);
		if (!account_ctx) {
			return c.json(
				{
					error: ERROR_AUTHENTICATION_REQUIRED,
					...(options?.bootstrap_status?.available ? { bootstrap_available: true } : {})
				},
				401
			);
		}
		return c.json({
			account: to_session_account(account_ctx.account),
			actor: null,
			role_grants: []
		});
	}
});

/** Options for the account status route spec. */
export interface AccountStatusOptions {
	/** Override the default path (`/api/account/status`). */
	path?: string;
	/** Runtime bootstrap status — when available, 401 responses include `bootstrap_available`. */
	bootstrap_status?: { available: boolean };
}

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
	/**
	 * Live-connection closer — when set, the `logout` and `password` handlers
	 * eagerly close affected WebSocket sockets for the account BEFORE
	 * emitting the corresponding audit event. Mirrors the self-service
	 * action surface (see `AccountActionOptions.connection_closer`). When
	 * absent, only the listener-based close (`transports_ws_auth_guard`
	 * registered via `audit.add_listener`) runs.
	 */
	connection_closer?: ConnectionCloser | null;
	/**
	 * Runtime bootstrap status for the bundled `GET /status` route — when
	 * `available`, its unauthenticated 401 carries `bootstrap_available: true`
	 * so a fresh frontend can route to the bootstrap flow. Pass
	 * `ctx.bootstrap_status` (the live `BootstrapStatus` ref) so the flag tracks
	 * the one-shot bootstrap completing. Omit when no bootstrap flow is wired —
	 * `/status` is still served, just without the flag.
	 */
	bootstrap_status?: { available: boolean };
}
// `create_account_route_specs` spreads each shape and attaches the live
// handler below.

/**
 * Create account route specs for session-based auth.
 *
 * The returned specs cover the REST flows that stay after the RPC migration:
 * `/status` (account info + bootstrap availability), `/verify` (nginx
 * `auth_request` shim), `/login`, `/logout`, `/password`. `/status` is bundled
 * here (relative path, prefixed to `/api/account/status` by the caller) so
 * every account surface serves it, matching the Rust `account_router`.
 * Self-service session/token management is on `auth/account_actions.ts`.
 *
 * @param deps - stateless capabilities (keyring, password, log)
 * @param options - per-factory configuration (session_options, ip_rate_limiter, login_account_rate_limiter, bootstrap_status)
 * @returns route specs (not yet applied to Hono)
 */
export const create_account_route_specs = (
	deps: RouteFactoryDeps,
	options: AccountRouteOptions
): Array<RouteSpec> => {
	const { keyring, password } = deps;
	const {
		session_options,
		ip_rate_limiter,
		login_account_rate_limiter,
		max_sessions = DEFAULT_MAX_SESSIONS,
		login_fail_floor_ms = DEFAULT_LOGIN_FAIL_FLOOR_MS,
		login_fail_jitter_ms = DEFAULT_LOGIN_FAIL_JITTER_MS,
		connection_closer = null,
		bootstrap_status
	} = options;

	const [verify_shape, login_shape, logout_shape, password_shape] = create_account_route_shapes({
		login_account_rate_limited: login_account_rate_limiter !== null
	});

	return [
		// `/status` is bundled into the account family (relative path, prefixed
		// to `/api/account/status` by the caller) so every account surface serves
		// it — matching the Rust `account_router`. The standalone
		// `create_account_status_route_spec` stays the building block.
		create_account_status_route_spec({ bootstrap_status }),
		{
			...verify_shape,
			handler: (c) => {
				require_request_context(c);
				return c.body(null, 200);
			}
		},
		{
			...login_shape,
			handler: async (c, route) => {
				// Per-IP rate limit check (before any DB/password work)
				const ip = ip_rate_limiter ? get_client_ip(c) : null;
				if (ip_rate_limiter && ip) {
					const check = ip_rate_limiter.check(ip);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				// `UsernameProvided` canonicalizes via `.trim().toLowerCase()` at
				// parse time — the validated value lands canonical in
				// `c.var.validated_input`, so the per-account rate-limit key,
				// DB lookup, and audit metadata see one form. See
				// `primitive_schemas.ts` for the schema-layer canonicalization.
				const { username, password: pw } = get_route_input<LoginInput>(c);

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
						metadata: { username }
					});
					await delay;
					return c.json({ error: ERROR_INVALID_CREDENTIALS }, 401);
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
						metadata: { username }
					});
					await delay;
					return c.json({ error: ERROR_INVALID_CREDENTIALS }, 401);
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
					max_sessions
				});
				deps.audit.emit(route, {
					event_type: 'login',
					account_id: account.id,
					ip: get_client_ip(c)
				});
				return c.json({ ok: true });
			}
		},
		{
			...logout_shape,
			handler: async (c, route) => {
				const ctx = require_request_context(c);
				const session_token: string | null = c.get(session_options.context_key) ?? null;
				if (session_token) {
					const token_hash = hash_session_token(session_token);
					await query_session_revoke_by_hash_unscoped(route, token_hash);
					// Handler-side belt+suspenders: eagerly close this account's
					// live WS connections BEFORE the audit emit so revocation
					// lands even if the audit INSERT fails. Account-wide (not
					// session-targeted) to match the Rust `account_logout` handler
					// and the sibling `/password` handler — logout is a
					// self-initiated account-grain operation, and the audit
					// listener (`create_ws_logout_closer`) runs the same
					// account-wide close on the logout event afterward, so both
					// layers converge (idempotent). Same transaction-commit trade
					// as `password` / RPC `session_revoke`: a throw between this
					// close and the response rolls back the DB revoke while
					// leaving sockets severed; benign (client reconnects), but
					// don't introduce a throw here without acknowledging the trade.
					if (connection_closer) {
						connection_closer.close_sockets_for_account(ctx.account.id);
					}
				}
				clear_session_cookie(c, session_options);
				// Account-grain operation — no `actor_id` (which actor was
				// resolved per-request is incidental to "this account ended
				// its session"). Mirrors `login`.
				deps.audit.emit(route, {
					event_type: 'logout',
					account_id: ctx.account.id,
					ip: get_client_ip(c)
				});
				return c.json({ ok: true, username: ctx.account.username });
			}
		},
		{
			...password_shape,
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
				const { current_password, new_password } = get_route_input<PasswordChangeInput>(c);
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
						metadata: { credential_type }
					});
					return c.json({ error: ERROR_INVALID_CREDENTIALS }, 401);
				}

				// Verify succeeded — do the throw-y operations FIRST so a fault
				// (Argon2 OOM, native binding error, DB outage on the UPDATE)
				// can't wipe the rate-limit history of a caller observing 500s.
				// Resets happen below, after both calls have settled.
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
					ctx.account.password_hash
				);

				// Verify-success contract — the caller proved knowledge, so wipe
				// their failure history. The race-loser branch below re-records
				// one on top of the wiped slate so net cost stays 1 (mirrors the
				// verify-fail branch above's `record`-from-prior+1 outcome when
				// prior was 0; for prior > 0 the race-loser pays exactly 1,
				// matching the OLD pre-S1 behavior). Deferring from "after
				// verify" to "after UPDATE settled" is what closes the S1
				// bypass — a throw between reset and the UPDATE could have
				// wiped an attacker's budget.
				if (ip_rate_limiter && ip) ip_rate_limiter.reset(ip);
				if (login_account_rate_limiter) login_account_rate_limiter.reset(ctx.account.id);

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
						metadata: { reason: 'concurrent_change', credential_type }
					});
					return c.json({ error: ERROR_INVALID_CREDENTIALS }, 401);
				}

				// revoke all sessions and API tokens (force re-auth everywhere)
				const sessions_revoked = await query_session_revoke_all_for_account(route, ctx.account.id);
				const tokens_revoked = await query_revoke_all_api_tokens_for_account(route, ctx.account.id);

				// Handler-side belt+suspenders — close every live WS socket on
				// this account BEFORE the audit emit so the revoke-all cascade
				// lands even if the audit INSERT fails. The real ordering
				// invariant is "before the transaction commits": this route
				// runs with the default `transaction: true`, so a throw between
				// this close and the response would roll back the password
				// update + session/token revokes while leaving sockets severed.
				// Benign — affected clients reconnect with their still-valid
				// session — but don't introduce a throw here without
				// acknowledging the trade. Listener-based close
				// (`transports_ws_auth_guard` on the `password_change` event)
				// runs the same close afterward; idempotent on the second pass.
				// Mirrors `zzz_server::account::password_inner`.
				if (connection_closer) {
					connection_closer.close_sockets_for_account(ctx.account.id);
				}
				clear_session_cookie(c, session_options);
				// Account-grain operation — no `actor_id`. The password is
				// account-level state; which per-request actor was resolved
				// has no semantic bearing on "this account changed its
				// password". Mirrors `login`/`logout`.
				deps.audit.emit(route, {
					event_type: 'password_change',
					account_id: ctx.account.id,
					ip: get_client_ip(c),
					metadata: { sessions_revoked, tokens_revoked, credential_type }
				});
				return c.json({ ok: true, sessions_revoked, tokens_revoked });
			}
		}
	];
};
