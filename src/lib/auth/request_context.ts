/**
 * Request context middleware and permit checking helpers.
 *
 * Two-phase identity resolution:
 *
 * 1. **Authentication (middleware)** — `create_request_context_middleware`,
 *    `bearer_auth`, and `daemon_token_middleware` validate the credential
 *    (session cookie, bearer token, daemon token) and set `c.var.account_id`
 *    + `c.var.credential_type` on the Hono context. They do not resolve
 *    an acting actor or load permits; `REQUEST_CONTEXT_KEY` stays null at
 *    this stage, so account-grain identity is the only thing known.
 * 2. **Authorization (route-spec wrapper / RPC dispatcher)** — after input
 *    validation, the per-route layer inspects the route. If the input
 *    schema declared `acting?: ActingActor` (reference equality with the
 *    canonical `ActingActor` schema) or the auth requires permits
 *    (`role` / `keeper`), `apply_authorization_phase` resolves the actor
 *    against `c.var.account_id` plus the validated `acting` value via
 *    `resolve_acting_actor`, builds the `{account, actor, permits}`
 *    context via `build_request_context`, and sets it on
 *    `REQUEST_CONTEXT_KEY` before auth guards fire. Authenticated routes
 *    that don't need an actor still get an account-only context via
 *    `build_account_context` so handler signatures stay uniform.
 *
 * Account-grain operations (logout, password_change, account_verify,
 * etc.) declare neither `acting` nor permit-requiring auth, so no actor
 * is resolved and their handlers see a `RequestContext` with
 * `actor: null` + empty `permits`. They never trigger `actor_required`,
 * which is what makes multi-actor logout work without first picking a
 * persona.
 *
 * `build_request_context` loads `account → actor → permits` and verifies
 * the `actor.account_id === account.id` binding. `refresh_permits`
 * reloads permits on an existing context.
 *
 * @module
 */

import type {Context, MiddlewareHandler} from 'hono';
import {z} from 'zod';
import type {Logger} from '@fuzdev/fuz_util/log.js';
import {zod_unwrap_to_object} from '@fuzdev/fuz_util/zod.js';

import {
	ActingActor,
	type Account,
	type Actor,
	is_permit_active,
	type Permit,
} from './account_schema.js';
import {
	hash_session_token,
	session_touch_fire_and_forget,
	query_session_get_valid,
} from './session_queries.js';
import {
	query_account_by_id,
	query_actor_by_id,
	query_actors_by_account,
} from './account_queries.js';
import {query_permit_find_active_for_actor} from './permit_queries.js';
import type {QueryDeps} from '../db/query_deps.js';
import {
	ACCOUNT_ID_KEY,
	AUTH_API_TOKEN_ID_KEY,
	CACHED_REQUEST_BODY_KEY,
	CREDENTIAL_TYPE_KEY,
	TEST_CONTEXT_PRESET_KEY,
} from '../hono_context.js';
import type {ActionAuth} from '../actions/action_spec.js';
import type {RouteAuth, RouteSpec} from '../http/route_spec.js';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_ACTOR_REQUIRED,
	ERROR_ACTOR_NOT_ON_ACCOUNT,
	ERROR_NO_ACTORS_ON_ACCOUNT,
	ERROR_ACCOUNT_VANISHED,
} from '../http/error_schemas.js';

/**
 * The resolved identity context for an authenticated request.
 *
 * `actor` is null on account-grain routes (no `acting` field on input,
 * no `role` / `keeper` auth) — those handlers don't trigger actor
 * resolution. `permits` is empty in that case. Permit checks
 * (`has_role`, `has_scoped_role`, `has_any_scoped_role`) are
 * null-tolerant on `RequestContext | null`; they additionally treat
 * `actor: null` as "no permits" so callers don't have to narrow.
 *
 * Multi-actor invariant: when populated, `actor.account_id === account.id`.
 * `build_request_context` enforces this; the dispatcher's authorization
 * phase rejects with `actor_not_on_account` before reaching the handler.
 */
export interface RequestContext {
	account: Account;
	actor: Actor | null;
	permits: Array<Permit>;
}

/** Hono context variable name for the request context. */
export const REQUEST_CONTEXT_KEY = 'request_context';

/**
 * Hono context variable name for the authenticated session token hash.
 *
 * Set by `create_request_context_middleware` after a successful session lookup.
 * `null` when the request is unauthenticated or authenticated via a non-session
 * credential (bearer token, daemon token). Exposed so handlers can scope
 * per-session resources (e.g., SSE stream identity for targeted disconnection
 * on `session_revoke`) without re-hashing the token.
 */
export const AUTH_SESSION_TOKEN_HASH_KEY = 'auth_session_token_hash';

/**
 * Get the request context from a Hono context, or `null` if unauthenticated.
 *
 * @param c - the Hono context
 * @returns the request context, or `null`
 */
export const get_request_context = (c: Context): RequestContext | null => {
	return (c.get(REQUEST_CONTEXT_KEY) as RequestContext | undefined) ?? null;
};

/**
 * Get the request context, throwing if unauthenticated.
 *
 * Use in route handlers where the dispatcher's authorization phase guarantees
 * a context exists (i.e., routes with `auth: {type: 'authenticated'}` or
 * stricter). Prefer this over `get_request_context(c)!` for explicit error
 * handling.
 *
 * @param c - the Hono context
 * @returns the request context (never null)
 * @throws Error if no request context is set (dispatcher misconfiguration)
 */
export const require_request_context = (c: Context): RequestContext => {
	const ctx = get_request_context(c);
	if (!ctx) {
		throw new Error(
			'require_request_context: no request context — is the dispatcher authorization phase wired?',
		);
	}
	return ctx;
};

/**
 * Request context narrowed to a resolved acting actor.
 *
 * Returned by `require_request_actor` for handlers whose route resolves
 * an actor — actions with `auth: 'keeper' | {role}` or with input that
 * declares `acting?: ActingActor`. Lets handlers drop the `auth.actor!`
 * non-null assertion that was masking the dispatcher invariant.
 */
export interface RequestActorContext extends RequestContext {
	actor: Actor;
}

/**
 * Narrow `RequestContext | null` to a non-null context (auth invariant).
 *
 * Use in RPC action handlers whose spec is non-public — the dispatcher's
 * pre-validation auth gate has already short-circuited unauthenticated
 * callers, so `ctx.auth` is non-null by the time the handler runs.
 *
 * @throws Error when called from a public-auth handler (programmer error)
 */
export const require_request_auth = (auth: RequestContext | null): RequestContext => {
	if (!auth) {
		throw new Error(
			'require_request_auth: no auth — is this handler bound to a non-public action spec?',
		);
	}
	return auth;
};

/**
 * Narrow `RequestContext | null` to `RequestActorContext` (actor invariant).
 *
 * Use in RPC action handlers whose spec declares `auth: 'keeper' | {role}`
 * or whose input declares `acting?: ActingActor` — the dispatcher's
 * authorization phase resolves an actor before the handler runs. Replaces
 * the `ctx.auth!.actor!.id` chain that the type system can't otherwise see.
 *
 * @throws Error when the handler runs without actor resolution (programmer error)
 */
export const require_request_actor = (auth: RequestContext | null): RequestActorContext => {
	const ctx = require_request_auth(auth);
	if (!ctx.actor) {
		throw new Error(
			'require_request_actor: no actor — is this handler bound to an actor-implying spec (keeper/role) or one whose input declares `acting`?',
		);
	}
	return ctx as RequestActorContext;
};

/**
 * Check if a request context has an active permit for a given role.
 *
 * Checks the permits already loaded in the context (no DB query).
 * Null-tolerant — `null` ctx (unauthenticated) returns `false`. Symmetric
 * with `has_scoped_role` / `has_any_scoped_role` so the three helpers
 * compose freely in the same predicate (e.g.
 * `has_role(auth, ADMIN) || has_scoped_role(auth, role, scope)`).
 *
 * @param ctx - the request context, or `null` for unauthenticated callers
 * @param role - the role to check
 * @param now - current time (defaults to `new Date()`, pass for testability and hot-path efficiency)
 * @returns `true` if the actor has an active permit for the role
 */
export const has_role = (
	ctx: RequestContext | null,
	role: string,
	now: Date = new Date(),
): boolean => ctx?.permits.some((p) => p.role === role && is_permit_active(p, now)) ?? false;

/**
 * Whether the request context holds an active permit for `role` at `scope_id`.
 *
 * Walks the in-memory `ctx.permits` snapshot loaded once per request by
 * the route-spec / RPC dispatcher's authorization phase (when the route
 * declares `acting?: ActingActor` or has permit-requiring auth); zero DB
 * roundtrip per check. The "freshness" framing of a SQL re-query is
 * illusory because the race window is between predicate and the actual
 * mutation, not predicate and authorization load. Closing that race needs
 * a transactional re-check inside the UPDATE/INSERT, which neither style
 * provides.
 *
 * Null-tolerant — `null` ctx (unauthenticated) and account-grain
 * contexts (`actor: null`, empty `permits`) both return `false`. Same
 * convention as `has_role`; lets the helper drop into `auth: 'public'`
 * or account-grain handlers without a manual narrow. See `cell_authorize`
 * for the resource-side analog.
 *
 * `scope_id` semantics: in-memory `permit.scope_id` is `string | null`, so
 * JS `===` matches the SQL `IS NOT DISTINCT FROM` semantics exactly:
 *
 * - `scope_id === null` matches global permits (`scope_id IS NULL`).
 * - `scope_id === '<uuid>'` matches permits bound to that exact scope.
 *
 * @param ctx - the request context, or `null` for unauthenticated callers
 * @param role - the role to check
 * @param scope_id - the scope to check (`null` for global)
 * @param now - current time (defaults to `new Date()`, pass for testability and hot-path efficiency)
 * @returns `true` iff the actor holds an active permit for the role at the requested scope
 */
export const has_scoped_role = (
	ctx: RequestContext | null,
	role: string,
	scope_id: string | null,
	now: Date = new Date(),
): boolean => {
	if (!ctx) return false;
	return ctx.permits.some(
		(p) => p.role === role && p.scope_id === scope_id && is_permit_active(p, now),
	);
};

/**
 * Whether the request context holds an active permit for any role in `roles`
 * at `scope_id`. Empty `roles` short-circuits to `false` — documents intent
 * at the call site ("zero roles trivially admit no-one"). Same scope and
 * null-tolerance semantics as `has_scoped_role`.
 *
 * @param ctx - the request context, or `null` for unauthenticated callers
 * @param roles - the roles that would admit the caller (any-of)
 * @param scope_id - the scope to check (`null` for global)
 * @param now - current time (defaults to `new Date()`, pass for testability)
 * @returns `true` iff the actor holds an active permit for any role in `roles` at the requested scope
 */
export const has_any_scoped_role = (
	ctx: RequestContext | null,
	roles: ReadonlyArray<string>,
	scope_id: string | null,
	now: Date = new Date(),
): boolean => {
	if (!ctx) return false;
	if (roles.length === 0) return false;
	return ctx.permits.some(
		(p) => roles.includes(p.role) && p.scope_id === scope_id && is_permit_active(p, now),
	);
};

/**
 * Result of `resolve_acting_actor` — either an actor id or a structured
 * error the caller maps to an HTTP response.
 */
export type ResolveActingActorResult =
	| {ok: true; actor_id: string}
	| {ok: false; reason: 'no_actors'}
	| {ok: false; reason: 'actor_required'; available: Array<{id: string; name: string}>}
	| {ok: false; reason: 'actor_not_on_account'};

/**
 * Resolve the acting actor for an authenticated request.
 *
 * Called from the route-spec / RPC dispatcher's authorization phase
 * with the authenticated account id and the validated `acting` value
 * (from the request payload). Applies the uniform resolution rules:
 *
 * - `acting_actor_id` omitted + 1 actor → use it.
 * - `acting_actor_id` omitted + 0 actors → `no_actors` (defensive —
 *   signup / bootstrap always create an actor in the same tx, so this
 *   is a server error).
 * - `acting_actor_id` omitted + multiple actors → `actor_required` with
 *   the available list so the client can prompt; never pick silently.
 * - `acting_actor_id` present + matches an actor on the account → use it.
 * - `acting_actor_id` present + does not match → `actor_not_on_account`.
 *   The available list is intentionally not echoed in this branch (treat
 *   as opaque rejection).
 *
 * @param deps - query dependencies
 * @param account_id - the authenticated account
 * @param acting_actor_id - the requested acting actor id, or `undefined`
 */
export const resolve_acting_actor = async (
	deps: QueryDeps,
	account_id: string,
	acting_actor_id: string | undefined,
): Promise<ResolveActingActorResult> => {
	const actors = await query_actors_by_account(deps, account_id);
	if (actors.length === 0) return {ok: false, reason: 'no_actors'};
	if (acting_actor_id == null) {
		if (actors.length === 1) return {ok: true, actor_id: actors[0]!.id};
		return {
			ok: false,
			reason: 'actor_required',
			available: actors.map((a) => ({id: a.id, name: a.name})),
		};
	}
	const match = actors.find((a) => a.id === acting_actor_id);
	if (!match) return {ok: false, reason: 'actor_not_on_account'};
	return {ok: true, actor_id: match.id};
};

/**
 * Create middleware that authenticates the account from a session cookie.
 *
 * Reads the session identity (set by session middleware), looks up the
 * `auth_session`, and on a valid session sets `c.var.auth_account_id`,
 * `CREDENTIAL_TYPE_KEY = 'session'`, and `AUTH_SESSION_TOKEN_HASH_KEY`.
 * Touches the session (fire-and-forget). Does not load actor or permits;
 * `REQUEST_CONTEXT_KEY` is left null — the route-spec / RPC dispatcher
 * authorization phase resolves the acting actor and builds the full
 * `RequestContext` when the route needs one.
 *
 * Invalid / missing session leaves all keys null and calls `next()` —
 * `require_auth` / `require_role` enforce.
 *
 * @param deps - query dependencies (pool-level db for middleware)
 * @param log - the logger instance
 * @param session_context_key - the Hono context key where session middleware stored the session token
 * @mutates Hono context - sets `ACCOUNT_ID_KEY`, `CREDENTIAL_TYPE_KEY`, `AUTH_SESSION_TOKEN_HASH_KEY`, and `AUTH_API_TOKEN_ID_KEY`
 */
export const create_request_context_middleware = (
	deps: QueryDeps,
	log: Logger,
	session_context_key = 'auth_session_id',
): MiddlewareHandler => {
	return async (c, next): Promise<Response | void> => {
		c.set(REQUEST_CONTEXT_KEY, null);
		c.set(ACCOUNT_ID_KEY, null);
		c.set(CREDENTIAL_TYPE_KEY, null);
		c.set(AUTH_SESSION_TOKEN_HASH_KEY, null);
		c.set(AUTH_API_TOKEN_ID_KEY, null);

		const session_token: string | null = c.get(session_context_key) ?? null;
		if (!session_token) {
			await next();
			return;
		}

		const token_hash = hash_session_token(session_token);
		const session = await query_session_get_valid(deps, token_hash);
		if (!session) {
			await next();
			return;
		}

		c.set(ACCOUNT_ID_KEY, session.account_id);
		c.set(CREDENTIAL_TYPE_KEY, 'session');
		c.set(AUTH_SESSION_TOKEN_HASH_KEY, token_hash);

		// Touch session (fire-and-forget, don't block the request)
		void session_touch_fire_and_forget(deps, token_hash, c.var.pending_effects, log);

		await next();
	};
};

/**
 * Middleware that requires authentication.
 *
 * Returns 401 if the auth middleware did not set `c.var.auth_account_id`.
 */
export const require_auth: MiddlewareHandler = async (c, next): Promise<Response | void> => {
	if (c.get(ACCOUNT_ID_KEY) == null) {
		return c.json({error: ERROR_AUTHENTICATION_REQUIRED}, 401);
	}
	await next();
};

/**
 * Create middleware that requires a specific role.
 *
 * Returns 401 if unauthenticated, 403 if the role is missing. Reads
 * `REQUEST_CONTEXT_KEY` because role-gated routes always run the
 * dispatcher's authorization phase before this guard (the phase sets the
 * actor-bound `RequestContext`).
 *
 * @param role - the required role
 */
export const require_role = (role: string): MiddlewareHandler => {
	return async (c, next): Promise<Response | void> => {
		if (c.get(ACCOUNT_ID_KEY) == null) {
			return c.json({error: ERROR_AUTHENTICATION_REQUIRED}, 401);
		}
		const ctx = get_request_context(c);
		if (!ctx || !has_role(ctx, role)) {
			return c.json({error: ERROR_INSUFFICIENT_PERMISSIONS, required_role: role}, 403);
		}
		await next();
	};
};

/**
 * Reload active permits from the database, returning a new request context.
 *
 * Useful for long-lived WebSocket connections where permits may change
 * (grant or revoke) during the connection lifetime. Call periodically
 * or after receiving a revocation signal.
 *
 * Returns a new `RequestContext` with updated permits — the original
 * context is not mutated, making concurrent calls safe. Throws when
 * `ctx.actor` is null; account-grain contexts have no permits to refresh.
 *
 * @param ctx - the request context to refresh
 * @param deps - query dependencies
 * @returns a new `RequestContext` with fresh permits
 * @throws Error when called on an account-grain context (`actor: null`)
 */
export const refresh_permits = async (
	ctx: RequestContext,
	deps: QueryDeps,
): Promise<RequestContext> => {
	if (!ctx.actor) {
		throw new Error('refresh_permits: account-grain context has no actor / permits to refresh');
	}
	const permits = await query_permit_find_active_for_actor(deps, ctx.actor.id);
	return {...ctx, permits};
};

/**
 * Build a full `RequestContext` from an account id and an explicit
 * actor id (already resolved via `resolve_acting_actor`).
 *
 * Loads `account` + the named `actor` + the actor's active permits.
 * Verifies the `actor.account_id === account.id` binding so downstream
 * handlers can trust `ctx.actor.account_id === ctx.account.id`. Returns
 * `null` when the account is missing, the actor is missing, or the
 * actor doesn't belong to the supplied account.
 *
 * Called by the route-spec / RPC dispatcher's authorization phase for
 * routes that need an acting actor; account-grain routes use
 * `build_account_context` instead.
 *
 * @param deps - query dependencies
 * @param account_id - the account to build context for
 * @param actor_id - the actor this request acts as
 * @returns a request context, or `null` if account/actor not found or mismatched
 */
export const build_request_context = async (
	deps: QueryDeps,
	account_id: string,
	actor_id: string,
): Promise<RequestActorContext | null> => {
	const account = await query_account_by_id(deps, account_id);
	if (!account) return null;

	const actor = await query_actor_by_id(deps, actor_id);
	if (!actor) return null;
	if (actor.account_id !== account.id) return null;

	const permits = await query_permit_find_active_for_actor(deps, actor.id);
	return {account, actor, permits};
};

/**
 * Build an account-only `RequestContext` (no actor, no permits) from
 * an account id.
 *
 * Used by the dispatcher's authorization phase for authenticated routes
 * that don't need an acting actor — account-grain operations (logout,
 * password change, account self-service). Lets handlers read
 * `auth.account.id` / `auth.account.username` uniformly with permit-bound
 * routes; the cost is one extra `query_account_by_id` per request.
 *
 * Returns `null` when the account row is missing (e.g. deleted between
 * the auth middleware's session lookup and the dispatcher) — caller
 * surfaces that as a 500 since it represents a torn read.
 *
 * @param deps - query dependencies
 * @param account_id - the account to build context for
 * @returns an account-only request context, or `null` if the account is missing
 */
export const build_account_context = async (
	deps: QueryDeps,
	account_id: string,
): Promise<RequestContext | null> => {
	const account = await query_account_by_id(deps, account_id);
	if (!account) return null;
	return {account, actor: null, permits: []};
};

/**
 * Whether the supplied auth descriptor implies an acting actor must be
 * resolved (i.e., permit-requiring auth: `'role'` or `'keeper'`).
 *
 * The dispatcher's authorization phase uses this to decide whether to
 * walk the actor list when the input schema doesn't already declare
 * `acting?: ActingActor`. Accepts either auth shape — the route-spec
 * `RouteAuth` (`{type: 'role' | 'keeper' | ...}`) or the action-spec
 * `ActionAuth` (`'keeper' | {role}`) — so HTTP and RPC dispatchers share
 * one source of truth for the "permit-bound" rule.
 */
export const is_actor_implying_auth = (auth: RouteAuth | ActionAuth): boolean => {
	if (typeof auth === 'string') return auth === 'keeper';
	if ('type' in auth) return auth.type === 'role' || auth.type === 'keeper';
	return 'role' in auth;
};

/**
 * Whether an input schema declares the canonical `acting?: ActingActor`
 * field. Reference-equality on the exported `ActingActor` schema —
 * consumer schemas with unrelated `acting` fields don't trip this check.
 *
 * Peels through Zod wrappers (`optional`, `nullable`, `default`,
 * `transform`, `pipe`, `prefault`) via `zod_unwrap_to_object` so a spec
 * authored as `z.optional(z.strictObject({acting: ActingActor}))` or
 * `z.strictObject({acting: ActingActor}).default({})` still trips the
 * predicate. The wrapper-tolerant lookup is defense-in-depth — the
 * canonical shape is the un-wrapped `z.strictObject({acting: ActingActor})`,
 * but variant B in `~/dev/grimoire/lore/fuz_app/TODO_PUBLIC_AUTH_PHASE.md`
 * makes this predicate authorization-correctness load-bearing for
 * `auth: 'public'` actions, so missing a wrapper-bound declaration
 * would silently skip actor resolution. The reference-equality check
 * on `ActingActor` keeps consumer schemas with unrelated `acting`
 * fields from tripping the predicate even after the wrapper peel.
 *
 * The dispatcher's authorization phase uses this to decide whether to
 * pull the actor id from validated input (so multi-actor users can pick
 * a persona on actor-needing routes).
 */
export const input_schema_declares_acting = (schema: z.ZodType): boolean => {
	const obj = zod_unwrap_to_object(schema);
	if (!obj) return false;
	return (obj.shape as Record<string, z.ZodType | undefined>).acting === ActingActor;
};

/**
 * Resolution-failure shape returned by `apply_authorization_phase`. Each
 * transport binds this to the appropriate wire shape — REST emits the body
 * directly via `c.json(body, status)`; the RPC dispatcher folds it into a
 * JSON-RPC error envelope `{jsonrpc, id, error: {code, message, data}}`.
 *
 * The auth phase deliberately stops short of constructing a `Response` so
 * the same failure flows through every transport without the auth-domain
 * code knowing about JSON-RPC. See `fuz_app/CLAUDE.md` § Cleanest
 * architecture takes priority for the rationale.
 */
export type AuthorizationFailureBody =
	| {error: typeof ERROR_ACTOR_REQUIRED; available: Array<{id: string; name: string}>}
	| {error: typeof ERROR_ACTOR_NOT_ON_ACCOUNT}
	| {error: typeof ERROR_NO_ACTORS_ON_ACCOUNT}
	| {error: typeof ERROR_ACCOUNT_VANISHED};

/**
 * A `(status, body)` pair the caller binds to a transport-shaped response.
 * `status` is narrowed to the two values the auth phase emits — Hono's
 * `c.json` status overload accepts the literals directly, and downstream
 * binders avoid casts they would otherwise need against a `number`.
 */
export interface AuthorizationFailure {
	status: 400 | 500;
	body: AuthorizationFailureBody;
}

/**
 * Apply the dispatcher's authorization phase. Shared by the route-spec
 * wrapper and the RPC dispatcher.
 *
 * - When `c.var.auth_account_id` is `null`, returns `void` so the
 *   downstream auth guard can fire 401 (less-helpful than `actor_required`
 *   for the unauthenticated case).
 * - When `needs_actor` is true, resolves the actor against the account
 *   plus the supplied `acting` value, then builds the full
 *   `{account, actor, permits}` context.
 * - When `needs_actor` is false, builds an account-only context so
 *   handler signatures stay uniform across the surface.
 *
 * On resolution failure returns an `AuthorizationFailure` (`{status, body}`)
 * the caller wraps in a transport-appropriate response. Three 500 branches
 * are kept distinct so the wire shape names what actually went wrong:
 *
 * - 500 `ERROR_NO_ACTORS_ON_ACCOUNT` — `resolve_acting_actor` returned
 *   `no_actors`. The actor enumeration succeeded and came back empty;
 *   signup / bootstrap should have created one in the same transaction,
 *   so this is a real corruption signal.
 * - 500 `ERROR_ACCOUNT_VANISHED` — `build_request_context` /
 *   `build_account_context` returned null after a successful
 *   `resolve_acting_actor`. The account or actor row was deleted between
 *   the credential check and authorization (torn read race), or — in
 *   the `build_request_context` actor↔account mismatch sub-branch — the
 *   binding flipped under us. Reachability of the mismatch sub-branch in
 *   production is essentially zero (`resolve_acting_actor` already
 *   verified the actor was on this account, and `actor.account_id` only
 *   changes via row-level edits no production path makes), so collapsing
 *   that case into the torn-read shape costs nothing.
 *
 * Other failure paths: 400 `ERROR_ACTOR_REQUIRED` / `ERROR_ACTOR_NOT_ON_ACCOUNT`.
 * Returns `undefined` on success.
 *
 * @mutates Hono context - sets `REQUEST_CONTEXT_KEY` on success
 */
export const apply_authorization_phase = async (
	deps: QueryDeps,
	c: Context,
	needs_actor: boolean,
	acting_value: string | undefined,
): Promise<AuthorizationFailure | void> => {
	// Test escape hatch: when a harness pre-populates `REQUEST_CONTEXT_KEY`
	// it must also flag `TEST_CONTEXT_PRESET_KEY = true` (set by
	// `create_test_app_from_specs` / `create_fake_hono_context` / per-test
	// middleware). Production middleware never sets this flag, so future
	// production code that consults `REQUEST_CONTEXT_KEY` cannot silently
	// bypass the live build the way an implicit presence probe would.
	if (c.get(TEST_CONTEXT_PRESET_KEY)) return;
	const account_id: string | null = c.get(ACCOUNT_ID_KEY) ?? null;
	if (account_id == null) return; // auth guard handles 401

	if (needs_actor) {
		const acting = await resolve_acting_actor(deps, account_id, acting_value);
		if (!acting.ok) {
			if (acting.reason === 'actor_required') {
				return {
					status: 400,
					body: {error: ERROR_ACTOR_REQUIRED, available: acting.available},
				};
			}
			if (acting.reason === 'actor_not_on_account') {
				return {status: 400, body: {error: ERROR_ACTOR_NOT_ON_ACCOUNT}};
			}
			return {status: 500, body: {error: ERROR_NO_ACTORS_ON_ACCOUNT}};
		}
		const ctx = await build_request_context(deps, account_id, acting.actor_id);
		if (!ctx) return {status: 500, body: {error: ERROR_ACCOUNT_VANISHED}};
		c.set(REQUEST_CONTEXT_KEY, ctx);
		return;
	}

	const ctx = await build_account_context(deps, account_id);
	if (!ctx) return {status: 500, body: {error: ERROR_ACCOUNT_VANISHED}};
	c.set(REQUEST_CONTEXT_KEY, ctx);
};

/**
 * Create the route-spec authorization handler used by `apply_route_specs`.
 *
 * Decides whether the route needs actor resolution from `spec.auth` plus
 * `spec.input` introspection, extracts the raw `acting` value (string
 * typeguard, no schema validation), and delegates to
 * `apply_authorization_phase`. Public routes (`auth.type === 'none'`) skip
 * the phase entirely; their handlers see no `RequestContext`.
 *
 * Authorization runs before input validation (matches the RPC dispatcher's
 * order). For GET routes `acting` comes from the URL query string; for
 * mutating methods it comes from a pre-parse of the JSON body. The pre-
 * parse result lands on `c.var.cached_request_body` so the subsequent
 * `create_input_validation` step reads the parsed value from there
 * without re-running `JSON.parse` — explicit cache, independent of
 * Hono's internal `bodyCache` behavior. A malformed body fails the
 * pre-parse silently (`acting` treated as undefined, cache flagged
 * `{ok: false}`) and is then rejected with `ERROR_INVALID_JSON_BODY`
 * by the input-validation step that reads the failure flag — producing
 * the same final response as if the validation step had parsed first.
 */
export const create_fuz_authorization_handler = (
	deps: QueryDeps,
): ((c: Context, spec: RouteSpec) => Promise<Response | void>) => {
	return async (c, spec) => {
		if (spec.auth.type === 'none') return;
		const declares_acting = input_schema_declares_acting(spec.input);
		const needs_actor = is_actor_implying_auth(spec.auth) || declares_acting;
		let acting_value: string | undefined;
		if (declares_acting) {
			const raw_acting = await read_raw_acting(c, spec.method);
			acting_value = typeof raw_acting === 'string' ? raw_acting : undefined;
		}
		const failure = await apply_authorization_phase(deps, c, needs_actor, acting_value);
		if (!failure) return;
		return c.json(failure.body, failure.status);
	};
};

/**
 * Extract the raw `acting` value from a request before input validation
 * has run. Returns `undefined` on parse failure or non-object body; the
 * downstream input-validation step then rejects malformed bodies with
 * `ERROR_INVALID_JSON_BODY`.
 *
 * Writes the parse result to `c.var.cached_request_body` so the
 * input-validation step does not re-run `JSON.parse` on the same Hono-
 * cached body text. Hono's internal `bodyCache` keeps the body text
 * alive across multiple `c.req.json()` calls, but each call still
 * re-parses — caching the parsed value here decouples our pipeline
 * from that undocumented detail (and saves the second parse).
 *
 * Three cache states:
 *
 * - GET (early return) — no cache write; the input-validation step is
 *   a no-op for GET so nothing reads the cache anyway.
 * - Successful parse (any JSON value) — `{ok: true, body}`. The
 *   input-validation step reads `body` and runs the non-object check
 *   itself.
 * - Parse failure — `{ok: false}`. The input-validation step short-
 *   circuits with `ERROR_INVALID_JSON_BODY` without re-parsing.
 */
const read_raw_acting = async (c: Context, method: string): Promise<unknown> => {
	if (method === 'GET') return c.req.query('acting');
	try {
		const body = await c.req.json();
		c.set(CACHED_REQUEST_BODY_KEY, {ok: true, body});
		if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
			return (body as {acting?: unknown}).acting;
		}
	} catch {
		c.set(CACHED_REQUEST_BODY_KEY, {ok: false});
	}
	return undefined;
};
