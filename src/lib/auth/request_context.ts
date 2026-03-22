/**
 * Request context middleware and permit checking helpers.
 *
 * Builds `{ account, actor, permits }` from a session cookie
 * for every authenticated request. Downstream handlers check
 * permits, never flags.
 *
 * `build_request_context` is the shared helper used by session,
 * bearer, and daemon token middleware to resolve account → actor → permits.
 * `refresh_permits` reloads permits on an existing context.
 *
 * @module
 */

import type {Context, MiddlewareHandler} from 'hono';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import {type Account, type Actor, is_permit_active, type Permit} from './account_schema.js';
import {
	hash_session_token,
	session_touch_fire_and_forget,
	query_session_get_valid,
} from './session_queries.js';
import {query_actor_by_account, query_account_by_id} from './account_queries.js';
import {query_permit_find_active_for_actor} from './permit_queries.js';
import type {QueryDeps} from '../db/query_deps.js';
import {CREDENTIAL_TYPE_KEY} from '../hono_context.js';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
} from '../http/error_schemas.js';

/** The resolved identity context for an authenticated request. */
export interface RequestContext {
	account: Account;
	actor: Actor;
	permits: Array<Permit>;
}

/** Hono context variable name for the request context. */
export const REQUEST_CONTEXT_KEY = 'request_context';

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
 * Use in route handlers where auth middleware guarantees a context exists
 * (i.e., routes with `auth: {type: 'authenticated'}` or stricter).
 * Prefer this over `get_request_context(c)!` for explicit error handling.
 *
 * @param c - the Hono context
 * @returns the request context (never null)
 * @throws Error if no request context is set (middleware misconfiguration)
 */
export const require_request_context = (c: Context): RequestContext => {
	const ctx = get_request_context(c);
	if (!ctx) {
		throw new Error('require_request_context: no request context — is auth middleware applied?');
	}
	return ctx;
};

/**
 * Check if a request context has an active permit for a given role.
 *
 * Checks the permits already loaded in the context (no DB query).
 *
 * @param ctx - the request context
 * @param role - the role to check
 * @param now - current time (defaults to `new Date()`, pass for testability and hot-path efficiency)
 * @returns `true` if the actor has an active permit for the role
 */
export const has_role = (ctx: RequestContext, role: string, now: Date = new Date()): boolean =>
	ctx.permits.some((p) => p.role === role && is_permit_active(p, now));

/**
 * Create middleware that builds the request context from a session cookie.
 *
 * Reads the session identity (set by session middleware), looks up
 * the `auth_session`, loads account + actor + active permits, and
 * sets the `RequestContext` on the Hono context.
 *
 * If the session is invalid or the account is not found, the context
 * is set to `null` (unauthenticated). No 401 is returned — use
 * `require_role` or `require_auth` for enforcement.
 *
 * @param deps - query dependencies (pool-level db for middleware)
 * @param log - the logger instance
 * @param session_context_key - the Hono context key where session middleware stored the session token
 */
export const create_request_context_middleware = (
	deps: QueryDeps,
	log: Logger,
	session_context_key = 'auth_session_id',
): MiddlewareHandler => {
	return async (c, next) => {
		const session_token: string | null = c.get(session_context_key) ?? null;

		if (!session_token) {
			c.set(REQUEST_CONTEXT_KEY, null);
			c.set(CREDENTIAL_TYPE_KEY, null);
			await next();
			return;
		}

		const token_hash = hash_session_token(session_token);
		const session = await query_session_get_valid(deps, token_hash);

		if (!session) {
			c.set(REQUEST_CONTEXT_KEY, null);
			c.set(CREDENTIAL_TYPE_KEY, null);
			await next();
			return;
		}

		const ctx = await build_request_context(deps, session.account_id);
		if (!ctx) {
			c.set(REQUEST_CONTEXT_KEY, null);
			c.set(CREDENTIAL_TYPE_KEY, null);
			await next();
			return;
		}

		c.set(REQUEST_CONTEXT_KEY, ctx);
		c.set(CREDENTIAL_TYPE_KEY, 'session');

		// Touch session (fire-and-forget, don't block the request)
		void session_touch_fire_and_forget(deps, token_hash, c.var.pending_effects, log);

		await next();
	};
};

/**
 * Middleware that requires authentication.
 *
 * Returns 401 if no request context is set.
 */
export const require_auth: MiddlewareHandler = async (c, next): Promise<Response | void> => {
	const ctx = get_request_context(c);
	if (!ctx) {
		return c.json({error: ERROR_AUTHENTICATION_REQUIRED}, 401);
	}
	await next();
};

/**
 * Create middleware that requires a specific role.
 *
 * Returns 401 if unauthenticated, 403 if the role is missing.
 *
 * @param role - the required role
 */
export const require_role = (role: string): MiddlewareHandler => {
	return async (c, next): Promise<Response | void> => {
		const ctx = get_request_context(c);
		if (!ctx) {
			return c.json({error: ERROR_AUTHENTICATION_REQUIRED}, 401);
		}
		if (!has_role(ctx, role)) {
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
 * context is not mutated, making concurrent calls safe.
 *
 * @param ctx - the request context to refresh
 * @param deps - query dependencies
 * @returns a new `RequestContext` with fresh permits
 */
export const refresh_permits = async (
	ctx: RequestContext,
	deps: QueryDeps,
): Promise<RequestContext> => {
	const permits = await query_permit_find_active_for_actor(deps, ctx.actor.id);
	return {...ctx, permits};
};

/**
 * Build a full `RequestContext` from an account id.
 *
 * Shared helper used by session, bearer, and daemon token middleware,
 * as well as WebSocket upgrade handlers. Does the account → actor → permits
 * lookup pipeline and returns the composed context, or `null` if
 * the account or actor is not found.
 *
 * @param deps - query dependencies
 * @param account_id - the account to build context for
 * @returns a request context, or `null` if account/actor not found
 */
export const build_request_context = async (
	deps: QueryDeps,
	account_id: string,
): Promise<RequestContext | null> => {
	const account = await query_account_by_id(deps, account_id);
	if (!account) return null;

	const actor = await query_actor_by_account(deps, account.id);
	if (!actor) return null;

	const permits = await query_permit_find_active_for_actor(deps, actor.id);
	return {account, actor, permits};
};
