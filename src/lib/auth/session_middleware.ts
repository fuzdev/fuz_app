/**
 * Hono session middleware using generic session management.
 *
 * Thin wrapper that gets/sets cookies and delegates to session processing.
 *
 * @module
 */

import type {Context, MiddlewareHandler} from 'hono';
import {getCookie, setCookie, deleteCookie} from 'hono/cookie';

import type {Keyring} from './keyring.js';
import {
	type SessionOptions,
	type SessionCookieOptions,
	SESSION_COOKIE_OPTIONS,
	process_session_cookie,
} from './session_cookie.js';

/**
 * Read the session cookie value from a request.
 */
export const get_session_cookie = <T>(
	c: Context,
	options: SessionOptions<T>,
): string | undefined => {
	return getCookie(c, options.cookie_name);
};

/**
 * Set the session cookie on a response.
 */
export const set_session_cookie = <T>(
	c: Context,
	value: string,
	options: SessionOptions<T>,
): void => {
	const cookie_options: SessionCookieOptions = {
		...SESSION_COOKIE_OPTIONS,
		...options.cookie_options,
	};
	if (options.max_age !== undefined) {
		cookie_options.maxAge = options.max_age;
	}
	setCookie(c, options.cookie_name, value, cookie_options);
};

/**
 * Clear the session cookie on a response.
 */
export const clear_session_cookie = <T>(c: Context, options: SessionOptions<T>): void => {
	const cookie_options: SessionCookieOptions = {
		...SESSION_COOKIE_OPTIONS,
		...options.cookie_options,
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
 */
export const create_session_middleware = <TIdentity>(
	keyring: Keyring,
	options: SessionOptions<TIdentity>,
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
