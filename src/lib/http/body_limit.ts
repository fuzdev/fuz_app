/**
 * Request body size limit — rejects an oversized body with `413` before auth
 * and validation.
 *
 * Wraps Hono's `bodyLimit` with a header-first check: a request whose
 * `Content-Length` exceeds the cap is refused on the header alone — without
 * touching `c.req.raw.body` — and the `413` carries `Connection: close`. A
 * request with no usable `Content-Length` (chunked, or none) falls through to
 * `bodyLimit`'s streaming count.
 *
 * What the connection does after that `413` is the runtime's
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
 * - **Bun** keeps the connection, skips the declared body, and serves the
 *   next request on it (observed on Bun 1.3.11).
 *
 * @module
 */

import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { ERROR_PAYLOAD_TOO_LARGE } from './error_schemas.ts';

/**
 * Create the body size limit middleware.
 *
 * @param max_size - the largest accepted body, in bytes
 * @returns middleware answering `413` `{error: 'payload_too_large'}` past the cap
 */
export const create_body_limit_middleware = (max_size: number): MiddlewareHandler => {
	const streaming_limit = bodyLimit({
		maxSize: max_size,
		onError: (c) => c.json({ error: ERROR_PAYLOAD_TOO_LARGE }, 413)
	});
	return async (c, next) => {
		const content_length = c.req.header('content-length');
		if (
			content_length !== undefined &&
			!c.req.header('transfer-encoding') &&
			Number.parseInt(content_length, 10) > max_size
		) {
			// refused on the header alone, the body untouched; `Connection: close`
			// makes `@hono/node-server` close at once instead of holding the
			// connection or serving the request behind the body
			return c.json({ error: ERROR_PAYLOAD_TOO_LARGE }, 413, { connection: 'close' });
		}
		return streaming_limit(c, next);
	};
};
