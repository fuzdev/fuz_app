/**
 * Request body size limit — rejects an oversized body with `413` before auth
 * and validation.
 *
 * Wraps Hono's `bodyLimit` with a header-first check: a request whose
 * `Content-Length` exceeds the cap is refused on the header alone, without
 * touching `c.req.raw.body`. Hono's `bodyLimit` reads that getter on every
 * request before it looks at the header, and on Deno merely reading it changes
 * how the connection ends — Deno then drains the rest of the declared body
 * after the response and keeps the socket alive (ignoring a `Connection:
 * close`), where an untouched body makes it close. Closing without reading the
 * body is the defense-in-depth posture against request smuggling
 * (`docs/security.md` §"Body Size Limiting"), so the header check keeps it on
 * every runtime that offers it. A request with no usable `Content-Length`
 * (chunked, or none) falls through to `bodyLimit`'s streaming count.
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
			// refused on the header alone — reading `c.req.raw.body` here would make
			// Deno drain the body and keep the connection alive; `Connection: close`
			// stops `@hono/node-server` from draining the unread body for reuse
			return c.json({ error: ERROR_PAYLOAD_TOO_LARGE }, 413, { connection: 'close' });
		}
		return streaming_limit(c, next);
	};
};
