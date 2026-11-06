/**
 * A route's error map: every error definition it can answer with — derived
 * from its slots (`derive_route_errors`), declared by each middleware layer
 * that runs on it, and its own `errors` — and the status map they group into.
 *
 * Built once per app (`resolve_app_route_error_maps`, carried as
 * `AppSurfaceSpec.route_error_maps`) and read by every reader of a route's
 * declared errors: the surface, the DEV error check, the test helpers, error
 * coverage, and the attack-surface suite. The maps are keyed `METHOD path`
 * (`format_route_key`).
 *
 * @module
 */

import type { RouteAuth } from './auth_shape.ts';
import type { RouteMethod } from './route_spec.ts';
import {
	dedupe_rest_errors,
	derive_route_errors,
	to_error_schemas,
	type ErrorSchemas,
	type RestErrorDef
} from './error_schemas.ts';
import type { MiddlewareSpec } from './middleware_spec.ts';
import { is_null_schema, middleware_spec_applies } from './schema_helpers.ts';
import { format_route_key } from './surface_query.ts';
import type { RateLimitKey } from '../rate_limiter.ts';
import type { ValidationSchema } from '../schema_issues.ts';

/**
 * A route's error map: every error definition the route can answer with, and
 * the status map they group into. Built by `resolve_route_error_map`, and read by
 * every reader of a route's declared errors — the surface, the DEV error
 * check, the test helpers, error coverage, and the attack-surface suite.
 */
export interface RouteErrorMap {
	/**
	 * The definitions, in order — derived, then each applying middleware's, then
	 * the route's own — with each repeat left out (`dedupe_rest_errors`). Two
	 * shapes of one code at one status are both kept.
	 */
	readonly defs: ReadonlyArray<RestErrorDef>;
	/** The definitions grouped by status (`to_error_schemas`): one schema, or a `union` of them. */
	readonly schemas: ErrorSchemas;
}

/** What `resolve_route_error_map` reads of a route spec. */
export interface RouteErrorMapSpec {
	readonly method: RouteMethod;
	readonly path: string;
	readonly auth: RouteAuth;
	readonly input: ValidationSchema;
	readonly params?: ValidationSchema;
	readonly query?: ValidationSchema;
	readonly rate_limit?: RateLimitKey;
	readonly errors?: ReadonlyArray<RestErrorDef>;
}

/**
 * Resolve a route's error map: the union of the definitions derived from it
 * (`derive_route_errors`, narrowed to the slots it has), those of each
 * middleware layer that runs on it (`middleware_spec_applies`), in list order,
 * and its own `errors`. Nothing replaces anything: a definition at a status
 * another layer declares is one more branch there, and a repeat counts once.
 *
 * @param spec - the route spec
 * @param middleware_specs - the app's middleware layers, of which those that apply to the route contribute
 * @returns the route's error map
 */
export const resolve_route_error_map = (
	spec: RouteErrorMapSpec,
	middleware_specs?: ReadonlyArray<Pick<MiddlewareSpec, 'path' | 'carve_outs' | 'errors'>> | null
): RouteErrorMap => {
	const all: Array<RestErrorDef> = derive_route_errors({
		method: spec.method,
		auth: spec.auth,
		has_input: !is_null_schema(spec.input),
		has_params: spec.params !== undefined,
		has_query: spec.query !== undefined,
		rate_limit: spec.rate_limit
	});
	if (middleware_specs) {
		for (const mw of middleware_specs) {
			if (mw.errors && middleware_spec_applies(mw, spec.path)) all.push(...mw.errors);
		}
	}
	if (spec.errors) all.push(...spec.errors);
	const defs = dedupe_rest_errors(all);
	return { defs, schemas: to_error_schemas(defs) };
};

/**
 * Resolve every route's error map (`resolve_route_error_map`) against one
 * middleware list, keyed by `format_route_key` (`METHOD path`).
 *
 * @param route_specs - the app's routes
 * @param middleware_specs - the app's middleware layers
 * @returns each route's error map
 */
export const resolve_app_route_error_maps = (
	route_specs: ReadonlyArray<RouteErrorMapSpec>,
	middleware_specs?: ReadonlyArray<Pick<MiddlewareSpec, 'path' | 'carve_outs' | 'errors'>> | null
): Map<string, RouteErrorMap> => {
	const route_error_maps: Map<string, RouteErrorMap> = new Map();
	for (const spec of route_specs) {
		route_error_maps.set(format_route_key(spec), resolve_route_error_map(spec, middleware_specs));
	}
	return route_error_maps;
};

/**
 * A route's error map from a map built by `resolve_app_route_error_maps`, or,
 * with no map, resolved from the route alone — without middleware.
 *
 * @param route_error_maps - the app's route error maps, if the caller has them
 * @param spec - the route spec
 * @returns the route's error map
 * @throws Error naming the route's key when a map is given with no entry for
 *   the route — a map built over other routes, which would silently drop the
 *   middleware's definitions
 */
export const get_route_error_map = (
	route_error_maps: ReadonlyMap<string, RouteErrorMap> | null | undefined,
	spec: RouteErrorMapSpec
): RouteErrorMap => {
	if (route_error_maps == null) return resolve_route_error_map(spec);
	const key = format_route_key(spec);
	const route_error_map = route_error_maps.get(key);
	if (!route_error_map) {
		throw new Error(`get_route_error_map: the route error maps have no entry for '${key}'`);
	}
	return route_error_map;
};
