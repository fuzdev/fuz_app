import './assert_dev_env.ts';

/**
 * Assertion helpers for auth attack surface testing.
 *
 * Plain functions called inside explicit `test()` blocks to verify
 * surface snapshots, public routes, and middleware stacks.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from 'vitest';
import { type AnySchema, parse } from '@fuzdev/fuz_schema/schema.ts';

import type { AppSurface, AppSurfaceRoute } from '../http/surface.ts';
import type { RouteErrorMap } from '../http/route_errors.ts';
import { format_route_key } from '../http/surface_query.ts';
import { is_public_auth } from '../http/auth_shape.ts';
import {
	check_route_error,
	format_route_error_check,
	is_error_status,
	is_json_response
} from '../http/route_error_check.ts';
import {
	middleware_applies,
	middleware_carves_out,
	middleware_spec_applies
} from '../http/schema_helpers.ts';

/**
 * Resolve an absolute path relative to the caller's module.
 *
 * @param import_meta_url - the caller's `import.meta.url`
 */
export const resolve_fixture_path = (filename: string, import_meta_url: string): string =>
	resolve(dirname(fileURLToPath(import_meta_url)), filename);

/**
 * Compare live surface against a committed snapshot JSON file.
 *
 * Failure message instructs the developer to run `gro gen` to update the
 * snapshot — every fuz_app consumer wires the snapshot through a `*.gen.ts`
 * file so regeneration goes through the same pipeline as the rest of the
 * generated artifacts.
 *
 * @param surface - the live surface to check
 * @param snapshot_path - absolute path to the committed JSON snapshot
 * @throws AssertionError if the live surface does not deep-equal the snapshot,
 *   or `Error` if the snapshot file is unreadable / malformed JSON.
 */
export const assert_surface_matches_snapshot = (
	surface: AppSurface,
	snapshot_path: string
): void => {
	const committed = JSON.parse(readFileSync(snapshot_path, 'utf-8'));
	assert.deepStrictEqual(
		surface,
		committed,
		'Attack surface changed! Run `gro gen` to update the snapshot, then review the diff.'
	);
};

/**
 * Verify surface generation is deterministic (build twice, compare).
 */
export const assert_surface_deterministic = (build_surface: () => AppSurface): void => {
	assert.deepStrictEqual(build_surface(), build_surface());
};

/**
 * Bidirectional check: no unexpected public routes, no missing expected ones.
 *
 * @param surface - the app surface to check
 * @param expected_public - format: `['GET /health', 'POST /api/account/login']`
 * @throws AssertionError if the live surface has public routes not in
 *   `expected_public`, or if any entry in `expected_public` is missing from
 *   the live surface.
 */
export const assert_only_expected_public_routes = (
	surface: AppSurface,
	expected_public: Array<string>
): void => {
	const expected = new Set(expected_public);
	const actual_public = surface.routes
		.filter((r) => is_public_auth(r.auth))
		.map((r) => format_route_key(r));

	const unexpected = actual_public.filter((r) => !expected.has(r));
	const missing = expected_public.filter((r) => !actual_public.includes(r));

	assert.strictEqual(unexpected.length, 0, `Unexpected public routes: ${unexpected.join(', ')}`);
	assert.strictEqual(missing.length, 0, `Expected public routes missing: ${missing.join(', ')}`);
};

/**
 * Look up the error schema for a route+status in its error map.
 *
 * @param lookup - map from `"METHOD /path"` to each route's error map (`AppSurfaceSpec.route_error_maps`)
 * @param route - the surface route to look up
 * @param status - HTTP status code
 * @returns the `@fuzdev/fuz_schema` schema for that route+status, or
 *   `undefined` when no error schema is declared for the status code
 */
export const get_route_error_schema = (
	lookup: ReadonlyMap<string, RouteErrorMap>,
	route: AppSurfaceRoute,
	status: number
): AnySchema | undefined => {
	return lookup.get(format_route_key(route))?.schemas[status];
};

/**
 * Assert that a route declares an error — its status, and its `error` code
 * at that status — and that the body parses against the route's schema there.
 * The schema at a status is a union of its definitions' bodies, each
 * `error` a `literal` of its code for a definition made by `rest_error`
 * (`to_error_schemas`), so a code the route
 * doesn't declare at the status fails the parse.
 *
 * Protected routes should always have auto-derived error schemas (401 for authenticated,
 * 403 for role-restricted). A missing schema indicates a gap in error schema derivation.
 *
 * @param lookup - map from `"METHOD /path"` to each route's error map (`AppSurfaceSpec.route_error_maps`)
 * @param route - the surface route to validate against
 * @param status - expected HTTP status code
 * @param body - the parsed response body to validate
 * @throws AssertionError if no schema is declared for the route+status pair.
 * @throws Error if the body does not satisfy the declared schema, a code the
 *   route doesn't declare at the status included, its message carrying the
 *   failed parse's issues (`parse`).
 */
export const assert_error_schema_valid = (
	lookup: ReadonlyMap<string, RouteErrorMap>,
	route: AppSurfaceRoute,
	status: number,
	body: unknown
): void => {
	const key = format_route_key(route);
	const schema = get_route_error_schema(lookup, route, status);
	assert.ok(schema, `missing error schema for ${status} on ${key}`);
	const result = parse(schema, body);
	if (!result.ok) {
		throw new Error(
			`error schema mismatch for ${status} on ${key} (error ${JSON.stringify((body as { error?: unknown } | null)?.error)}): ${JSON.stringify(result.issues)}`
		);
	}
};

/**
 * Assert that a response is not an error its route leaves undeclared: a JSON
 * body at an error status must be at a status the route's error map declares
 * and parse against it, by the rule the DEV error check runs
 * (`check_route_error` — a 500 `internal_error` and a 503
 * `service_unavailable` always accepted, a JSON-RPC error envelope on a
 * `jsonrpc` route not a REST error body). A success status or a non-JSON
 * response passes.
 *
 * @param errors - the route's error map
 * @param jsonrpc - whether the route answers JSON-RPC envelopes (`RouteSpec.jsonrpc`)
 * @param response - the response, read through a clone
 * @param label - what names the request in a failure
 * @throws Error on a JSON error the route's map doesn't declare
 */
export const assert_error_response_declared = async (
	errors: RouteErrorMap,
	jsonrpc: boolean,
	response: Response,
	label: string
): Promise<void> => {
	if (!is_error_status(response.status)) return;
	if (!is_json_response(response)) return;
	let body: unknown;
	try {
		body = await response.clone().json();
	} catch {
		return;
	}
	const check = check_route_error(errors, response.status, body, jsonrpc);
	if (!check.ok) {
		throw new Error(
			`${format_route_error_check(check, response.status, label)}: ${JSON.stringify(
				check.kind === 'schema_mismatch' ? check.issues : body
			)}`
		);
	}
};

/**
 * Verify every route under a path prefix has the exact expected middleware
 * stack, less the layers that carve it out.
 *
 * A route's expected stack is `expected_middleware` in order, without each
 * name whose surface layers carve the route out: a layer of that name whose
 * `path` applies to the route and one of whose `carve_outs` does too
 * (`middleware_carves_out`), with no other layer of the name running on it
 * (`middleware_spec_applies`) — the rule the surface's `applicable_middleware`
 * and the route error map read. Anything else is held exactly: a route
 * missing a name no carve-out explains fails, and so does a carved-out route
 * still listing the name.
 *
 * @param surface - the app surface to check
 * @param path_prefix - prefix to filter routes (e.g. `'/api/'`)
 * @param expected_middleware - the full middleware names in order
 * @throws AssertionError if no routes match `path_prefix`, or if any matching
 *   route's `applicable_middleware` does not deep-equal its expected stack
 */
export const assert_full_middleware_stack = (
	surface: AppSurface,
	path_prefix: string,
	expected_middleware: Array<string>
): void => {
	const routes = surface.routes.filter((r) => r.path.startsWith(path_prefix));
	assert.ok(routes.length > 0, `No routes found under ${path_prefix}`);
	const is_carved_out = (name: string, route_path: string): boolean => {
		const layers = surface.middleware.filter((m) => m.name === name);
		return (
			layers.some(
				(m) => middleware_applies(m.path, route_path) && middleware_carves_out(m, route_path)
			) && !layers.some((m) => middleware_spec_applies(m, route_path))
		);
	};
	for (const route of routes) {
		const carved = expected_middleware.filter((name) => is_carved_out(name, route.path));
		const expected = expected_middleware.filter((name) => !carved.includes(name));
		assert.deepStrictEqual(
			route.applicable_middleware,
			expected,
			`${route.method} ${route.path} has wrong middleware stack${
				carved.length > 0 ? ` (carved out of ${carved.join(', ')})` : ''
			}`
		);
	}
};
