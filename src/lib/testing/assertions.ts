import './assert_dev_env.js';

/**
 * Assertion helpers for auth attack surface testing.
 *
 * Plain functions called inside explicit `test()` blocks to verify
 * surface snapshots, public routes, and middleware stacks.
 *
 * @module
 */

import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assert} from 'vitest';
import type {z} from 'zod';

import type {AppSurface, AppSurfaceRoute} from '../http/surface.js';
import type {RouteErrorSchemas} from '../http/error_schemas.js';

/**
 * Resolve an absolute path relative to the caller's module.
 *
 * @param filename - the filename to resolve
 * @param import_meta_url - the caller's `import.meta.url`
 * @returns absolute path
 */
export const resolve_fixture_path = (filename: string, import_meta_url: string): string =>
	resolve(dirname(fileURLToPath(import_meta_url)), filename);

/**
 * Compare live surface against a committed snapshot JSON file.
 *
 * @param surface - the live surface to check
 * @param snapshot_path - absolute path to the committed JSON snapshot
 */
export const assert_surface_matches_snapshot = (
	surface: AppSurface,
	snapshot_path: string,
): void => {
	const committed = JSON.parse(readFileSync(snapshot_path, 'utf-8'));
	assert.deepStrictEqual(
		surface,
		committed,
		'Attack surface changed! Run `gro gen` to update the snapshot, then review the diff.',
	);
};

/**
 * Verify surface generation is deterministic (build twice, compare).
 *
 * @param build_surface - function that builds the surface
 */
export const assert_surface_deterministic = (build_surface: () => AppSurface): void => {
	assert.deepStrictEqual(build_surface(), build_surface());
};

/**
 * Bidirectional check: no unexpected public routes, no missing expected ones.
 *
 * @param surface - the app surface to check
 * @param expected_public - format: `['GET /health', 'POST /api/account/login']`
 */
export const assert_only_expected_public_routes = (
	surface: AppSurface,
	expected_public: Array<string>,
): void => {
	const expected = new Set(expected_public);
	const actual_public = surface.routes
		.filter((r) => r.auth.type === 'none')
		.map((r) => `${r.method} ${r.path}`);

	const unexpected = actual_public.filter((r) => !expected.has(r));
	const missing = expected_public.filter((r) => !actual_public.includes(r));

	assert.strictEqual(unexpected.length, 0, `Unexpected public routes: ${unexpected.join(', ')}`);
	assert.strictEqual(missing.length, 0, `Expected public routes missing: ${missing.join(', ')}`);
};

/**
 * Verify every route under a path prefix has the exact expected middleware stack.
 *
 * @param surface - the app surface to check
 * @param path_prefix - prefix to filter routes (e.g. `'/api/'`)
 * @param expected_middleware - the exact middleware names in order
 */
/**
 * Look up the merged error schema for a route+status from a pre-built schema lookup.
 *
 * @param lookup - map from `"METHOD /path"` to merged error schemas
 * @param route - the surface route to look up
 * @param status - HTTP status code
 */
export const get_route_error_schema = (
	lookup: Map<string, RouteErrorSchemas>,
	route: AppSurfaceRoute,
	status: number,
): z.ZodType | undefined => {
	const key = `${route.method} ${route.path}`;
	return lookup.get(key)?.[status];
};

/**
 * Assert that an error schema exists for a route+status and validate the body against it.
 *
 * Protected routes should always have auto-derived error schemas (401 for authenticated,
 * 403 for role-restricted). A missing schema indicates a gap in error schema derivation.
 *
 * @param lookup - map from `"METHOD /path"` to merged error schemas
 * @param route - the surface route to validate against
 * @param status - expected HTTP status code
 * @param body - the parsed response body to validate
 */
export const assert_error_schema_valid = (
	lookup: Map<string, RouteErrorSchemas>,
	route: AppSurfaceRoute,
	status: number,
	body: unknown,
): void => {
	const schema = get_route_error_schema(lookup, route, status);
	assert.ok(schema, `missing error schema for ${status} on ${route.method} ${route.path}`);
	schema.parse(body);
};

export const assert_full_middleware_stack = (
	surface: AppSurface,
	path_prefix: string,
	expected_middleware: Array<string>,
): void => {
	const routes = surface.routes.filter((r) => r.path.startsWith(path_prefix));
	assert.ok(routes.length > 0, `No routes found under ${path_prefix}`);
	for (const route of routes) {
		assert.deepStrictEqual(
			route.applicable_middleware,
			expected_middleware,
			`${route.method} ${route.path} has wrong middleware stack`,
		);
	}
};
