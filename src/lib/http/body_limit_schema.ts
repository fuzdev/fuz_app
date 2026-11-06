/**
 * The body size limit's middleware shape minus its handler — hono-free data,
 * so the surface builders that never mount the limit (`testing/stubs.ts`)
 * declare it without importing `hono/body-limit`.
 *
 * @module
 */

import type { MiddlewareSpec } from './middleware_spec.ts';
import { REST_INVALID_CONTENT_LENGTH, REST_PAYLOAD_TOO_LARGE } from './error_schemas.ts';

/**
 * The body limit's middleware spec minus its handler: at `'*'`, ahead of the
 * other middleware, answering `413` `payload_too_large` past the cap and
 * `400` `invalid_content_length` to a `Content-Length` it cannot read.
 * `create_body_limit_middleware_spec` (`http/body_limit.ts`) spreads it and
 * attaches the live handler.
 */
export const body_limit_middleware_shape = {
	name: 'body_limit',
	path: '*',
	errors: [REST_PAYLOAD_TOO_LARGE, REST_INVALID_CONTENT_LENGTH]
} as const satisfies Omit<MiddlewareSpec, 'handler'>;
