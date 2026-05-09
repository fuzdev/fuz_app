/**
 * Pure query functions over `AppSurface` data.
 *
 * Usable in tests, the adversarial auth runner, and future surface explorer UI.
 * Replaces duplicated inline `.filter()` patterns.
 *
 * Categorical filters (`filter_authenticated_routes`, `filter_role_routes`,
 * `filter_keeper_routes`) group the new flat-record `RouteAuth` shape into
 * the legacy categorical buckets (`'authenticated'`, `'role'`, `'keeper'`)
 * for adversarial test runners and the surface explorer. The buckets are
 * derived views over the four axes (`account`, `actor`, `roles`,
 * `credential_types`) — see `http/auth_shape.ts` for the canonical shape.
 *
 * @module
 */

import type {AppSurface, AppSurfaceRoute} from './surface.js';
import type {RouteAuth} from './auth_shape.js';

/** True iff the route is fully public — no account, no actor, no roles, no credential gate. */
export const is_public_auth = (auth: RouteAuth): boolean =>
	auth.account === 'none' && auth.actor === 'none';

/** True iff the route declares any role gate (`auth.roles?.length`). */
export const is_role_auth = (auth: RouteAuth): boolean => !!auth.roles?.length;

/** True iff the route declares any credential-type gate (`auth.credential_types?.length`). */
export const is_credential_gated_auth = (auth: RouteAuth): boolean =>
	!!auth.credential_types?.length;

/**
 * True iff the route is the keeper bucket — credential gate restricted to
 * `daemon_token`. Keeper is the only credential gate today; if more land,
 * this filter widens.
 */
export const is_keeper_auth = (auth: RouteAuth): boolean =>
	auth.credential_types?.includes('daemon_token') ?? false;

/**
 * True iff the route is plain authenticated — `account === 'required'` with
 * no role gate and no credential gate. Account-grain authenticated routes
 * (logout, password change, account self-service) fall here.
 */
export const is_plain_authenticated_auth = (auth: RouteAuth): boolean =>
	auth.account === 'required' && !is_role_auth(auth) && !is_credential_gated_auth(auth);

/** Filter routes that require any form of authentication. */
export const filter_protected_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => !is_public_auth(r.auth));

/** Filter routes that are publicly accessible (no auth surface at all). */
export const filter_public_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => is_public_auth(r.auth));

/** Filter all role-guarded routes (any role declared on `auth.roles`). */
export const filter_role_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => is_role_auth(r.auth));

/**
 * Filter routes that require basic authentication only — `account === 'required'`
 * with no role / credential gate.
 */
export const filter_authenticated_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => is_plain_authenticated_auth(r.auth));

/** Filter routes that require keeper credentials (`daemon_token`). */
export const filter_keeper_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => is_keeper_auth(r.auth));

/** Filter routes whose `auth.roles` includes the named role. */
export const filter_routes_for_role = (surface: AppSurface, role: string): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => r.auth.roles?.includes(role) ?? false);

/**
 * Categorize a `RouteAuth` into one of the legacy auth buckets.
 *
 * Returns:
 * - `'none'` for fully public routes (account === 'none' && actor === 'none')
 * - `'keeper'` when `credential_types` includes `'daemon_token'`
 * - `'role:<name>'` for each role declared on `auth.roles` (multi-role specs
 *   are emitted multiple times; callers that need single-bucket grouping
 *   should pre-collapse)
 * - `'authenticated'` for `account === 'required'` without role / credential gate
 * - `'optional'` when either axis is `'optional'` and no other bucket fits
 * - `'other'` as a last-resort bucket for shapes that don't match above
 */
export type RouteAuthCategory =
	| 'none'
	| 'authenticated'
	| 'optional'
	| 'keeper'
	| `role:${string}`
	| 'other';

/**
 * Group routes by auth category (see `RouteAuthCategory`). Multi-role specs
 * appear under each of their role buckets.
 */
export const routes_by_auth_type = (surface: AppSurface): Map<string, Array<AppSurfaceRoute>> => {
	const groups: Map<string, Array<AppSurfaceRoute>> = new Map();
	const push = (key: string, r: AppSurfaceRoute) => {
		let group = groups.get(key);
		if (!group) {
			group = [];
			groups.set(key, group);
		}
		group.push(r);
	};
	for (const r of surface.routes) {
		const auth = r.auth;
		if (is_public_auth(auth)) {
			push('none', r);
			continue;
		}
		if (is_keeper_auth(auth)) {
			push('keeper', r);
			continue;
		}
		if (is_role_auth(auth)) {
			for (const role of auth.roles!) push(`role:${role}`, r);
			continue;
		}
		if (is_plain_authenticated_auth(auth)) {
			push('authenticated', r);
			continue;
		}
		if (auth.account === 'optional' || auth.actor === 'optional') {
			push('optional', r);
			continue;
		}
		push('other', r);
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
 * Categorical view over the four-axis flat record. Multi-role specs
 * contribute one count per role they admit.
 *
 * @returns counts by auth category, with role counts broken out by role name
 */
export const surface_auth_summary = (
	surface: AppSurface,
): {
	none: number;
	authenticated: number;
	optional: number;
	role: Map<string, number>;
	keeper: number;
	other: number;
} => {
	let none = 0;
	let authenticated = 0;
	let optional = 0;
	const role: Map<string, number> = new Map();
	let keeper = 0;
	let other = 0;

	for (const r of surface.routes) {
		const auth = r.auth;
		if (is_public_auth(auth)) {
			none++;
			continue;
		}
		if (is_keeper_auth(auth)) {
			keeper++;
			continue;
		}
		if (is_role_auth(auth)) {
			for (const r_name of auth.roles!) {
				role.set(r_name, (role.get(r_name) ?? 0) + 1);
			}
			continue;
		}
		if (is_plain_authenticated_auth(auth)) {
			authenticated++;
			continue;
		}
		if (auth.account === 'optional' || auth.actor === 'optional') {
			optional++;
			continue;
		}
		other++;
	}

	return {none, authenticated, optional, role, keeper, other};
};
