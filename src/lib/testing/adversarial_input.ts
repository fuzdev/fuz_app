import './assert_dev_env.ts';

/**
 * Adversarial input validation testing for route specs.
 *
 * Fires the payloads `adversarial_input_cases.ts` generates against a test
 * app and asserts 400 responses before handlers are reached.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';
import type { RouteSpec } from '../http/route_spec.ts';
import {
	filter_routes_with_input,
	filter_routes_with_params,
	filter_routes_with_query
} from '../http/surface_query.ts';
import {
	ValidationError,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_ROUTE_PARAMS,
	ERROR_INVALID_QUERY_PARAMS
} from '../http/error_schemas.ts';
import { create_auth_test_apps, create_route_skip_filter, select_auth_app } from './auth_apps.ts';
import type { AdversarialTestOptions } from './attack_surface.ts';
import { resolve_valid_path, to_route_content_type } from './schema_generators.ts';
import {
	generate_input_test_cases,
	generate_params_test_cases,
	generate_query_test_cases
} from './adversarial_input_cases.ts';

// --- URL helpers ---

/** Build a URL path with adversarial param values. */
const build_fuzz_url = (route_path: string, params: Record<string, string>): string => {
	let url = route_path;
	for (const [key, value] of Object.entries(params)) {
		url = url.replace(`:${key}`, encodeURIComponent(value));
	}
	return url;
};

/** Build a URL with query string parameters. */
const build_query_url = (path: string, query: Record<string, string>): string => {
	const search = new URLSearchParams(query).toString();
	return search ? `${path}?${search}` : path;
};

// --- Test runner ---

/**
 * Generate adversarial input validation test suites.
 *
 * Tests input body validation and params validation for all routes.
 * Uses correct auth credentials so auth guards pass and validation
 * middleware is actually exercised.
 */
export const describe_adversarial_input = (options: AdversarialTestOptions): void => {
	const { build, roles } = options;
	const { surface, route_specs } = build();
	const is_skipped = create_route_skip_filter(options.skip_routes);

	const routes_with_input = filter_routes_with_input(surface).filter((r) => !is_skipped(r));
	const routes_with_params = filter_routes_with_params(surface).filter((r) => !is_skipped(r));
	const routes_with_query = filter_routes_with_query(surface).filter((r) => !is_skipped(r));

	if (
		routes_with_input.length === 0 &&
		routes_with_params.length === 0 &&
		routes_with_query.length === 0
	)
		return;

	// lookup RouteSpec by method+path for Zod schema access
	const spec_lookup: Map<string, RouteSpec> = new Map();
	for (const spec of route_specs) {
		spec_lookup.set(`${spec.method} ${spec.path}`, spec);
	}

	const apps = create_auth_test_apps(route_specs, roles);

	describe('adversarial input validation', () => {
		// --- Input body tests ---

		if (routes_with_input.length > 0) {
			// every surface route with input must have a matching RouteSpec
			const missing_specs = routes_with_input
				.map((r) => `${r.method} ${r.path}`)
				.filter((key) => !spec_lookup.has(key));
			if (missing_specs.length > 0) {
				throw new Error(
					`adversarial_input: surface routes with input have no matching RouteSpec: ${missing_specs.join(
						', '
					)}`
				);
			}

			let input_test_count = 0;

			describe('input body', () => {
				for (const route of routes_with_input) {
					const key = `${route.method} ${route.path}`;
					const spec = spec_lookup.get(key)!;

					const test_cases = generate_input_test_cases(spec.input);
					if (test_cases.length === 0) continue;
					input_test_count += test_cases.length;

					const app = select_auth_app(apps, route.auth);
					const base_url = resolve_valid_path(route.path, spec.params);
					const is_get = route.method === 'GET';

					describe(key, () => {
						for (const tc of test_cases) {
							test(tc.label, async () => {
								let res: Response;
								if (is_get) {
									// GET routes with non-null input use ?params= query string (RPC convention)
									const params_json = JSON.stringify(tc.body);
									const url = `${base_url}?params=${encodeURIComponent(params_json)}`;
									res = await app.request(url, { method: 'GET' });
								} else {
									res = await app.request(base_url, {
										method: route.method,
										headers: { 'Content-Type': 'application/json' },
										body: JSON.stringify(tc.body)
									});
								}
								assert.strictEqual(
									res.status,
									400,
									`Expected 400 for ${key} [${tc.label}], got ${res.status}`
								);
								const body = await res.json();
								// GET RPC: valid-but-wrong-shape JSON (e.g. array) fails schema validation
								// (ERROR_INVALID_REQUEST_BODY), not JSON parsing (ERROR_INVALID_JSON_BODY)
								const expected_error =
									is_get && tc.expected_error === ERROR_INVALID_JSON_BODY
										? ERROR_INVALID_REQUEST_BODY
										: tc.expected_error;
								assert.strictEqual(
									body.error,
									expected_error,
									`Expected ${expected_error} for ${key} [${tc.label}], got: ${body.error}`
								);
								// validate response body structure matches error schema
								if (tc.expected_error === 'invalid_request_body') {
									ValidationError.parse(body);
								}
							});
						}
					});
				}

				test('generated input test cases', () => {
					assert.ok(
						input_test_count > 0,
						'No input test cases generated — schema walking may be broken'
					);
				});
			});
		}

		// --- Params tests ---

		if (routes_with_params.length > 0) {
			let params_test_count = 0;

			describe('params', () => {
				for (const route of routes_with_params) {
					const key = `${route.method} ${route.path}`;
					const spec = spec_lookup.get(key);
					if (!spec?.params) continue;

					const test_cases = generate_params_test_cases(spec.params);
					if (test_cases.length === 0) continue;
					params_test_count += test_cases.length;

					const app = select_auth_app(apps, route.auth);

					describe(key, () => {
						for (const tc of test_cases) {
							test(tc.label, async () => {
								const url = build_fuzz_url(route.path, tc.params);
								const res = await app.request(url, {
									method: route.method,
									headers: { 'content-type': to_route_content_type(route) }
								});
								assert.strictEqual(
									res.status,
									400,
									`Expected 400 for ${key} [${tc.label}], got ${res.status}`
								);
								const body = await res.json();
								assert.strictEqual(
									body.error,
									ERROR_INVALID_ROUTE_PARAMS,
									`Expected ${ERROR_INVALID_ROUTE_PARAMS} for ${key} [${tc.label}], got: ${
										body.error
									}`
								);
								// validate response body structure matches error schema
								ValidationError.parse(body);
							});
						}
					});
				}

				// params coverage check is softer — not all param routes have format constraints
				if (params_test_count === 0) {
					test('no params test cases generated (all params unconstrained)', () => {
						// informational — unconstrained string params accept any value
						assert.ok(true);
					});
				}
			});
		}

		// --- Query tests ---

		if (routes_with_query.length > 0) {
			let query_test_count = 0;

			describe('query params', () => {
				for (const route of routes_with_query) {
					const key = `${route.method} ${route.path}`;
					const spec = spec_lookup.get(key);
					if (!spec?.query) continue;

					const test_cases = generate_query_test_cases(spec.query);
					if (test_cases.length === 0) continue;
					query_test_count += test_cases.length;

					const app = select_auth_app(apps, route.auth);
					const base_url = resolve_valid_path(route.path, spec.params);

					describe(key, () => {
						for (const tc of test_cases) {
							test(tc.label, async () => {
								const url = build_query_url(base_url, tc.query);
								const res = await app.request(url, {
									method: route.method,
									headers: { 'content-type': to_route_content_type(route) }
								});
								assert.strictEqual(
									res.status,
									400,
									`Expected 400 for ${key} [${tc.label}], got ${res.status}`
								);
								const body = await res.json();
								assert.strictEqual(
									body.error,
									ERROR_INVALID_QUERY_PARAMS,
									`Expected ${ERROR_INVALID_QUERY_PARAMS} for ${key} [${tc.label}], got: ${
										body.error
									}`
								);
								// validate response body structure matches error schema
								ValidationError.parse(body);
							});
						}
					});
				}

				// query coverage check is softer — not all query routes have format constraints
				if (query_test_count === 0) {
					test('no query test cases generated (all query params unconstrained)', () => {
						// informational — unconstrained string query params accept any value
						assert.ok(true);
					});
				}
			});
		}
	});
};
