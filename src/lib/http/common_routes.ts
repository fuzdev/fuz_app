/**
 * Common route spec factories for fuz_app consumers.
 *
 * Generic HTTP route factories with no auth-domain dependencies.
 * Auth-aware route factories (account status) live in `auth/account_routes.ts`.
 *
 * @module
 */

import {z} from 'zod';

import type {RouteSpec} from './route_spec.js';
import type {AppSurface} from './surface.js';

/**
 * Create a public health check route spec.
 *
 * Infrastructure endpoint for uptime monitors and load balancers.
 * Bootstrap availability is exposed via `/api/account/status` instead.
 *
 * @returns a single health check route spec
 */
export const create_health_route_spec = (): RouteSpec => ({
	method: 'GET',
	path: '/health',
	auth: {type: 'none'},
	handler: (c) => c.json({status: 'ok'}),
	description: 'Health check',
	input: z.null(),
	output: z.strictObject({status: z.literal('ok')}),
});

/** Options for the authenticated server status route. */
export interface ServerStatusOptions {
	/** Application version string. */
	version: string;
	/** Returns milliseconds since server start. */
	get_uptime_ms: () => number;
}

/**
 * Create an authenticated server status route spec.
 *
 * Returns version and uptime. Unlike the public health check,
 * this requires authentication.
 *
 * @param options - version and uptime source
 * @returns route spec for `GET /api/server/status`
 */
export const create_server_status_route_spec = (options: ServerStatusOptions): RouteSpec => ({
	method: 'GET',
	path: '/api/server/status',
	auth: {type: 'authenticated'},
	handler: (c) => c.json({version: options.version, uptime_ms: options.get_uptime_ms()}),
	description: 'Server version and uptime',
	input: z.null(),
	output: z.looseObject({version: z.string(), uptime_ms: z.number()}),
});

/** Options for the surface explorer route. */
export interface SurfaceRouteOptions {
	/** The generated app surface to serve. */
	surface: AppSurface;
}

/**
 * Create an authenticated route spec that serves the `AppSurface` as JSON.
 *
 * Surface data reveals API structure (routes, auth, schemas), so this
 * requires authentication like the server status route.
 *
 * @param options - surface data source
 * @returns route spec for `GET /api/surface`
 */
export const create_surface_route_spec = (options: SurfaceRouteOptions): RouteSpec => ({
	method: 'GET',
	path: '/api/surface',
	auth: {type: 'authenticated'},
	handler: (c) => c.json(options.surface),
	description: 'Application surface (routes, middleware, schemas)',
	input: z.null(),
	output: z.looseObject({
		routes: z.array(z.looseObject({})),
		middleware: z.array(z.looseObject({})),
	}),
});
