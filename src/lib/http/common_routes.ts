/**
 * Common route spec factories for fuz_app consumers.
 *
 * Generic HTTP route factories with no auth-domain dependencies.
 * Auth-aware route factories (account status) live in `auth/account_routes.ts`.
 *
 * @module
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { RouteSpec } from './route_spec.ts';
import type { AppSurface } from './surface.ts';
import {
	check_schema_drift,
	format_schema_drift,
	READY_ERROR,
	type ExpectedSchema
} from '../db/schema_ready.ts';

/**
 * Create a public health check route spec.
 *
 * Infrastructure endpoint for uptime monitors and load balancers.
 * Bootstrap availability is exposed via `/api/account/status` instead.
 */
export const create_health_route_spec = (): RouteSpec => ({
	method: 'GET',
	path: '/health',
	auth: { account: 'none', actor: 'none' },
	handler: (c) => c.json({ status: 'ok' }),
	description: 'Health check',
	input: z.null(),
	output: z.strictObject({ status: z.literal('ok') })
});

/** Module-level cache of loaded expected-schema fixtures, keyed by URL. */
const expected_schema_cache = new Map<string, ExpectedSchema>();

/**
 * Load a consumer's committed `expected_schema.json` fixture (cached by URL).
 *
 * The spine ships the readiness *mechanism* but not the *expectation* — the
 * expected column map is per-consumer (each adds its own tables), so the
 * consumer commits the fixture and passes the loaded map to
 * `create_ready_route_spec`. Call with an `import.meta.url`-relative URL:
 *
 * ```ts
 * create_ready_route_spec({
 *   expected: load_expected_schema(new URL('./expected_schema.json', import.meta.url)),
 *   log: deps.log,
 * });
 * ```
 *
 * The fixture is regenerated against a fresh bootstrap by the consumer's
 * gen-time test (see `testing/schema_ready_fixture.ts`), so it can't silently
 * fall behind the migration chain.
 *
 * @param url - the fixture location (a file URL or path)
 */
export const load_expected_schema = (url: URL | string): ExpectedSchema => {
	const key = url.toString();
	let cached = expected_schema_cache.get(key);
	if (!cached) {
		cached = JSON.parse(readFileSync(url, 'utf8')) as ExpectedSchema;
		// Fail loud at load: an empty map silently passes readiness for any live
		// DB, neutering the gate it exists to provide. A real fixture always has
		// at least `schema_version` + the consumer's tables.
		if (Object.keys(cached).length === 0) {
			throw new Error(
				`load_expected_schema: ${key} parsed to an empty schema map — a readiness gate with ` +
					`no expected tables passes for any live DB. Regenerate the fixture (see ` +
					`testing/schema_ready_fixture.ts).`
			);
		}
		expected_schema_cache.set(key, cached);
	}
	return cached;
};

/** Options for the readiness probe route. */
export interface ReadyRouteOptions {
	/**
	 * The committed expected column map — typically `load_expected_schema(url)`.
	 * DI'd because the spine can't resolve a path relative to the consumer's
	 * fixture.
	 */
	expected: ExpectedSchema;
	/** Logger for server-side drift diagnostics (the public body stays minimal). */
	log?: Logger;
}

/**
 * Create the `/ready` readiness route spec — the deploy gate.
 *
 * Returns `200 {ready: true}` when the live DB's columns cover `expected`,
 * else `503 {error}` (`schema_drift` when columns are missing, `db_unreachable`
 * when the introspection query throws). The detailed drift goes to the server
 * log only — the public body stays a minimal code so the endpoint doesn't leak
 * schema structure (mirrors why `/api/surface` is authenticated). A deploy poll
 * treats `503` as a failed release and rolls back, turning a silent
 * schema-drift auth outage into a loud blocked deploy. See `db/schema_ready.ts`
 * for the column-presence rationale and `auth/migrations.ts` for the
 * frozen-append discipline that prevents the drift in the first place.
 */
export const create_ready_route_spec = (options: ReadyRouteOptions): RouteSpec => {
	// Fail loud at assembly: an empty `expected` makes `/ready` answer 200 for
	// any live DB (the drift loop has nothing to miss), silently disabling the
	// deploy gate. Catch the misconfiguration at boot, not in production.
	if (Object.keys(options.expected).length === 0) {
		throw new Error(
			'create_ready_route_spec: `expected` is empty — a readiness gate with no expected ' +
				'tables passes for any live DB. Pass a non-empty expected column map.'
		);
	}
	return {
		method: 'GET',
		path: '/ready',
		auth: { account: 'none', actor: 'none' },
		description: 'Readiness probe — verifies the live DB schema matches the expected column map',
		input: z.null(),
		output: z.strictObject({ ready: z.literal(true) }),
		errors: {
			503: z.strictObject({
				error: z.enum([READY_ERROR.schema_drift, READY_ERROR.db_unreachable])
			})
		},
		handler: async (c, route) => {
			try {
				const drift = await check_schema_drift(route.db, options.expected);
				if (drift.ok) return c.json({ ready: true });
				// Detailed drift goes to the server log only — the public body stays a
				// minimal error code so the endpoint doesn't leak schema structure.
				options.log?.error(`[ready] schema drift detected:\n${format_schema_drift(drift)}`);
				return c.json({ error: READY_ERROR.schema_drift }, 503);
			} catch (err) {
				options.log?.error('[ready] readiness check failed (db unreachable?):', err);
				return c.json({ error: READY_ERROR.db_unreachable }, 503);
			}
		}
	};
};

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
 */
export const create_server_status_route_spec = (options: ServerStatusOptions): RouteSpec => ({
	method: 'GET',
	path: '/api/server/status',
	auth: { account: 'required', actor: 'none' },
	handler: (c) => c.json({ version: options.version, uptime_ms: options.get_uptime_ms() }),
	description: 'Server version and uptime',
	input: z.null(),
	output: z.looseObject({ version: z.string(), uptime_ms: z.number() })
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
 */
export const create_surface_route_spec = (options: SurfaceRouteOptions): RouteSpec => ({
	method: 'GET',
	path: '/api/surface',
	auth: { account: 'required', actor: 'none' },
	handler: (c) => c.json(options.surface),
	description: 'Application surface (routes, middleware, schemas)',
	input: z.null(),
	output: z.looseObject({
		routes: z.array(z.looseObject({})),
		middleware: z.array(z.looseObject({}))
	})
});
