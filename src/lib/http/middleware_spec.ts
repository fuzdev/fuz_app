/**
 * Middleware spec type — named middleware layer definition.
 *
 * Separated from `http/route_spec.ts` so middleware modules can import this
 * type without creating an upward dependency on routes.
 *
 * @module
 */

import type { MiddlewareHandler } from 'hono';

import type { RestErrorDef } from './error_schemas.ts';

/**
 * Paths a middleware layer explicitly does not run on, and why — the named
 * exception to a layer that covers every path by default (the origin check).
 */
export interface MiddlewareCarveOut {
	/** Hono-style pattern (`/hooks/*`, `/health`), matched like `MiddlewareSpec.path`. */
	readonly path: string;
	/** Why these paths are safe without the layer — required, so a carve-out is an argument, not an omission. */
	readonly reason: string;
}

/** A named middleware layer. */
export interface MiddlewareSpec {
	name: string;
	path: string;
	handler: MiddlewareHandler;
	/**
	 * The error definitions this layer can answer with. Each joins the error map
	 * (`resolve_route_errors`) of every route the layer runs on, beside the
	 * route's own, replacing none of them. An empty list says the layer answers
	 * with no error of its own.
	 */
	errors?: ReadonlyArray<RestErrorDef>;
	/**
	 * Paths under `path` the layer does not run on. The handler enforces them
	 * itself (Hono mounts by `path` alone); the field is what keeps the
	 * generated surface from claiming the layer's errors on those routes.
	 */
	carve_outs?: ReadonlyArray<MiddlewareCarveOut>;
}
