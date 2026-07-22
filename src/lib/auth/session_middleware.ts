/**
 * Hono session boundary — cookie I/O, request-time middleware, and the
 * session-creation helper shared by login / signup / bootstrap.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

import type { Keyring } from './keyring.ts';
import {
	type SessionOptions,
	type SessionCookieOptions,
	session_cookie_options,
	process_session_cookie,
	create_session_cookie_value
} from './session_cookie.ts';
import {
	generate_session_token,
	hash_session_token,
	AUTH_SESSION_LIFETIME_MS,
	query_create_session,
	query_session_enforce_limit
} from './session_queries.ts';
import type { QueryDeps } from '../db/query_deps.ts';

/**
 * Read the session cookie value from a request.
 */
export const get_session_cookie = <T>(
	c: Context,
	options: SessionOptions<T>
): string | undefined => {
	return getCookie(c, options.cookie_name);
};

/**
 * Set the session cookie on a response.
 *
 * `options.max_age` is the single source of truth for cookie lifetime: it
 * drives both the embedded `expires_at` (via `create_session_cookie_value`)
 * and the cookie's HTTP `Max-Age` attribute set here. Falls back to
 * `session_cookie_options.maxAge` (= `SESSION_AGE_MAX`) when unset.
 * `options.cookie_options` cannot carry `maxAge` (omitted in the type) so
 * the two values can't drift.
 */
export const set_session_cookie = <T>(
	c: Context,
	value: string,
	options: SessionOptions<T>
): void => {
	const cookie_options: SessionCookieOptions = {
		...session_cookie_options,
		...options.cookie_options,
		maxAge: options.max_age ?? session_cookie_options.maxAge
	};
	setCookie(c, options.cookie_name, value, cookie_options);
};

/**
 * Clear the session cookie on a response.
 */
export const clear_session_cookie = <T>(c: Context, options: SessionOptions<T>): void => {
	const cookie_options: SessionCookieOptions = {
		...session_cookie_options,
		...options.cookie_options
	};
	deleteCookie(c, options.cookie_name, cookie_options);
};

/**
 * Create session middleware that parses cookies and sets identity on context.
 *
 * Always sets the identity on context (null when invalid/missing) for type-safe reads.
 * Uses `options.context_key` as the Hono context variable name.
 *
 * @param keyring - key ring for cookie verification
 * @param options - session configuration
 * @mutates Hono context - sets `options.context_key` and may refresh or clear the session cookie
 */
export const create_session_middleware = <TIdentity>(
	keyring: Keyring,
	options: SessionOptions<TIdentity>
): MiddlewareHandler => {
	return async (c, next) => {
		const signed_value = get_session_cookie(c, options);
		const result = await process_session_cookie(signed_value, keyring, options);

		// Always set identity (null when invalid/missing) for type-safe reads
		c.set(options.context_key, result.identity ?? null);

		if (result.action === 'clear') {
			clear_session_cookie(c, options);
		} else if (result.action === 'refresh' && result.new_signed_value) {
			set_session_cookie(c, result.new_signed_value, options);
		}

		await next();
	};
};

/**
 * Options for `create_session_and_set_cookie`.
 */
export interface CreateSessionAndSetCookieOptions {
	/** Keyring for cookie signing. */
	keyring: Keyring;
	/** Query deps (needs db for session creation). */
	deps: QueryDeps;
	/** Hono context for setting the cookie. */
	c: Context;
	/** The account to create a session for. */
	account_id: string;
	/** Session cookie configuration. */
	session_options: SessionOptions<string>;
	/** Per-account session cap (`null` to skip enforcement). */
	max_sessions?: number | null;
}

/**
 * Create an auth session and set the session cookie on the response.
 *
 * Shared by login, signup, and bootstrap — generates a token, hashes it,
 * persists the session row, optionally enforces a per-account session limit,
 * and sets the signed cookie.
 *
 * @mutates `auth_session` table - inserts the new session row (and evicts older rows when `max_sessions` is set)
 */
export const create_session_and_set_cookie = async (
	options: CreateSessionAndSetCookieOptions
): Promise<void> => {
	const { keyring, deps, c, account_id, session_options, max_sessions } = options;
	const session_token = generate_session_token();
	const token_hash = hash_session_token(session_token);
	const expires_at = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
	await query_create_session(deps, token_hash, account_id, expires_at);

	if (max_sessions != null) {
		await query_session_enforce_limit(deps, account_id, max_sessions);
	}

	const cookie_value = await create_session_cookie_value(keyring, session_token, session_options);
	set_session_cookie(c, cookie_value, session_options);
};
