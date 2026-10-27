/**
 * Request body size limit — rejects an oversized body with `413`, and a
 * `Content-Length` it cannot read with `400`, before auth and validation.
 *
 * Wraps Hono's `bodyLimit` with a header-first check:
 *
 * - A `Content-Length` that is not a plain run of ASCII digits (`abc`, `-1`,
 *   `+5`, `1e9`, `0x1F4`, empty, or a combined `5, 500`) is refused with `400`
 *   `{error: 'invalid_content_length'}`. A cap cannot be applied to a length
 *   that does not parse, and `bodyLimit` passes such a request on uncounted.
 *   The runtimes' HTTP parsers answer their own bodiless `400` to most of
 *   these before the application sees them, so this branch is defense in
 *   depth where they do and the refusal where they do not: Node's refuses
 *   them all; Deno and Bun hand over a repeated equal header as one combined
 *   value (`50, 50`) and refuse the rest (observed on Node 24.14.1, Deno
 *   2.8.3, Bun 1.4.3). The Rust spine's parser (hyper) refuses a malformed
 *   value and differing repeats, and accepts an equal repeat as the one
 *   value.
 * - A request whose `Content-Length` exceeds the cap is refused with `413`
 *   `{error: 'payload_too_large'}`, whatever its method. A digit run of any
 *   length compares as a number, so one too long to represent exactly is over
 *   the cap, never unreadable. Over a socket that branch is reached on Node
 *   and Deno, whose parsers hand over any length below 2^64 and refuse a
 *   longer one with their own `400`. `Bun.serve` hands none over: with its
 *   default options it answers a length past 128 MiB with its own `413`, and
 *   one of 2^63 - 1 or more with its own `400` (observed on Node 24.14.1,
 *   Deno 2.8.3, Bun 1.4.3).
 * - Both refusals answer on the header alone — without touching
 *   `c.req.raw.body` — and carry `Connection: close`.
 * - A request with a well-formed `Content-Length` beside `Transfer-Encoding`,
 *   or with no `Content-Length`, falls through to `bodyLimit`, which measures
 *   the bytes that arrive: with `Transfer-Encoding` the declared length does
 *   not frame the body. `bodyLimit` reads the body into memory, up to the
 *   cap, **before** the next middleware runs, so that `413` — sent once more
 *   than the cap has been read, with no `Connection: close` — also comes
 *   ahead of the origin check, auth and the handler. The Rust spine counts
 *   such a body as its handler reads it instead, so there a refusal made on
 *   the headers answers first; which status an over-cap body with no declared
 *   length gets when another refusal also applies is implementation-defined
 *   across the two (`docs/security.md` §"Body Size Limiting").
 *   The Node, Deno and Bun parsers refuse a request carrying both headers
 *   with their own `400`; hyper accepts one, drops its `Content-Length`,
 *   frames the body as chunked, and closes the connection after the response.
 * - A well-formed `Content-Length` within the cap is trusted to frame the
 *   body, as the runtime's HTTP parser enforces.
 *
 * What the connection does after the header `413` is the runtime's
 * (`docs/security.md` §"Body Size Limiting"):
 *
 * - **Node** (`@hono/node-server`) closes at once, the body unread. The
 *   `Connection: close` header is what does it: without one the adapter
 *   holds the connection for a drain window and then closes or, the body
 *   untouched and arriving within the window, reads it off and serves the
 *   next request.
 * - **Deno** closes once the whole declared body has arrived and holds the
 *   connection open while a client withholds it; a request pipelined behind
 *   the body is not served. Neither the header nor what the handler does with
 *   the body changes that (observed on Deno 2.8.3).
 * - **Bun** closes at once, the body unread, honouring the header. Bun 1.4.3
 *   is the tested floor: an older Bun kept the connection after the `413` and
 *   served the next request (correctly framed), so run Bun at the floor or
 *   later.
 *
 * @module
 */

import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { ERROR_INVALID_CONTENT_LENGTH, ERROR_PAYLOAD_TOO_LARGE } from './error_schemas.ts';

/** A well-formed `Content-Length` value: one or more ASCII digits and nothing else. */
const CONTENT_LENGTH_DIGITS = /^[0-9]+$/;

/**
 * Create the body size limit middleware.
 *
 * @param max_size - the largest accepted body, in bytes; a safe integer, `0` or more
 * @returns middleware answering `413` `{error: 'payload_too_large'}` past the cap and `400` `{error: 'invalid_content_length'}` to a `Content-Length` that is not a run of digits
 * @throws Error when `max_size` is not a safe integer `0` or more — a `NaN` cap
 *   compares false against every length and would admit any body
 */
export const create_body_limit_middleware = (max_size: number): MiddlewareHandler => {
	if (!Number.isSafeInteger(max_size) || max_size < 0) {
		throw new Error(
			`create_body_limit_middleware: max_size must be a safe integer 0 or more, got ${max_size}`
		);
	}
	const streaming_limit = bodyLimit({
		maxSize: max_size,
		onError: (c) => c.json({ error: ERROR_PAYLOAD_TOO_LARGE }, 413)
	});
	return async (c, next) => {
		const content_length = c.req.header('content-length');
		if (content_length !== undefined) {
			if (!CONTENT_LENGTH_DIGITS.test(content_length)) {
				// a length that does not parse cannot be capped, and `bodyLimit`
				// would pass the request on without counting it
				return c.json({ error: ERROR_INVALID_CONTENT_LENGTH }, 400, { connection: 'close' });
			}
			// `Number` of a digit run is never `NaN`; past exact precision it is
			// still a huge number (or `Infinity`), so it compares as over the cap
			if (!c.req.header('transfer-encoding') && Number(content_length) > max_size) {
				// refused on the header alone, the body untouched; `Connection: close`
				// makes `@hono/node-server` and Bun close at once instead of holding
				// the connection or serving the request behind the body
				return c.json({ error: ERROR_PAYLOAD_TOO_LARGE }, 413, { connection: 'close' });
			}
		}
		return streaming_limit(c, next);
	};
};
