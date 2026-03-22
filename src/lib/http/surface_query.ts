/**
 * Pure query functions over `AppSurface` data.
 *
 * Usable in tests, the adversarial auth runner, and future surface explorer UI.
 * Replaces duplicated inline `.filter()` patterns.
 *
 * TODO @surface-explorer Used by test utilities (test_auth_surface, adversarial_input,
 * surface_invariants) and SurfaceExplorer.svelte (surface_auth_summary, format_route_key).
 * Several query functions (filter_authenticated_routes, filter_keeper_routes,
 * routes_by_auth_type, filter_routes_by_prefix) are pre-built for richer surface
 * explorer features and consumer test suites — leverage more as the surface UI matures.
 *
 * @module
 */

import type {AppSurface, AppSurfaceRoute} from './surface.js';

/** Filter routes that require any form of authentication. */
export const filter_protected_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => r.auth.type !== 'none');

/** Filter routes that are publicly accessible (no auth). */
export const filter_public_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => r.auth.type === 'none');

/** Filter all role-guarded routes (any role). */
export const filter_role_routes = (
	surface: AppSurface,
): Array<AppSurfaceRoute & {auth: {type: 'role'; role: string}}> =>
	surface.routes.filter(
		(r): r is AppSurfaceRoute & {auth: {type: 'role'; role: string}} => r.auth.type === 'role',
	);

/** Filter routes that require basic authentication (no specific role). */
export const filter_authenticated_routes = (
	surface: AppSurface,
): Array<AppSurfaceRoute & {auth: {type: 'authenticated'}}> =>
	surface.routes.filter(
		(r): r is AppSurfaceRoute & {auth: {type: 'authenticated'}} => r.auth.type === 'authenticated',
	);

/** Filter routes that require keeper credentials. */
export const filter_keeper_routes = (
	surface: AppSurface,
): Array<AppSurfaceRoute & {auth: {type: 'keeper'}}> =>
	surface.routes.filter(
		(r): r is AppSurfaceRoute & {auth: {type: 'keeper'}} => r.auth.type === 'keeper',
	);

/** Filter routes that require a specific named role. */
export const filter_routes_for_role = (
	surface: AppSurface,
	role: string,
): Array<AppSurfaceRoute & {auth: {type: 'role'; role: string}}> =>
	surface.routes.filter(
		(r): r is AppSurfaceRoute & {auth: {type: 'role'; role: string}} =>
			r.auth.type === 'role' && r.auth.role === role,
	);

/**
 * Group routes by auth type.
 *
 * @returns a map from auth type string to route arrays, with role routes keyed as `'role:name'`
 */
export const routes_by_auth_type = (surface: AppSurface): Map<string, Array<AppSurfaceRoute>> => {
	const groups: Map<string, Array<AppSurfaceRoute>> = new Map();
	for (const r of surface.routes) {
		const key = r.auth.type === 'role' ? `role:${r.auth.role}` : r.auth.type;
		let group = groups.get(key);
		if (!group) {
			group = [];
			groups.set(key, group);
		}
		group.push(r);
	}
	return groups;
};

/** Filter routes whose path starts with `prefix`. */
export const filter_routes_by_prefix = (
	surface: AppSurface,
	prefix: string,
): Array<AppSurfaceRoute> => surface.routes.filter((r) => r.path.startsWith(prefix));

/** Filter routes that have a non-null input schema. */
export const filter_routes_with_input = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => r.input_schema !== null);

/** Filter routes that have a non-null params schema. */
export const filter_routes_with_params = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => r.params_schema !== null);

/** Filter routes that have a non-null query schema. */
export const filter_routes_with_query = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => r.query_schema !== null);

/** Filter routes that are mutations (POST, PUT, DELETE, PATCH). */
export const filter_mutation_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => r.is_mutation);

/** Filter routes that declare rate limiting. */
export const filter_rate_limited_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => r.rate_limit_key !== null);

/** Format a route as `'METHOD /path'` (e.g. `'GET /health'`). */
export const format_route_key = (route: AppSurfaceRoute): string => `${route.method} ${route.path}`;

/**
 * Summarize route auth distribution across the surface.
 *
 * @returns counts by auth type, with role counts broken out by role name
 */
export const surface_auth_summary = (
	surface: AppSurface,
): {none: number; authenticated: number; role: Map<string, number>; keeper: number} => {
	let none = 0;
	let authenticated = 0;
	const role: Map<string, number> = new Map();
	let keeper = 0;

	for (const r of surface.routes) {
		switch (r.auth.type) {
			case 'none':
				none++;
				break;
			case 'authenticated':
				authenticated++;
				break;
			case 'role':
				role.set(r.auth.role, (role.get(r.auth.role) ?? 0) + 1);
				break;
			case 'keeper':
				keeper++;
				break;
		}
	}

	return {none, authenticated, role, keeper};
};
