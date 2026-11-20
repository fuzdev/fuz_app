/**
 * Refusing CORS simple requests — the cross-origin POSTs a browser sends
 * without asking first.
 *
 * A cross-origin `fetch` or form `POST` skips the CORS preflight when its
 * `Content-Type` is absent or one of the three CORS-safelisted types
 * (`text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`).
 * The browser sends such a request as-is, with whatever cookies apply — only
 * the response is withheld from the page. Any other content type makes the
 * browser send an `OPTIONS` preflight first, and since fuz_app answers no
 * preflight with CORS headers, the real request is never sent.
 *
 * The session cookie's `SameSite=Strict` doesn't close this on its own:
 * same-site ignores the port, so a page on `http://localhost:8000` is
 * same-site with a server on `http://localhost:4460` and its requests carry
 * the cookie. The origin allowlist (`http/origin.ts`) refuses such a page
 * unless a wildcard (`http://localhost:*`) admits it; this gate refuses it
 * whatever the allowlist says.
 *
 * So every `POST` route carries a content-type check, run first by
 * `apply_route_specs` (`is_post_content_type_refused`, 415
 * `unsupported_content_type`): a JSON route takes only `application/json`,
 * bodyless or not, and a `raw_body` route takes any well-formed type that
 * isn't safelisted. Both read the `Content-Type` lines the client sent through
 * `read_content_type` (`http/request_headers.ts`), so a second line, or an
 * empty one, is refused on every runtime. Only `POST` needs it: `PUT`, `PATCH`, and `DELETE` are never
 * simple methods, so the browser always preflights them.
 *
 * The check rests on the server answering no preflight. A consumer that adds
 * CORS middleware granting cross-origin requests reopens what this closes.
 *
 * Twin of the Rust spine's `fuz_http::simple_request`: the same predicates,
 * `is_json_content_type` checked in each spine JSON handler and
 * `is_cors_simple_content_type` by the `simple_request_layer` consumers mount
 * over routes with other bodies.
 *
 * @module
 */

import type { HeaderRead } from './request_headers.ts';

/** The content types a browser sends cross-origin without a preflight. */
const CORS_SAFELISTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
	'text/plain',
	'application/x-www-form-urlencoded',
	'multipart/form-data'
]);

/**
 * True when a browser could have sent a `POST` with this `Content-Type`
 * cross-origin without a preflight: none, or a CORS-safelisted one.
 *
 * A malformed `Content-Type` (`read_content_type` refuses it — two lines, an
 * empty one, an essence off the grammar, a byte outside header text) counts
 * as simple too: a browser would refuse to call some of those safelisted, so
 * this only ever refuses too much, never too little.
 *
 * @param content_type - the request's `Content-Type`, as `read_content_type` read it
 */
export const is_cors_simple_content_type = (content_type: HeaderRead<string>): boolean =>
	content_type.kind !== 'one' || CORS_SAFELISTED_CONTENT_TYPES.has(content_type.value);

/**
 * True when `Content-Type` is exactly one well-formed line whose essence is
 * `application/json` (any parameters, such as `charset`, allowed).
 *
 * @param content_type - the request's `Content-Type`, as `read_content_type` read it
 */
export const is_json_content_type = (content_type: HeaderRead<string>): boolean =>
	content_type.kind === 'one' && content_type.value === 'application/json';

/**
 * True when a `POST` route refuses this `Content-Type`: a JSON route anything
 * but `application/json`, a `raw_body` route a CORS-safelisted type, none, or
 * a malformed one.
 *
 * @param content_type - the request's `Content-Type`, as `read_content_type` read it
 * @param raw_body - the route's `RouteSpec.raw_body`
 */
export const is_post_content_type_refused = (
	content_type: HeaderRead<string>,
	raw_body: boolean
): boolean =>
	raw_body ? is_cors_simple_content_type(content_type) : !is_json_content_type(content_type);
