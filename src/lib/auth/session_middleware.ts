/**
 * Hono session boundary — cookie I/O, request-time middleware, and the
 * session-creation helper shared by login / signup / bootstrap.
 *
 * The cookie is read from the request's `Cookie` lines by
 * `read_session_cookie_value` and written as the exact `Set-Cookie` strings of
 * `auth/session_cookie.ts` — no framework cookie parser or serializer sits on
 * the credential path, so nothing is percent-decoded on the way in or
 * percent-encoded on the way out.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from 'hono';

import type { Keyring } from './keyring.ts';
import { read_session_cookie_value } from './credential_headers.ts';
import {
	type SessionOptions,
	SESSION_AGE_MAX,
	format_session_clear_cookie,
	format_session_set_cookie,
	process_session_cookie
} from './session_cookie.ts';
import { create_capped_session, type CreateCappedSessionOptions } from './session_queries.ts';
import { SESSION_COOKIE_EXPIRES_AT_KEY, SESSION_TOKEN_KEY } from '../hono_context.ts';
import { get_header_lines } from '../http/header_lines.ts';

/**
 * Read the session cookie's value from a request, as sent
 * (`read_session_cookie_value` over the request's `Cookie` lines).
 *
 * @returns the value — `''` for a cookie sent with none — or `null` when the request carries no session cookie
 */
export const get_session_cookie = <T>(c: Context, options: SessionOptions<T>): string | null =>
	read_session_cookie_value(get_header_lines(c, 'Cookie'), options.cookie_name);

/**
 * Set the session cookie on a response — `format_session_set_cookie`'s string,
 * appended as a `Set-Cookie` line.
 *
 * `options.max_age` is the single source of truth for cookie lifetime: it
 * drives both the embedded `expires_at` (via `create_session_cookie_value`)
 * and the cookie's HTTP `Max-Age` attribute set here. Falls back to
 * `SESSION_AGE_MAX` when unset.
 *
 * @throws Error when the cookie name or the value is outside the RFC 6265 grammar (`format_session_set_cookie`)
 */
export const set_session_cookie = <T>(
	c: Context,
	value: string,
	options: SessionOptions<T>
): void => {
	c.header(
		'Set-Cookie',
		format_session_set_cookie(options.cookie_name, value, options.max_age ?? SESSION_AGE_MAX),
		{ append: true }
	);
};

/**
 * Clear the session cookie on a response — `format_session_clear_cookie`'s
 * string, appended as a `Set-Cookie` line.
 *
 * @throws Error when the cookie name is outside the RFC 6265 grammar
 */
export const clear_session_cookie = <T>(c: Context, options: SessionOptions<T>): void => {
	c.header('Set-Cookie', format_session_clear_cookie(options.cookie_name), { append: true });
};

/**
 * Create session middleware that parses cookies and sets the session token on
 * context.
 *
 * Always sets `SESSION_TOKEN_KEY` (null when invalid/missing) for type-safe
 * reads — the key the session leg (`create_request_context_middleware`)
 * reads. The identity is the session token, so the options are a
 * `SessionOptions<string>`.
 *
 * A cookie that is present and fails verification is cleared — an empty value
 * (`name=`) included; a request with no session cookie clears nothing. The
 * clear is a `Set-Cookie` line put on the context's headers before the
 * handler runs, whichever credential goes on to authenticate the request, so:
 *
 * - **A response the context builds carries it** — `c.json`, `c.text`,
 *   `c.body`, a stream, the not-found handler's answer, the error handler's
 *   (a thrown `HTTPException`'s own response is re-issued through the
 *   context), a refused WebSocket upgrade — once, ahead of every `Set-Cookie`
 *   the handler *appends*: a login carrying a stale cookie answers the clear,
 *   then the new cookie, and the browser keeps the new one.
 *   `set_session_cookie` and `clear_session_cookie` append. A handler that
 *   clears the cookie itself (on logout and password change) does so for a
 *   cookie that verified, which this middleware leaves alone, so such a
 *   response carries one clear.
 * - **A handler that sets `Set-Cookie` replaces it** —
 *   `c.header('Set-Cookie', v)` without `{append: true}`, or a `Set-Cookie`
 *   in the header record of `c.json(x, 200, {...})` / `c.body(x, 200, {...})`,
 *   sets the header rather than adding to it, and the response carries the
 *   handler's lines alone.
 * - **A response the handler built itself carries none** — `new Response(...)`,
 *   `Response.redirect(...)`, a fetched response passed through — and comes
 *   back exactly as the handler made it. The placeholder a runtime adapter
 *   answers an accepted WebSocket upgrade with is such a response, so an
 *   accepted upgrade carries none either.
 *
 * Where a response carries none, the stale cookie stays until the next
 * response under the same scope that does.
 *
 * The middleware never reads, changes, or rebuilds a response it did not
 * build, because none of that is neutral. A handler may return one object to
 * every request: a line written onto it is sent to every later caller, and a
 * rebuild takes its body, so on `@hono/node-server` the next request for it
 * without a stale cookie fails. Reading has effects of its own: on that
 * adapter reading `res.headers` alone changes the header lines it writes, a
 * response rebuilt around a body is sent chunked in place of its
 * `Content-Length`, and a bodiless status the handler gave an empty body is
 * refused; on Bun, reading a string body stops its `Content-Type` being
 * derived. A stale cookie would change what a route answers.
 *
 * A line on the context's headers is neutral in what a client reads, not byte
 * for byte: with it, `@hono/node-server` can write a response's header names
 * in another case and order, and Bun spells a bare `c.text`'s `Content-Type`
 * with a space. The status, the framing, the set of headers and the body are
 * the same.
 *
 * The context's headers reach a handler-built response in one case, which is
 * Hono's: when a layer reads `c.res` before the handler has answered, the
 * context holds a response of its own, and Hono rebuilds the handler's
 * response over it, with the context's `Set-Cookie` lines in place of the
 * handler's. No layer of the assembled server does that.
 *
 * The Rust spine's clear is a response layer: it reaches every response but
 * an accepted upgrade's `101`, ahead of whatever `Set-Cookie` lines the
 * handler wrote. So the two spines differ on a response the handler built
 * itself and on a context-built one whose handler set `Set-Cookie` — nowhere
 * else, and no spine route answers with either.
 *
 * The middleware runs where it is mounted — `AUTH_MIDDLEWARE_PATH` in the
 * assembled server — so the clear's scope is the router's reading of the
 * path: percent-decoded, dot segments resolved. The Rust spine's clear reads
 * the path as its own router does, raw, so the two differ on spellings a
 * browser never sends: `/%61pi/x` and `/./api/x` are cleared here and not
 * there, `/api/../health` there and not here. Left unconverged on purpose —
 * each spine clears exactly where its own router puts the auth scope.
 *
 * @param keyring - key ring for cookie verification
 * @param options - session configuration
 * @mutates Hono context - sets `SESSION_TOKEN_KEY` and `SESSION_COOKIE_EXPIRES_AT_KEY`, and may put the clearing `Set-Cookie` on the context's headers
 */
export const create_session_middleware = (
	keyring: Keyring,
	options: SessionOptions<string>
): MiddlewareHandler => {
	return async (c, next) => {
		const signed_value = get_session_cookie(c, options);
		const result = await process_session_cookie(signed_value, keyring, options);

		// Always set the token (null when invalid/missing) for type-safe reads
		c.set(SESSION_TOKEN_KEY, result.identity ?? null);
		// the signed expiry rides beside it, for the credential deadline
		c.set(SESSION_COOKIE_EXPIRES_AT_KEY, result.expires_at ?? null);

		// ahead of the handler, so it precedes any `Set-Cookie` the handler adds
		if (result.action === 'clear') clear_session_cookie(c, options);

		await next();
	};
};

/**
 * Options for `create_session_and_set_cookie`.
 */
export interface CreateSessionAndSetCookieOptions extends CreateCappedSessionOptions {
	/** Hono context for setting the cookie. */
	c: Context;
}

/**
 * Create an auth session and set the session cookie on the response —
 * `create_capped_session`, then `set_session_cookie`. Shared by login and
 * signup; bootstrap mints inside its own transaction and sets the cookie from
 * its success result.
 *
 * @returns the token hashes of the sessions the cap evicted, empty without a cap
 * @mutates `auth_session` table - inserts the new session row (and evicts older rows when `max_sessions` is set)
 */
export const create_session_and_set_cookie = async (
	options: CreateSessionAndSetCookieOptions
): Promise<Array<string>> => {
	const { c, ...mint } = options;
	const { cookie_value, evicted } = await create_capped_session(mint);
	set_session_cookie(c, cookie_value, options.session_options);
	return evicted;
};
