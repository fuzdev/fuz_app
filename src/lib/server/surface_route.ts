/**
 * The surface explorer route — `GET /api/surface`, serving the generated
 * `AppSurface` as JSON.
 *
 * Opt-in on `create_app_server` (`surface_route: true`), and admin-only when
 * mounted: the surface is a map of every route, its auth, and its schemas.
 *
 * @module
 */

import { array, literal, loose_object, object } from '@fuzdev/fuz_schema/schema.ts';

import type { RouteSpec } from '../http/route_spec.ts';
import type { AppSurface } from '../http/surface.ts';
import { ActingActor } from '../primitive_schemas_fuz.ts';
import { ROLE_ADMIN } from '../auth/role_schema.ts';

/** Options for the surface explorer route. */
export interface SurfaceRouteOptions {
	/** The generated app surface to serve — read per request, so a backfilled ref serves the final surface. */
	surface: AppSurface;
}

/**
 * Create the admin-only route spec that serves the `AppSurface` as JSON.
 *
 * Surface data reveals API structure (routes, auth, schemas), so the route
 * requires the global admin role. It is also a non-RPC surface: it declares
 * `required_scope: 'surface:app_surface'`, so a narrowed API token is refused
 * it whatever its method list says (403 `token_scope_required`, ahead of the
 * role gate), while a full-scope admin bearer passes. The admin role implies
 * `actor: 'required'`, so the route takes the `?acting=` selector a
 * multi-actor admin disambiguates with.
 *
 * @param options - the surface to serve
 * @returns the `GET /api/surface` route spec
 */
export const create_surface_route_spec = (options: SurfaceRouteOptions): RouteSpec => ({
	method: 'GET',
	path: '/api/surface',
	auth: {
		account: 'required',
		actor: 'required',
		roles: [ROLE_ADMIN],
		// rule 3 — the surface map is not an RPC method, so a narrowed token
		// gets none of it
		required_scope: 'surface:app_surface'
	},
	handler: (c) => c.json(options.surface),
	description: 'Application surface (routes, middleware, schemas) — admin only',
	query: object({ acting: ActingActor }),
	input: literal(null),
	output: loose_object({
		routes: array(loose_object({})),
		middleware: array(loose_object({}))
	})
});
