/**
 * Middleware spec type — named middleware layer definition.
 *
 * Separated from `http/route_spec.ts` so middleware modules can import this
 * type without creating an upward dependency on routes.
 *
 * @module
 */

import type {MiddlewareHandler} from 'hono';

import type {RouteErrorSchemas} from './error_schemas.ts';

/** A named middleware layer. */
export interface MiddlewareSpec {
	name: string;
	path: string;
	handler: MiddlewareHandler;
	/** Error response schemas this middleware can produce, keyed by HTTP status code. */
	errors?: RouteErrorSchemas;
}
