import './assert_dev_env.ts';

/**
 * Adversarial 404 testing for routes with params and declared 404 error schemas.
 *
 * Creates stub handlers that return 404 with the declared error code,
 * fires requests with valid-format-but-nonexistent params (nil UUIDs),
 * and validates response bodies against the declared 404 Zod schemas.
 *
 * No DB needed — tests schema conformance of 404 responses, not real handlers.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';
import { z } from 'zod';
import { is_schema } from '@fuzdev/fuz_schema/schema.ts';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';

import type { RouteSpec } from '../http/route_spec.ts';
import { is_null_schema } from '../http/schema_helpers.ts';
import type { ValidationSchema } from '../schema_issues.ts';
import { create_auth_test_apps, create_route_skip_filter, select_auth_app } from './auth_apps.ts';
import type { AdversarialTestOptions } from './attack_surface.ts';
import {
	resolve_valid_path,
	generate_valid_body,
	to_route_content_type
} from './schema_generators.ts';

/**
 * Extract the error code from a 404 error schema, Zod or `@fuzdev/fuz_schema`,
 * for use in the stub handler.
 *
 * Reads the schema's output-side JSON Schema with `unrepresentable: 'any'`,
 * so a field JSON Schema can't say (a transform, a `z.custom()`) beside
 * `error` doesn't hide the code. Supports a literal (`{const: '...'}`) and an
 * enum (`{enum: [...]}`, uses first value); `null` when `error` is neither.
 * A schema either emitter refuses outright throws.
 *
 * @param schema - a route's declared 404 error schema
 * @returns the code the stub handler answers with, or `null`
 */
export const extract_404_error_code = (schema: ValidationSchema): string | null => {
	const json = (
		is_schema(schema)
			? to_json_schema(schema, { unrepresentable: 'any' })
			: z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any' })
	) as Record<string, unknown>;
	if (json.type !== 'object' || !json.properties || typeof json.properties !== 'object')
		return null;
	const props = json.properties as Record<string, unknown>;
	if (!props.error || typeof props.error !== 'object') return null;
	const error_schema = props.error as Record<string, unknown>;
	if (typeof error_schema.const === 'string') return error_schema.const;
	if (Array.isArray(error_schema.enum) && typeof error_schema.enum[0] === 'string')
		return error_schema.enum[0];
	return null;
};

/**
 * Generate adversarial 404 response validation tests.
 *
 * For each route with `params` + 404 in `error_schemas`:
 * 1. Creates a stub handler returning 404 with the declared error code
 * 2. Fires a request with valid-format params (nil UUIDs for UUID params)
 * 3. Validates response status is 404
 * 4. Validates response body matches the declared 404 Zod schema
 */
export const describe_adversarial_404 = (options: AdversarialTestOptions): void => {
	const { build, roles } = options;
	const { surface, route_specs } = build();
	const is_skipped = create_route_skip_filter(options.skip_routes);

	// Build spec lookup for Zod schema access
	const spec_lookup: Map<string, RouteSpec> = new Map();
	for (const spec of route_specs) {
		spec_lookup.set(`${spec.method} ${spec.path}`, spec);
	}

	// Find testable routes: params + 404 + extractable error code
	const testable: Array<{ key: string; error_code: string; spec: RouteSpec }> = [];
	for (const route of surface.routes) {
		if (route.params_schema === null) continue;
		if (!route.error_schemas || !('404' in route.error_schemas)) continue;

		if (is_skipped(route)) continue;
		const key = `${route.method} ${route.path}`;
		const spec = spec_lookup.get(key);
		if (!spec?.params || !spec.errors?.[404]) continue;

		const error_code = extract_404_error_code(spec.errors[404]);
		if (!error_code) continue;

		testable.push({ key, error_code, spec });
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
				// Validate against declared 404 Zod schema
				spec.errors![404]!.parse(body);
			});
		}
	});
};
