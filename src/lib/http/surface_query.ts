/**
 * Pure query functions over `AppSurface` data.
 *
 * Usable in tests, the adversarial auth runner, and future surface explorer UI.
 * Replaces duplicated inline `.filter()` patterns.
 *
 * Categorical filters (`filter_role_routes`, `filter_keeper_routes`,
 * `filter_credential_gated_routes`) and `surface_auth_summary` group the
 * flat-record `RouteAuth` shape into categorical buckets for adversarial test
 * runners and the surface explorer. The buckets are
 * derived views over the authority axes (`account`, `actor`, `roles`,
 * `credential_types`) — see `http/auth_shape.ts` for the canonical shape.
 *
 * @module
 */

import type { AppSurface, AppSurfaceRoute } from './surface.ts';
import {
	type RouteAuth,
	is_credential_gated_auth,
	is_keeper_auth,
	is_plain_authenticated_auth,
	is_public_auth,
	is_role_auth
} from './auth_shape.ts';

/** Filter routes that require any form of authentication. */
export const filter_protected_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => !is_public_auth(r.auth));

/** Filter routes that are publicly accessible (no auth surface at all). */
export const filter_public_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => is_public_auth(r.auth));

/** Filter all role-guarded routes (any role declared on `auth.roles`). */
export const filter_role_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => is_role_auth(r.auth));

/** Filter routes that require keeper credentials (`daemon_token`). */
export const filter_keeper_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => is_keeper_auth(r.auth));

/**
 * Filter routes gated to a credential channel (any non-empty
 * `auth.credential_types`), whichever channel that is.
 *
 * Superset of `filter_keeper_routes`: keeper is the `daemon_token` gate, and
 * the same axis points the other way on the session-only routes (the
 * credential-minting actions, `POST /logout` / `POST /password`, the audit
 * SSE stream). Adversarial runners need the whole bucket, since every route
 * in it answers `credential_type_required` to a channel it does not admit.
 */
export const filter_credential_gated_routes = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => is_credential_gated_auth(r.auth));

/**
 * The auth bucket of a `RouteAuth` — the one categorizer `surface_auth_summary`
 * counts by:
 *
 * - `none` for fully public routes (account === 'none' && actor === 'none')
 * - `keeper` when `credential_types` includes `'daemon_token'`
 * - `role`, naming each role declared on `auth.roles`
 * - `credential`, naming each channel a role-less route's `credential_types`
 *   admits — the session-only gates (`POST /logout`, `POST /password`, the
 *   `account_*` credential-lifecycle actions), plus any channel a consumer
 *   registers
 * - `authenticated` for `account === 'required'` without role / credential gate
 * - `optional` when either axis is `'optional'` and no other bucket fits
 * - `other` as a last-resort bucket for shapes that don't match above
 *
 * Keeper is tested before the role bucket and the general credential bucket
 * after it, which is not an inconsistency: keeper is an authority *level* — a
 * ceiling no session or api token reaches — so it names the route, while a
 * session gate is a *channel* restriction layered over whatever authority the
 * route already declares. So the audit SSE stream, gated to the session
 * channel and to the admin role, buckets as `role` (`admin`).
 */
type RouteAuthBucket =
	| { kind: 'none' | 'keeper' | 'authenticated' | 'optional' | 'other' }
	| { kind: 'role' | 'credential'; names: ReadonlyArray<string> };

const categorize_route_auth = (auth: RouteAuth): RouteAuthBucket => {
	if (is_public_auth(auth)) return { kind: 'none' };
	if (is_keeper_auth(auth)) return { kind: 'keeper' };
	if (is_role_auth(auth)) return { kind: 'role', names: auth.roles! };
	if (is_credential_gated_auth(auth)) return { kind: 'credential', names: auth.credential_types! };
	if (is_plain_authenticated_auth(auth)) return { kind: 'authenticated' };
	if (auth.account === 'optional' || auth.actor === 'optional') return { kind: 'optional' };
	return { kind: 'other' };
};

/** Filter routes that have a non-null input schema. */
export const filter_routes_with_input = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => r.input_schema !== null);

/** Filter routes that have a non-null params schema. */
export const filter_routes_with_params = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => r.params_schema !== null);

/** Filter routes that have a non-null query schema. */
export const filter_routes_with_query = (surface: AppSurface): Array<AppSurfaceRoute> =>
	surface.routes.filter((r) => r.query_schema !== null);

/** Format a route as `'METHOD /path'` (e.g. `'GET /health'`). */
export const format_route_key = (route: AppSurfaceRoute): string => `${route.method} ${route.path}`;

/**
 * Summarize route auth distribution across the surface.
 *
 * Categorical view over the flat auth record — `none`, `keeper`, `role` and
 * `credential` (counted per name), `authenticated`, `optional`, `other`.
 * Keeper outranks a role, and a role outranks a channel gate, so the audit
 * SSE stream (admin role, session channel) counts under `role`. Multi-role
 * and multi-channel specs contribute one count per role / channel they admit.
 *
 * @returns counts by auth category, with role and channel counts broken out
 *   by name
 */
export const surface_auth_summary = (
	surface: AppSurface
): {
	none: number;
	authenticated: number;
	optional: number;
	role: Map<string, number>;
	credential: Map<string, number>;
	keeper: number;
	other: number;
} => {
	let none = 0;
	let authenticated = 0;
	let optional = 0;
	const role: Map<string, number> = new Map();
	const credential: Map<string, number> = new Map();
	let keeper = 0;
	let other = 0;

	for (const r of surface.routes) {
		const bucket = categorize_route_auth(r.auth);
		switch (bucket.kind) {
			case 'none':
				none++;
				break;
			case 'keeper':
				keeper++;
				break;
			case 'authenticated':
				authenticated++;
				break;
			case 'optional':
				optional++;
				break;
			case 'other':
				other++;
				break;
			case 'role':
				for (const name of bucket.names) role.set(name, (role.get(name) ?? 0) + 1);
				break;
			case 'credential':
				for (const name of bucket.names) credential.set(name, (credential.get(name) ?? 0) + 1);
				break;
		}
	}

	return { none, authenticated, optional, role, credential, keeper, other };
};
