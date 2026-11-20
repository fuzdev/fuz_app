/**
 * Hono session boundary — the session cookie read off a request, and the
 * request-time middleware that resolves it and clears a stale one.
 *
 * The cookie is read from the request's `Cookie` lines by
 * `read_session_cookie_value` and written as the exact `Set-Cookie` strings of
 * `auth/session_cookie.ts` — no framework cookie parser or serializer sits on
 * the credential path, so nothing is percent-decoded on the way in or
 * percent-encoded on the way out. A route sets or clears the cookie by
 * returning the line on its success (`route_ok(value, {set_cookie})`, the
 * lines from `session_cookie_header` and `clear_session_cookie_header`), never
 * by writing on the context.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from 'hono';

import type { Keyring } from './keyring.ts';
import { read_session_cookie_value } from './credential_headers.ts';
import {
	type SessionOptions,
	format_session_clear_cookie,
	process_session_cookie
} from './session_cookie.ts';
import {
	EXPECTED_FIRST_SET_COOKIE_KEY,
	SESSION_COOKIE_EXPIRES_AT_KEY,
	SESSION_TOKEN_KEY
} from '../hono_context.ts';
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
 * handler runs, whichever credential goes on to authenticate the request, and
 * every response built through the context carries it once, ahead of any
 * other `Set-Cookie`:
 *
 * - **Every response a route spec answers** — a success, a failure, a raw
 *   answer of any body, an SSE stream — since `apply_route_specs` builds each
 *   through the context (`emit_route_response`) and a handler, which receives
 *   a `RouteContext` and never the Hono context, can neither return a
 *   `Response` of its own nor write a header on the one built. A success's own lines follow the clear: a login
 *   carrying a stale cookie answers the clear, then the new cookie, and the
 *   browser keeps the new one. A logout or password change clears a cookie
 *   that verified, which this middleware leaves alone, so its response
 *   carries one clear.
 * - **Every refusal of the middleware behind this one** — the auth gates, the
 *   input checks, the error catch's 500, the not-found handler's answer, the
 *   error handler's (a thrown `HTTPException`'s own response is re-issued
 *   through the context), a refused WebSocket upgrade.
 *
 * What carries none is what is built outside the context: a response a
 * consumer's own middleware (a `transform_middleware` layer, a
 * `post_route_middleware`) or a raw Hono route builds by hand —
 * `new Response(...)`, `Response.redirect(...)`, a fetched response passed
 * through — and the placeholder a runtime adapter answers an accepted
 * WebSocket upgrade with — unless a layer read `c.res` before it answered,
 * when Hono rebuilds such a response over the context's own, the context's
 * `Set-Cookie` lines in place of its. Where a response carries none, the
 * stale cookie stays until the next response under the same scope that does.
 * The clear is recorded on the context (`EXPECTED_FIRST_SET_COOKIE_KEY`), and
 * in DEV a response that does not lead with it is logged
 * (`create_dev_set_cookie_check`) — all but an accepted upgrade's
 * placeholder, which the check knows by its shape, a bodiless `200` to an
 * `Upgrade: websocket` request, since no adapter hands Hono a `101`.
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
 * The Rust spine's clear is a response layer: it reaches every response but
 * an accepted upgrade's `101`, ahead of whatever `Set-Cookie` lines the
 * handler wrote. So the two spines differ only on responses built outside the
 * context above — none of which a spine route answers with.
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
 * @mutates Hono context - sets `SESSION_TOKEN_KEY` and `SESSION_COOKIE_EXPIRES_AT_KEY`, and may put the clearing `Set-Cookie` on the context's headers, recording it under `EXPECTED_FIRST_SET_COOKIE_KEY`
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

		// ahead of the handler, so it precedes any `Set-Cookie` a success carries;
		// recorded, so the DEV `Set-Cookie` check can see a response that lost it
		if (result.action === 'clear') {
			const clear = format_session_clear_cookie(options.cookie_name);
			c.header('Set-Cookie', clear, { append: true });
			c.set(EXPECTED_FIRST_SET_COOKIE_KEY, clear);
		}

		await next();
	};
};
