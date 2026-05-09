/**
 * Request context middleware and role_grant checking helpers.
 *
 * Two-phase identity resolution:
 *
 * 1. **Authentication (middleware)** — `create_request_context_middleware`,
 *    `bearer_auth`, and `daemon_token_middleware` validate the credential
 *    (session cookie, bearer token, daemon token) and set `c.var.account_id`
 *    + `c.var.credential_type` on the Hono context. They do not resolve
 *    an acting actor or load role_grants; `REQUEST_CONTEXT_KEY` stays null at
 *    this stage, so account-grain identity is the only thing known.
 * 2. **Authorization (route-spec wrapper / RPC dispatcher)** — after input
 *    validation, the per-route layer inspects the route. If the input
 *    schema declared `acting?: ActingActor` (reference equality with the
 *    canonical `ActingActor` schema) or the auth requires role_grants
 *    (`role` / `keeper`), `apply_authorization_phase` resolves the actor
 *    against `c.var.account_id` plus the validated `acting` value via
 *    `resolve_acting_actor`, builds the `{account, actor, role_grants}`
 *    context via `build_request_context`, and sets it on
 *    `REQUEST_CONTEXT_KEY` before auth guards fire. Authenticated routes
 *    that don't need an actor still get an account-only context via
 *    `build_account_context` so handler signatures stay uniform.
 *
 * Account-grain operations (logout, password_change, account_verify,
 * etc.) declare neither `acting` nor role_grant-requiring auth, so no actor
 * is resolved and their handlers see a `RequestContext` with
 * `actor: null` + empty `role_grants`. They never trigger `actor_required`,
 * which is what makes multi-actor logout work without first picking a
 * persona.
 *
 * `build_request_context` loads `account → actor → role_grants` and verifies
 * the `actor.account_id === account.id` binding. `refresh_role_grants`
 * reloads role_grants on an existing context.
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
	is_role_grant_active,
	type RoleGrant,
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
import {query_role_grant_find_active_for_actor} from './role_grant_queries.js';
import type {QueryDeps} from '../db/query_deps.js';
import {
	ACCOUNT_ID_KEY,
	AUTH_API_TOKEN_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	TEST_CONTEXT_PRESET_KEY,
	type CredentialType,
} from '../hono_context.js';
import type {RouteSpec} from '../http/route_spec.js';
import type {RouteAuth} from '../http/auth_shape.js';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
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
 * resolution. `role_grants` is empty in that case. Role grant checks
 * (`has_role`, `has_scoped_role`, `has_any_scoped_role`) are
 * null-tolerant on `RequestContext | null`; they additionally treat
 * `actor: null` as "no role_grants" so callers don't have to narrow.
 *
 * Multi-actor invariant: when populated, `actor.account_id === account.id`.
 * `build_request_context` enforces this; the dispatcher's authorization
 * phase rejects with `actor_not_on_account` before reaching the handler.
 */
export interface RequestContext {
	account: Account;
	actor: Actor | null;
	role_grants: Array<RoleGrant>;
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
 * Check if a request context has an active role_grant for a given role.
 *
 * Checks the role_grants already loaded in the context (no DB query).
 * Null-tolerant — `null` ctx (unauthenticated) returns `false`. Symmetric
 * with `has_scoped_role` / `has_any_scoped_role` so the three helpers
 * compose freely in the same predicate (e.g.
 * `has_role(auth, ADMIN) || has_scoped_role(auth, role, scope)`).
 *
 * @param ctx - the request context, or `null` for unauthenticated callers
 * @param role - the role to check
 * @param now - current time (defaults to `new Date()`, pass for testability and hot-path efficiency)
 * @returns `true` if the actor has an active role_grant for the role
 */
export const has_role = (
	ctx: RequestContext | null,
	role: string,
	now: Date = new Date(),
): boolean =>
	ctx?.role_grants.some((p) => p.role === role && is_role_grant_active(p, now)) ?? false;

/**
 * Whether the request context holds an active role_grant for `role` at `scope_id`.
 *
 * Walks the in-memory `ctx.role_grants` snapshot loaded once per request by
 * the route-spec / RPC dispatcher's authorization phase (when the route
 * declares `acting?: ActingActor` or has role_grant-requiring auth); zero DB
 * roundtrip per check. The "freshness" framing of a SQL re-query is
 * illusory because the race window is between predicate and the actual
 * mutation, not predicate and authorization load. Closing that race needs
 * a transactional re-check inside the UPDATE/INSERT, which neither style
 * provides.
 *
 * Null-tolerant — `null` ctx (unauthenticated) and account-grain
 * contexts (`actor: null`, empty `role_grants`) both return `false`. Same
 * convention as `has_role`; lets the helper drop into `auth: 'public'`
 * or account-grain handlers without a manual narrow. See `cell_authorize`
 * for the resource-side analog.
 *
 * `scope_id` semantics: in-memory `role_grant.scope_id` is `string | null`, so
 * JS `===` matches the SQL `IS NOT DISTINCT FROM` semantics exactly:
 *
 * - `scope_id === null` matches global role_grants (`scope_id IS NULL`).
 * - `scope_id === '<uuid>'` matches role_grants bound to that exact scope.
 *
 * @param ctx - the request context, or `null` for unauthenticated callers
 * @param role - the role to check
 * @param scope_id - the scope to check (`null` for global)
 * @param now - current time (defaults to `new Date()`, pass for testability and hot-path efficiency)
 * @returns `true` iff the actor holds an active role_grant for the role at the requested scope
 */
export const has_scoped_role = (
	ctx: RequestContext | null,
	role: string,
	scope_id: string | null,
	now: Date = new Date(),
): boolean => {
	if (!ctx) return false;
	return ctx.role_grants.some(
		(p) => p.role === role && p.scope_id === scope_id && is_role_grant_active(p, now),
	);
};

/**
 * Whether the request context holds an active role_grant for any role in `roles`
 * at `scope_id`. Empty `roles` short-circuits to `false` — documents intent
 * at the call site ("zero roles trivially admit no-one"). Same scope and
 * null-tolerance semantics as `has_scoped_role`.
 *
 * @param ctx - the request context, or `null` for unauthenticated callers
 * @param roles - the roles that would admit the caller (any-of)
 * @param scope_id - the scope to check (`null` for global)
 * @param now - current time (defaults to `new Date()`, pass for testability)
 * @returns `true` iff the actor holds an active role_grant for any role in `roles` at the requested scope
 */
export const has_any_scoped_role = (
	ctx: RequestContext | null,
	roles: ReadonlyArray<string>,
	scope_id: string | null,
	now: Date = new Date(),
): boolean => {
	if (!ctx) return false;
	if (roles.length === 0) return false;
	return ctx.role_grants.some(
		(p) => roles.includes(p.role) && p.scope_id === scope_id && is_role_grant_active(p, now),
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
 * Touches the session (fire-and-forget). Does not load actor or role_grants;
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
 * Create middleware that requires the actor to hold any of the given
 * roles globally (`scope_id IS NULL`).
 *
 * Returns 401 if unauthenticated, 403 if none of the roles are present.
 * Reads `REQUEST_CONTEXT_KEY` because role-gated routes always run the
 * dispatcher's authorization phase before this guard (the phase sets
 * the actor-bound `RequestContext`).
 *
 * Uses `has_any_scoped_role(ctx, roles, null)` so the gate matches
 * **global / unscoped role_grants only**. A scoped role_grant
 * (`{role: 'admin', scope_id: <some uuid>}`) does not unlock route-spec
 * gates that are inherently global. The same scope-aware check is
 * mirrored in `actions/action_rpc.ts` (HTTP RPC dispatcher) and
 * `actions/register_action_ws.ts` (WS dispatcher) so all three
 * transports agree.
 *
 * Multi-role disjunction (any-of) lets `auth.roles: ['admin', 'steward']`
 * specs translate to one middleware that admits either role. Single-role
 * routes pass `[role_name]`; the array shape is uniform.
 *
 * @param roles - the roles to admit (any-of)
 */
export const require_role = (roles: ReadonlyArray<string>): MiddlewareHandler => {
	return async (c, next): Promise<Response | void> => {
		if (c.get(ACCOUNT_ID_KEY) == null) {
			return c.json({error: ERROR_AUTHENTICATION_REQUIRED}, 401);
		}
		const ctx = get_request_context(c);
		if (!ctx || !has_any_scoped_role(ctx, roles, null)) {
			return c.json({error: ERROR_INSUFFICIENT_PERMISSIONS, required_roles: roles}, 403);
		}
		await next();
	};
};

/**
 * Create middleware that requires the request's `credential_type` to be
 * one of the given values.
 *
 * Returns 401 if unauthenticated, 403 if the credential type isn't in
 * the allowlist. Today's only credential gate is keeper (daemon_token),
 * so the 403 emits `ERROR_KEEPER_REQUIRES_DAEMON_TOKEN`-shaped bodies
 * for parity with the legacy `require_keeper` guard. Future credential
 * gates (agent_token, group_actor_token) will land alongside their own
 * error literal.
 *
 * @param credential_types - allowed credential types (any-of)
 */
export const require_credential_types = (
	credential_types: ReadonlyArray<string>,
): MiddlewareHandler => {
	return async (c, next): Promise<Response | void> => {
		if (c.get(ACCOUNT_ID_KEY) == null) {
			return c.json({error: ERROR_AUTHENTICATION_REQUIRED}, 401);
		}
		const credential_type: CredentialType | null = c.get(CREDENTIAL_TYPE_KEY) ?? null;
		if (!credential_type || !credential_types.includes(credential_type)) {
			return c.json(
				{
					error: ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
					credential_type: credential_type ?? 'none',
				},
				403,
			);
		}
		await next();
	};
};

/**
 * Reload active role_grants from the database, returning a new request context.
 *
 * Useful for long-lived WebSocket connections where role_grants may change
 * (grant or revoke) during the connection lifetime. Call periodically
 * or after receiving a revocation signal.
 *
 * Returns a new `RequestContext` with updated role_grants — the original
 * context is not mutated, making concurrent calls safe. Throws when
 * `ctx.actor` is null; account-grain contexts have no role_grants to refresh.
 *
 * @param ctx - the request context to refresh
 * @param deps - query dependencies
 * @returns a new `RequestContext` with fresh role_grants
 * @throws Error when called on an account-grain context (`actor: null`)
 */
export const refresh_role_grants = async (
	ctx: RequestContext,
	deps: QueryDeps,
): Promise<RequestContext> => {
	if (!ctx.actor) {
		throw new Error(
			'refresh_role_grants: account-grain context has no actor / role_grants to refresh',
		);
	}
	const role_grants = await query_role_grant_find_active_for_actor(deps, ctx.actor.id);
	return {...ctx, role_grants};
};

/**
 * Build a full `RequestContext` from an account id and an explicit
 * actor id (already resolved via `resolve_acting_actor`).
 *
 * Loads `account` + the named `actor` + the actor's active role_grants.
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

	const role_grants = await query_role_grant_find_active_for_actor(deps, actor.id);
	return {account, actor, role_grants};
};

/**
 * Build an account-only `RequestContext` (no actor, no role_grants) from
 * an account id.
 *
 * Used by the dispatcher's authorization phase for authenticated routes
 * that don't need an acting actor — account-grain operations (logout,
 * password change, account self-service). Lets handlers read
 * `auth.account.id` / `auth.account.username` uniformly with role_grant-bound
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
	return {account, actor: null, role_grants: []};
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
 * but registry-time invariant 2 from `TODO_AUTH_SHAPE.md` makes this
 * predicate authorization-correctness load-bearing for the dispatcher's
 * actor resolution.
 *
 * Used by `assert_route_auth_acting_biconditional` to enforce the
 * registry-time invariant `auth.actor !== 'none' ⟺ input declares
 * acting?: ActingActor` at every dispatcher registration site.
 */
export const input_schema_declares_acting = (schema: z.ZodType): boolean => {
	const obj = zod_unwrap_to_object(schema);
	if (!obj) return false;
	return (obj.shape as Record<string, z.ZodType | undefined>).acting === ActingActor;
};

/**
 * Registry-time biconditional check: `auth.actor !== 'none' ⟺ input
 * declares acting?: ActingActor`. Throws on violation.
 *
 * Invariant 2 from `TODO_AUTH_SHAPE.md` lives at registration time
 * (rather than on the `RouteAuth` Zod schema's `.superRefine`) because
 * it requires introspecting the spec's input schema for reference
 * equality with the canonical `ActingActor` schema — which lives in
 * `auth/account_schema.ts`, not in the framework `http/` layer.
 *
 * Called by every dispatcher registration loop (`apply_route_specs`
 * via the route-spec wrapper, `create_rpc_endpoint` directly,
 * `register_action_ws` directly) on every spec it accepts.
 *
 * @param auth - the route's auth shape
 * @param input - the route/action's input Zod schema
 * @param context - identifier for the throwing message (route key, RPC method, etc.)
 * @throws Error when the biconditional is violated
 */
export const assert_route_auth_acting_biconditional = (
	auth: RouteAuth,
	input: z.ZodType,
	context: string,
): void => {
	const wants_actor = auth.actor !== 'none';
	const declares_acting = input_schema_declares_acting(input);
	if (wants_actor && !declares_acting) {
		throw new Error(
			`${context}: auth.actor === '${auth.actor}' requires the input schema to declare 'acting?: ActingActor' (registry-time invariant 2)`,
		);
	}
	if (!wants_actor && declares_acting) {
		throw new Error(
			`${context}: input declares 'acting?: ActingActor' but auth.actor === 'none' (registry-time invariant 2)`,
		);
	}
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
 * Discriminated outcome of the authorization phase. Pure data — the auth
 * domain stops short of touching the Hono context or producing a `Response`
 * so HTTP RPC, WS, and REST each bind the same outcome to their wire shape.
 *
 * - `'public'` — both axes `'none'`; no resolution attempted. Public actions
 *   never see a `RequestContext`.
 * - `'unauthenticated'` — `'optional'` axis hit without an `account_id`.
 *   Handlers run with `RequestContext` left null. The pre-validation gate
 *   already rejected `'required'` callers, so this only happens on genuine
 *   anonymous access to an `'optional'` route.
 * - `'resolved'` — actor (or account-only) context built successfully.
 * - `'failure'` — 400/500 failure surfaced via `AuthorizationFailure`.
 */
export type AuthorizationOutcome =
	| {kind: 'public'}
	| {kind: 'unauthenticated'}
	| {kind: 'resolved'; request_context: RequestContext}
	| {kind: 'failure'; failure: AuthorizationFailure};

/**
 * Apply the dispatcher's authorization phase under the new flat-record
 * `RouteAuth` shape. Shared by the route-spec wrapper, the HTTP RPC
 * dispatcher, and the per-message WS dispatcher (Step 4 dispatcher
 * unification — post-Step-3 phase order: pre-validation 401 → input
 * validation 400 → authorization phase → post-authorization 403).
 *
 * Pure data — the function does not touch a Hono context. Each transport
 * passes `account_id` (extracted from its own credential surface) and
 * binds the returned `AuthorizationOutcome` to its wire shape. The REST
 * pipeline additionally writes `REQUEST_CONTEXT_KEY` on `c` for downstream
 * `require_role` / `require_credential_types` middleware that still reads
 * the resolved context off the Hono context.
 *
 * Branching by `auth.account` × `auth.actor`:
 *
 * - Both `'none'` → `'public'`. Public actions never see a `RequestContext`.
 * - `account_id == null` on any non-public route → `'unauthenticated'`. The
 *   `'required'` callers were already rejected at the pre-validation gate
 *   in the dispatcher; only genuine anonymous access on an `'optional'`
 *   axis lands here.
 * - `actor === 'none'` → builds account-only context via
 *   `build_account_context`. Null lookup → `account_vanished` 500.
 * - `actor === 'required'` → resolves the actor from `acting_value` (or
 *   single-actor account); failures map to 400 / 500.
 * - `actor === 'optional'` → same as `'required'` except multi-actor
 *   accounts without an `acting` value fall back to account-only context
 *   (no `actor_required` 400). Bad `acting` ids still 400.
 *
 * 500 branches stay distinct: `ERROR_NO_ACTORS_ON_ACCOUNT` (signup
 * invariant violation), `ERROR_ACCOUNT_VANISHED` (torn read after
 * resolve).
 */
export const apply_authorization_phase = async (
	deps: QueryDeps,
	account_id: string | null,
	auth: RouteAuth,
	acting_value: string | undefined,
): Promise<AuthorizationOutcome> => {
	if (auth.account === 'none' && auth.actor === 'none') return {kind: 'public'};

	if (account_id == null) {
		// Optional-auth route hit without a credential — leave `RequestContext`
		// null so the handler can branch on it. `'required'` callers already
		// got rejected at the pre-validation gate.
		return {kind: 'unauthenticated'};
	}

	if (auth.actor === 'none') {
		const ctx = await build_account_context(deps, account_id);
		if (!ctx)
			return {kind: 'failure', failure: {status: 500, body: {error: ERROR_ACCOUNT_VANISHED}}};
		return {kind: 'resolved', request_context: ctx};
	}

	// actor 'required' or 'optional' — resolve.
	const acting = await resolve_acting_actor(deps, account_id, acting_value);
	if (!acting.ok) {
		if (acting.reason === 'actor_required') {
			if (auth.actor === 'optional') {
				// Multi-actor account, no pick — fall back to account-only context.
				const ctx = await build_account_context(deps, account_id);
				if (!ctx) {
					return {
						kind: 'failure',
						failure: {status: 500, body: {error: ERROR_ACCOUNT_VANISHED}},
					};
				}
				return {kind: 'resolved', request_context: ctx};
			}
			return {
				kind: 'failure',
				failure: {
					status: 400,
					body: {error: ERROR_ACTOR_REQUIRED, available: acting.available},
				},
			};
		}
		if (acting.reason === 'actor_not_on_account') {
			return {
				kind: 'failure',
				failure: {status: 400, body: {error: ERROR_ACTOR_NOT_ON_ACCOUNT}},
			};
		}
		return {
			kind: 'failure',
			failure: {status: 500, body: {error: ERROR_NO_ACTORS_ON_ACCOUNT}},
		};
	}
	const ctx = await build_request_context(deps, account_id, acting.actor_id);
	if (!ctx) {
		return {kind: 'failure', failure: {status: 500, body: {error: ERROR_ACCOUNT_VANISHED}}};
	}
	return {kind: 'resolved', request_context: ctx};
};

/**
 * Create the route-spec authorization handler used by `apply_route_specs`.
 *
 * Reads `acting` off `c.var.validated_input` (or `c.var.validated_query`
 * for GET routes) — the post-Step-3 pipeline runs input validation first,
 * so the authorization phase consumes the typed Zod field instead of
 * pre-parsing the body. Public routes (`auth.account === 'none' &&
 * auth.actor === 'none'`) skip the phase entirely.
 *
 * Per registry-time invariant 2, `auth.actor !== 'none'` ⟺ the input
 * (or query) schema declares `acting?: ActingActor` — so reading from
 * `c.var.validated_input.acting` / `c.var.validated_query.acting` is
 * type-safe.
 *
 * Resolved contexts land on `REQUEST_CONTEXT_KEY` so the post-authorization
 * REST middleware (`require_role`, `require_credential_types`) reads the
 * actor-bound context off `c.var`. The HTTP RPC and WS dispatchers consume
 * the `apply_authorization_phase` outcome directly without round-tripping
 * through `c.var`.
 */
export const create_fuz_authorization_handler = (
	deps: QueryDeps,
): ((c: Context, spec: RouteSpec) => Promise<Response | void>) => {
	return async (c, spec) => {
		// Test escape hatch: harnesses that pre-populate `REQUEST_CONTEXT_KEY`
		// flag `TEST_CONTEXT_PRESET_KEY = true` so the authorization phase
		// trusts the supplied context instead of running DB-backed resolution.
		// Production middleware never sets this flag.
		if (c.get(TEST_CONTEXT_PRESET_KEY)) return;
		if (spec.auth.account === 'none' && spec.auth.actor === 'none') return;
		const acting_value = spec.auth.actor === 'none' ? undefined : extract_validated_acting(c);
		const account_id: string | null = c.get(ACCOUNT_ID_KEY) ?? null;
		const outcome = await apply_authorization_phase(deps, account_id, spec.auth, acting_value);
		if (outcome.kind === 'failure') {
			return c.json(outcome.failure.body, outcome.failure.status);
		}
		if (outcome.kind === 'resolved') {
			c.set(REQUEST_CONTEXT_KEY, outcome.request_context);
		}
		// 'public' / 'unauthenticated' — leave `REQUEST_CONTEXT_KEY` null;
		// downstream `require_role` / `require_credential_types` enforce.
		return;
	};
};

/**
 * Read `acting` off the validated input (or validated query) on the Hono
 * context. The Step 3 pipeline runs input/query validation before the
 * authorization phase, so this reads a typed Zod field — not the raw body.
 *
 * Returns `undefined` when `validated_input` / `validated_query` isn't
 * set or doesn't carry `acting`. Per registry-time invariant 2, the
 * dispatcher only calls this when `auth.actor !== 'none'`, which by
 * the biconditional means the input schema declares
 * `acting?: ActingActor`.
 */
const extract_validated_acting = (c: Context): string | undefined => {
	const validated_input = c.get('validated_input') as {acting?: unknown} | undefined;
	if (validated_input && typeof validated_input.acting === 'string') return validated_input.acting;
	const validated_query = c.get('validated_query') as {acting?: unknown} | undefined;
	if (validated_query && typeof validated_query.acting === 'string') return validated_query.acting;
	return undefined;
};
