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
	get_public_account_id,
	get_request_context,
	require_request_context,
	resolve_acting_actor
} from './request_context.ts';
import { CREDENTIAL_TYPE_KEY } from '../hono_context.ts';
import { get_route_input, type RouteSpec } from '../http/route_spec.ts';
import { get_client_ip } from '../http/client_ip.ts';
import { rate_limit_ip_key } from '../http/ip_canonical.ts';
import { parse_acting } from '../http/auth_shape.ts';
import {
	rate_limit_exceeded_response,
	reserve_optional,
	type RateLimiter,
	type RateLimitReservation
} from '../rate_limiter.ts';
import type { RouteFactoryDeps } from './deps.ts';
import {
	close_connections_after_commit,
	queue_connection_close
} from '../actions/connection_closer.ts';
import { ERROR_AUTHENTICATION_REQUIRED, ERROR_INVALID_CREDENTIALS } from '../http/error_schemas.ts';

/**
 * Create the account status route spec.
 *
 * Handles both authenticated and unauthenticated requests:
 * - Authenticated: returns `{account}` with 200
 * - Unauthenticated: returns 401 with optional `bootstrap_available` flag
 *
 * A scope-narrowed API token is answered as the unauthenticated caller, byte
 * for byte. A narrowed token reaches no non-RPC surface
 * (`token_scope_admits_non_rpc`), and this one hands out the account's email,
 * its verification state, and the acting actor's role grants; the route
 * already answers anonymous callers, so that answer is the refusal — a 403
 * would tell the holder nothing that dropping the header doesn't. The handler
 * reads the credential through `get_public_account_id`, which applies it.
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
		// a narrowed token is the anonymous caller here, never a refusal
		const account_id = get_public_account_id(c);
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
		// surface a persona picker. The selector goes through the `ActingActor`
		// schema, lowercased; a malformed value is a missing persona —
		// account-only, never a default-actor resolve (as on the Rust spine).
		const acting_raw = c.req.query('acting');
		const acting = parse_acting(acting_raw);
		const acting_result =
			acting_raw !== undefined && acting === undefined
				? null
				: await resolve_acting_actor(route, account_id, acting);
		if (acting_result?.ok) {
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
 * Shared options for route factories that create sessions.
 *
 * Extended by `AccountRouteOptions` and `SignupRouteOptions`.
 * Consumers can destructure these from `AppServerContext` once and spread into multiple factories.
 *
 * The per-IP limiter is deliberately *not* here. Each auth surface names its
 * own (`login_ip_rate_limiter`, `signup_ip_rate_limiter`,
 * `bootstrap_ip_rate_limiter`) because the buckets are monotone within their
 * window — see `RateLimiter.reset`. A shared base field made one instance the
 * path of least resistance, which let a failure on any surface spend the
 * budget that bounds guessing on every other one.
 */
export interface AuthSessionRouteOptions {
	session_options: SessionOptions<string>;
}

/**
 * Per-factory configuration for account route specs.
 */
export interface AccountRouteOptions extends AuthSessionRouteOptions {
	/**
	 * Rate limiter for login + password-change attempts, keyed by client IP.
	 * Pass `null` to disable. The distributed-spray backstop: login is the one
	 * surface that guesses *other* accounts' credentials, so this bucket is
	 * never refunded on success (see `RateLimiter.reset`). Password change
	 * shares it — it is password-bearing on the same account grain, and the
	 * Rust spine shares the same instance across both.
	 */
	login_ip_rate_limiter: RateLimiter | null;
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
 * `/login` closes the connections of the sessions its cap evicts, and
 * `/logout` and `/password` close the account's, each once its revocation has
 * committed: `/logout` through the route transaction's post-commit queue
 * (`queue_connection_close`), `/login` and `/password` — which open their own
 * transaction around just their writes — straight after it commits
 * (`close_connections_after_commit`, which logs a failing close rather than
 * failing the committed request), so a later throw can't drop a close a
 * committed revocation owes. All on `deps.connection_closer`.
 *
 * @param deps - stateless capabilities (keyring, password, log, audit, connection_closer)
 * @param options - per-factory configuration (session_options, login_ip_rate_limiter, login_account_rate_limiter, bootstrap_status)
 * @returns route specs (not yet applied to Hono)
 */
export const create_account_route_specs = (
	deps: RouteFactoryDeps,
	options: AccountRouteOptions
): Array<RouteSpec> => {
	const { keyring, password, connection_closer } = deps;
	const {
		session_options,
		login_ip_rate_limiter,
		login_account_rate_limiter,
		max_sessions = DEFAULT_MAX_SESSIONS,
		login_fail_floor_ms = DEFAULT_LOGIN_FAIL_FLOOR_MS,
		login_fail_jitter_ms = DEFAULT_LOGIN_FAIL_JITTER_MS,
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
				// Per-IP rate limit (before any DB/password work). Reserved, not
				// checked: the attempt counts against the cap from here until it
				// settles, so a concurrent burst can't all pass before any of it
				// records. A key at its cap only because of attempts in flight
				// waits briefly for a slot (`RESERVATION_WAIT_MAX_MS`) rather than
				// refusing a burst of correct logins outright. Order: IP, then the
				// lookup, then the account (its key is the looked-up id). A wait on
				// the account bucket keeps the IP slot: it belongs to the same
				// address, the wait is bounded, and giving it up would let that
				// address exceed its cap meanwhile. The `finally` releases whatever
				// no branch recorded.
				// keyed by the address's rate-limit key (an IPv6 client's /64)
				const ip_key = login_ip_rate_limiter ? rate_limit_ip_key(get_client_ip(c)) : null;
				const ip_reserved = await reserve_optional(login_ip_rate_limiter, ip_key, {
					signal: c.req.raw.signal
				});
				if (!ip_reserved.ok) {
					return rate_limit_exceeded_response(c, ip_reserved.retry_after);
				}
				let account_reservation: RateLimitReservation | null = null;
				try {
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

					// Per-account rate limit (after DB lookup so the key is canonical)
					const account_reserved = await reserve_optional(
						login_account_rate_limiter,
						account_rate_key,
						{ signal: c.req.raw.signal }
					);
					if (!account_reserved.ok) {
						return rate_limit_exceeded_response(c, account_reserved.retry_after);
					}
					account_reservation = account_reserved.reservation;

					// Start the minimum-delay timer concurrently with failure work.
					// Observed response time is max(work, delay) so all 401 paths
					// (found-wrong-pw, not-found) return in similar time.
					const delay = login_fail_delay(login_fail_floor_ms, login_fail_jitter_ms);

					if (!account) {
						// enumeration prevention: verify_dummy equalizes Argon2id timing;
						// login_fail_delay equalizes every other path difference.
						await password.verify_dummy(pw);
						ip_reserved.reservation.record();
						account_reservation?.record();
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
						ip_reserved.reservation.record();
						account_reservation?.record();
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

					// Successful login — clear the account-grain failure history only.
					// The IP aggregate is deliberately left standing: it is the
					// distributed-spray backstop, so a success on one account must not
					// refund the budget shared by every other account reachable from
					// that address. See `RateLimiter.reset`. A success records nothing:
					// both reservations are released.
					ip_reserved.reservation.release();
					account_reservation?.release();
					if (login_account_rate_limiter) login_account_rate_limiter.reset(account_rate_key);

					// The session INSERT and the cap eviction are the route's only
					// writes, and only atomic together: one transaction around just
					// them (the route is `transaction: false`, so the reservation
					// waits above and the Argon2 verify held no connection). Twin of
					// the Rust login's transaction around `create_capped_session`.
					const evicted = await route.db.transaction((tx) =>
						create_session_and_set_cookie({
							keyring,
							deps: { db: tx },
							c,
							account_id: account.id,
							session_options,
							max_sessions
						})
					);
					// The sessions the cap evicted are gone from the table, but not
					// from the connections they opened — a WebSocket keeps the
					// authority it resolved at upgrade, and an SSE stream never
					// rechecks. Close them now the eviction has committed — inline, not
					// queued: with no route transaction, a throw later in the handler
					// would drop a queued close while the eviction stands. No audit
					// row: there is no eviction event, and the `login` row records
					// the cause.
					for (const session_hash of evicted) {
						close_connections_after_commit(
							connection_closer,
							{ kind: 'session', session_hash },
							deps.log
						);
					}
					deps.audit.emit(route, {
						event_type: 'login',
						account_id: account.id,
						ip: get_client_ip(c)
					});
					return c.json({ ok: true });
				} finally {
					ip_reserved.reservation.release();
					account_reservation?.release();
				}
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
					// Close this account's live connections once the revoke has
					// committed — queued, so it never runs before the commit or on
					// rollback, and it does not depend on the fail-open audit write
					// below. Account-wide (not session-targeted) to match the Rust
					// `account_logout` handler and the sibling `/password` handler
					// — logout is a self-initiated account-grain operation. The
					// audit listeners repeat the same close on the announced
					// `logout` row; closing is idempotent.
					queue_connection_close(route, connection_closer, {
						kind: 'account',
						account_id: ctx.account.id
					});
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
				// Per-IP rate limit (before argon2 work). Reserved, not checked:
				// the attempt counts against the shared login limiters from here
				// until it settles, so a concurrent burst of guesses at
				// `current_password` can't all pass before any of it records. The
				// `finally` releases whatever no branch recorded.
				// keyed by the address's rate-limit key (an IPv6 client's /64)
				const ip_key = login_ip_rate_limiter ? rate_limit_ip_key(get_client_ip(c)) : null;
				const ip_reserved = await reserve_optional(login_ip_rate_limiter, ip_key, {
					signal: c.req.raw.signal
				});
				if (!ip_reserved.ok) {
					return rate_limit_exceeded_response(c, ip_reserved.retry_after);
				}
				let account_reservation: RateLimitReservation | null = null;
				try {
					const ctx = require_request_context(c);
					const { current_password, new_password } = get_route_input<PasswordChangeInput>(c);
					// Defense in depth — see `docs/security.md` §Credential-channel gating.
					const credential_type = c.get(CREDENTIAL_TYPE_KEY) ?? undefined;

					// per-account rate limit (after context resolution, before argon2 work)
					const account_reserved = await reserve_optional(
						login_account_rate_limiter,
						ctx.account.id,
						{ signal: c.req.raw.signal }
					);
					if (!account_reserved.ok) {
						return rate_limit_exceeded_response(c, account_reserved.retry_after);
					}
					account_reservation = account_reserved.reservation;

					const valid = await password.verify_password(current_password, ctx.account.password_hash);
					if (!valid) {
						ip_reserved.reservation.record();
						account_reservation?.record();
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
					//
					// The UPDATE and the two revocations are the route's writes, and
					// commit together or not at all: one transaction around just them
					// (the route is `transaction: false`, so the reservation waits
					// above and the Argon2 verify and hash held no connection). Twin of
					// the Rust spine's `change_password`. `null` when the UPDATE matched
					// nothing — a concurrent change committed first.
					const change = await route.db.transaction(async (tx) => {
						const tx_deps = { db: tx };
						const updated = await query_update_account_password(
							tx_deps,
							ctx.account.id,
							new_hash,
							null,
							ctx.account.password_hash
						);
						if (!updated) return null;
						// revoke all sessions and API tokens (force re-auth everywhere)
						const sessions_revoked = await query_session_revoke_all_for_account(
							tx_deps,
							ctx.account.id
						);
						const tokens_revoked = await query_revoke_all_api_tokens_for_account(
							tx_deps,
							ctx.account.id
						);
						return { sessions_revoked, tokens_revoked };
					});

					// Verify-success contract — the caller proved knowledge, so wipe
					// their account-grain failure history. The race-loser branch below
					// re-records one on top of the wiped slate so net cost stays 1 on
					// that bucket. Deferring from "after verify" to "after UPDATE
					// settled" is what closes the S1 bypass — a throw between reset
					// and the UPDATE could have wiped an attacker's budget.
					//
					// The IP aggregate is deliberately not cleared: it is the same
					// instance login uses, so refunding it here reopens the spray path
					// through a route that only needs the caller's *own* password. Its
					// record on the race-loser branch below therefore accumulates
					// rather than netting out, which is the intent.
					if (login_account_rate_limiter) login_account_rate_limiter.reset(ctx.account.id);

					if (!change) {
						// A concurrent password change committed first — our
						// `current_password` was correct at read-time but the row's
						// `password_hash` no longer matches. Mirrors the wrong-password
						// 401 shape; tag the failure metadata so admins reading the
						// audit log can distinguish "user typoed" from "two clients
						// raced." Sessions/tokens were already revoked by the winner;
						// no cookie clear here either.
						ip_reserved.reservation.record();
						account_reservation?.record();
						deps.audit.emit(route, {
							event_type: 'password_change',
							outcome: 'failure',
							account_id: ctx.account.id,
							ip: get_client_ip(c),
							metadata: { reason: 'concurrent_change', credential_type }
						});
						return c.json({ error: ERROR_INVALID_CREDENTIALS }, 401);
					}

					const { sessions_revoked, tokens_revoked } = change;

					// Close every live connection of this account now the password
					// update and the revoke-all cascade have committed — inline, not
					// queued: with no route transaction, a throw later in the handler
					// would drop a queued close while the revocation stands. It does
					// not depend on the fail-open audit write below; the audit
					// listeners repeat it on the announced `password_change` row.
					close_connections_after_commit(
						connection_closer,
						{ kind: 'account', account_id: ctx.account.id },
						deps.log
					);
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
				} finally {
					ip_reserved.reservation.release();
					account_reservation?.release();
				}
			}
		}
	];
};
