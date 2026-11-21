import './assert_dev_env.ts';

/**
 * Adversarial 404 testing for routes with params and declared 404 error schemas.
 *
 * Creates stub handlers that return 404 with the declared error code and
 * fields generated from its body schema, fires requests with
 * valid-format-but-nonexistent params (nil UUIDs), and validates response
 * bodies against the route's declared 404.
 *
 * No DB needed — tests schema conformance of 404 responses, not real handlers.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';

import type { RouteSpec } from '../http/route_spec.ts';
import type { RestErrorDef } from '../http/error_schemas.ts';
import { route_fail } from '../http/route_result.ts';
import { format_route_key } from '../http/surface_query.ts';
import { format_issues } from '../schema_issues.ts';
import { is_null_schema } from '../http/schema_helpers.ts';
import { assert_error_schema_valid } from './assertions.ts';
import { create_auth_test_apps, create_route_skip_filter, select_auth_app } from './auth_apps.ts';
import type { AdversarialTestOptions } from './attack_surface.ts';
import {
	resolve_valid_path,
	generate_valid_body,
	generate_valid_object,
	to_route_content_type
} from './schema_generators.ts';

/**
 * Generate adversarial 404 response validation tests.
 *
 * For each route with `params` and a 404 definition of its own in `errors`:
 * 1. Creates a stub handler returning 404 with the first such definition's
 *    code and its body's fields, generated from its schema (`generate_valid_object`)
 * 2. Fires a request with valid-format params (nil UUIDs for UUID params)
 * 3. Validates response status is 404
 * 4. Validates the code is one the route's error map (`resolve_route_error_map`)
 *    declares at 404, and the body parses against its 404 (`assert_error_schema_valid`)
 *
 * @param options - the app surface builder, roles, skips, and param values
 * @throws Error at collection when a definition's fields can't be generated
 *   to pass its body schema, naming the route
 */
export const describe_adversarial_404 = (options: AdversarialTestOptions): void => {
	const { build, roles } = options;
	const { surface, route_specs, route_error_maps } = build();
	const is_skipped = create_route_skip_filter(options.skip_routes);

	// Build spec lookup for schema access
	const spec_lookup: Map<string, RouteSpec> = new Map();
	for (const spec of route_specs) {
		spec_lookup.set(format_route_key(spec), spec);
	}

	// Find testable routes: params + a 404 definition of the route's own
	const testable: Array<{
		key: string;
		not_found: RestErrorDef;
		fields: Record<string, unknown>;
		spec: RouteSpec;
	}> = [];
	for (const route of surface.routes) {
		if (route.params_schema === null) continue;
		if (!route.error_schemas || !('404' in route.error_schemas)) continue;

		if (is_skipped(route)) continue;
		const key = format_route_key(route);
		const spec = spec_lookup.get(key);
		if (!spec?.params) continue;
		const not_found = spec.errors?.find((def) => def.status === 404);
		if (!not_found) continue;

		testable.push({ key, not_found, fields: generate_not_found_fields(key, not_found), spec });
	}

	if (testable.length === 0) return;

	describe('adversarial 404 response validation', () => {
		// Create stub specs: replace handlers for testable routes with 404 stubs
		const testable_by_key: Map<string, (typeof testable)[number]> = new Map();
		for (const entry of testable) {
			testable_by_key.set(entry.key, entry);
		}
		const stub_specs = route_specs.map((spec): RouteSpec => {
			const entry = testable_by_key.get(format_route_key(spec));
			if (!entry) return spec;
			const { not_found, fields } = entry;
			return { ...spec, handler: () => route_fail(not_found, fields) };
		});

		const apps = create_auth_test_apps(stub_specs, roles);

		for (const { key, not_found, spec } of testable) {
			const error_code = not_found.code;
			test(key, async () => {
				const route = surface.routes.find((r) => format_route_key(r) === key)!;
				const app = select_auth_app(apps, route.auth);
				const url = resolve_valid_path(route.path, spec.params, options.param_values?.[key]);

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
				assert_error_schema_valid(route_error_maps, route, 404, body);
			});
		}
	});
};

/**
 * The fields of a 404 body beside `error`, generated from the definition's
 * schema, so a definition requiring a field (a `message`) gets a body its
 * own schema accepts.
 *
 * @param key - the route's `METHOD path`, named in the error
 * @param not_found - the route's 404 definition
 * @returns the body's fields, `error` left to `route_fail`
 * @throws Error when the generated body fails the definition's schema
 */
const generate_not_found_fields = (
	key: string,
	not_found: RestErrorDef
): Record<string, unknown> => {
	const { value, result } = generate_valid_object(not_found.schema, not_found.schema);
	if (!result.ok) {
		throw new Error(
			`describe_adversarial_404: can't generate the fields of ${key}'s 404 ` +
				`'${not_found.code}': ${format_issues(result.issues)}`
		);
	}
	const { error: _error, ...fields } = value;
	return fields;
};
