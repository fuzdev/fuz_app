import './assert_dev_env.ts';

/**
 * Adversarial 404 testing for routes with params and declared 404 error schemas.
 *
 * Creates stub handlers that return 404 with the declared error code,
 * fires requests with valid-format-but-nonexistent params (nil UUIDs),
 * and validates response bodies against the route's declared 404.
 *
 * No DB needed — tests schema conformance of 404 responses, not real handlers.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';

import type { RouteSpec } from '../http/route_spec.ts';
import { is_null_schema } from '../http/schema_helpers.ts';
import { assert_error_schema_valid } from './assertions.ts';
import { create_auth_test_apps, create_route_skip_filter, select_auth_app } from './auth_apps.ts';
import type { AdversarialTestOptions } from './attack_surface.ts';
import {
	resolve_valid_path,
	generate_valid_body,
	to_route_content_type
} from './schema_generators.ts';

/**
 * Generate adversarial 404 response validation tests.
 *
 * For each route with `params` and a 404 definition of its own in `errors`:
 * 1. Creates a stub handler returning 404 with the first such definition's code
 * 2. Fires a request with valid-format params (nil UUIDs for UUID params)
 * 3. Validates response status is 404
 * 4. Validates the code is one the route's error map (`resolve_route_errors`)
 *    declares at 404, and the body parses against its 404 (`assert_error_schema_valid`)
 */
export const describe_adversarial_404 = (options: AdversarialTestOptions): void => {
	const { build, roles } = options;
	const { surface, route_specs, route_errors } = build();
	const is_skipped = create_route_skip_filter(options.skip_routes);

	// Build spec lookup for schema access
	const spec_lookup: Map<string, RouteSpec> = new Map();
	for (const spec of route_specs) {
		spec_lookup.set(`${spec.method} ${spec.path}`, spec);
	}

	// Find testable routes: params + a 404 definition of the route's own
	const testable: Array<{ key: string; error_code: string; spec: RouteSpec }> = [];
	for (const route of surface.routes) {
		if (route.params_schema === null) continue;
		if (!route.error_schemas || !('404' in route.error_schemas)) continue;

		if (is_skipped(route)) continue;
		const key = `${route.method} ${route.path}`;
		const spec = spec_lookup.get(key);
		if (!spec?.params) continue;
		const not_found = spec.errors?.find((def) => def.status === 404);
		if (!not_found) continue;

		testable.push({ key, error_code: not_found.code, spec });
	}

	if (testable.length === 0) return;

	describe('adversarial 404 response validation', () => {
		// Create stub specs: replace handlers for testable routes with 404 stubs
		const error_code_by_key: Map<string, string> = new Map();
		for (const entry of testable) {
			error_code_by_key.set(entry.key, entry.error_code);
		}
		const stub_specs = route_specs.map((spec): RouteSpec => {
			const error_code = error_code_by_key.get(`${spec.method} ${spec.path}`);
			if (!error_code) return spec;
			return {
				...spec,
				handler: (c) => c.json({ error: error_code }, 404)
			};
		});

		const apps = create_auth_test_apps(stub_specs, roles);

		for (const { key, error_code, spec } of testable) {
			test(key, async () => {
				const route = surface.routes.find((r) => `${r.method} ${r.path}` === key)!;
				const app = select_auth_app(apps, route.auth);
				const url = resolve_valid_path(route.path, spec.params);

				const request_init: RequestInit = {
					method: route.method,
					headers: { 'content-type': to_route_content_type(spec) }
				};

				// Send valid body for routes with input
				if (!is_null_schema(spec.input)) {
					const body = generate_valid_body(spec.input);
					if (body !== undefined) {
						request_init.body = JSON.stringify(body);
					}
				}

				const res = await app.request(url, request_init);
				assert.strictEqual(res.status, 404, `Expected 404 for ${key}, got ${res.status}`);
				const body = await res.json();
				assert.strictEqual(
					body.error,
					error_code,
					`Expected error '${error_code}' for ${key}, got: ${body.error}`
				);
				// the code is the route's own at 404, and the body its schema there
				assert_error_schema_valid(route_errors, route, 404, body);
			});
		}
	});
};
