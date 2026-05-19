import './assert_dev_env.js';

/**
 * Composable data exposure test suite.
 *
 * Verifies that sensitive database fields never leak through HTTP responses:
 * - Schema-level: walks JSON Schema output/error schemas for blocklisted property names
 * - Runtime: fires real requests and checks response bodies against field blocklists
 * - Cross-privilege: verifies admin routes return 403 for non-admin users,
 *   and non-admin responses exclude admin-only fields
 *
 * Cadence: per-describe `setup_test()` call (see `round_trip.ts` module
 * docstring). The runtime body manages its own request ordering (auth-free
 * → cross-privilege → 2xx) to avoid session-invalidation contamination
 * between assertions, so per-test fixture re-creation isn't needed.
 *
 * @module
 */

import {describe, test, beforeAll, assert} from 'vitest';

import type {AppSurface} from '../http/surface.js';
import {ROLE_ADMIN} from '../auth/role_schema.js';
import type {TestAccount} from './app_server.js';
import {resolve_valid_path, generate_valid_body} from './schema_generators.js';
import {is_null_schema, is_strict_object_schema} from '../http/schema_helpers.js';
import {is_keeper_auth, is_public_auth} from '../http/auth_shape.js';
import {
	sensitive_field_blocklist,
	admin_only_field_blocklist,
	assert_no_sensitive_fields_in_json,
	pick_auth_headers,
} from './integration_helpers.js';
import type {BackendCapabilities} from './cross_backend/capabilities.js';
import type {SetupTest, TestFixture} from './cross_backend/setup.js';
import type {SurfaceSource} from './transports/surface_source.js';

// --- Schema introspection ---

/**
 * Recursively collect all property names from a JSON Schema.
 *
 * Walks `properties`, `items`, `allOf`/`anyOf`/`oneOf`, and
 * `additionalProperties` to find every declared field name at any depth.
 */
export const collect_json_schema_property_names = (schema: unknown): Set<string> => {
	const names = new Set<string>();
	const walk = (s: unknown): void => {
		if (s === null || s === undefined || typeof s !== 'object') return;
		const obj = s as Record<string, unknown>;
		if (obj.properties && typeof obj.properties === 'object') {
			for (const [name, prop_schema] of Object.entries(obj.properties as Record<string, unknown>)) {
				names.add(name);
				walk(prop_schema);
			}
		}
		if (obj.items) walk(obj.items);
		for (const key of ['allOf', 'anyOf', 'oneOf']) {
			if (Array.isArray(obj[key])) {
				for (const sub of obj[key] as Array<unknown>) walk(sub);
			}
		}
		if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
			walk(obj.additionalProperties);
		}
	};
	walk(schema);
	return names;
};

// --- Schema-level assertions ---

/**
 * Assert that no output schema in the surface contains sensitive field names.
 */
export const assert_output_schemas_no_sensitive_fields = (
	surface: AppSurface,
	sensitive_fields: ReadonlyArray<string> = sensitive_field_blocklist,
): void => {
	for (const route of surface.routes) {
		if (route.output_schema === null) continue;
		const prop_names = collect_json_schema_property_names(route.output_schema);
		for (const field of sensitive_fields) {
			assert.ok(
				!prop_names.has(field),
				`${route.method} ${route.path}: output schema contains sensitive field '${field}'`,
			);
		}
	}
};

/**
 * Assert that non-admin route output schemas don't contain admin-only fields.
 */
export const assert_non_admin_schemas_no_admin_fields = (
	surface: AppSurface,
	admin_only_fields: ReadonlyArray<string> = admin_only_field_blocklist,
): void => {
	const non_admin = surface.routes.filter(
		(r) => !is_keeper_auth(r.auth) && !(r.auth.roles?.includes('admin') ?? false),
	);
	for (const route of non_admin) {
		if (route.output_schema === null) continue;
		const prop_names = collect_json_schema_property_names(route.output_schema);
		for (const field of admin_only_fields) {
			assert.ok(
				!prop_names.has(field),
				`${route.method} ${route.path}: non-admin output schema contains admin-only field '${field}'`,
			);
		}
	}
};

// --- Composable suite ---

/** Options for `describe_data_exposure_tests`. */
export interface DataExposureTestOptions {
	/** Per-test fixture-producing function (per-describe cadence). */
	setup_test: SetupTest;
	/**
	 * Source of the app surface for schema-level + route-iteration checks.
	 * Currently requires `kind: 'inline'` — the cross-process snapshot
	 * variant lands alongside the spawned-backend transport plumbing.
	 */
	surface_source: SurfaceSource;
	/** Backend capability declarations. */
	capabilities: BackendCapabilities;
	/** Fields that must never appear in any response. Default: `sensitive_field_blocklist`. */
	sensitive_fields?: ReadonlyArray<string>;
	/** Fields that must not appear in non-admin responses. Default: `admin_only_field_blocklist`. */
	admin_only_fields?: ReadonlyArray<string>;
	/** Routes to skip, in `'METHOD /path'` format. */
	skip_routes?: Array<string>;
}

/**
 * Composable data exposure test suite.
 *
 * Three test groups:
 * 1. Schema-level — walk JSON Schema output/error schemas for sensitive field names
 * 2. Runtime — fire real requests and check response bodies against blocklists
 * 3. Cross-privilege — admin routes return 403 for non-admin, error responses
 *    contain no sensitive fields
 */
export const describe_data_exposure_tests = (options: DataExposureTestOptions): void => {
	if (options.surface_source.kind !== 'inline') {
		throw new Error(
			"describe_data_exposure_tests requires surface_source.kind === 'inline' — " +
				'the cross-process snapshot variant lands with the spawned-backend transport',
		);
	}
	const {surface, route_specs} = options.surface_source.spec;
	const {
		sensitive_fields = sensitive_field_blocklist,
		admin_only_fields = admin_only_field_blocklist,
	} = options;
	const skip_set = new Set(options.skip_routes);
	void options.capabilities;

	describe('data exposure — schema-level', () => {
		test('no sensitive fields in any output schema', () => {
			assert_output_schemas_no_sensitive_fields(surface, sensitive_fields);
		});

		test('no admin-only fields in non-admin output schemas', () => {
			assert_non_admin_schemas_no_admin_fields(surface, admin_only_fields);
		});

		test('no sensitive fields in any error schema', () => {
			for (const route of surface.routes) {
				if (!route.error_schemas) continue;
				for (const [status, schema] of Object.entries(route.error_schemas)) {
					const prop_names = collect_json_schema_property_names(schema);
					for (const field of sensitive_fields) {
						assert.ok(
							!prop_names.has(field),
							`${route.method} ${route.path} error ${status}: contains sensitive field '${field}'`,
						);
					}
				}
			}
		});
	});

	describe('data exposure — runtime', () => {
		let fixture: TestFixture;
		let authed_account: TestAccount;
		let admin_account: TestAccount;

		beforeAll(async () => {
			fixture = await options.setup_test();
			authed_account = await fixture.create_account({
				username: 'exposure_authed',
				roles: [],
			});
			admin_account = await fixture.create_account({
				username: 'exposure_admin',
				roles: [ROLE_ADMIN],
			});
		});

		// Tests that don't fire authenticated requests run first — they don't
		// invalidate sessions and are independent of test order.

		test('unauthenticated error responses contain no sensitive fields', async () => {
			const protected_specs = route_specs.filter((s) => !is_public_auth(s.auth));

			for (const spec of protected_specs) {
				const route_key = `${spec.method} ${spec.path}`;
				if (skip_set.has(route_key)) continue;

				const url = resolve_valid_path(spec.path, spec.params);

				const res = await fixture.transport(url, {
					method: spec.method,
					headers: {host: 'localhost', origin: 'http://localhost:5173'},
				});

				if (res.headers.get('Content-Type')?.includes('text/event-stream')) {
					await res.body?.cancel();
					continue;
				}

				let error_body: unknown;
				try {
					error_body = await res.clone().json();
				} catch {
					continue;
				}

				assert_no_sensitive_fields_in_json(
					error_body,
					sensitive_fields,
					`unauthenticated ${route_key} (${res.status})`,
				);
			}
		});

		// Cross-privilege test runs before 2xx tests — admin routes reject
		// without calling handlers, so sessions stay intact.

		test('admin routes return 403 for non-admin user', async () => {
			const admin_specs = route_specs.filter((s) => s.auth.roles?.includes('admin') ?? false);

			for (const spec of admin_specs) {
				const route_key = `${spec.method} ${spec.path}`;
				if (skip_set.has(route_key)) continue;

				const url = resolve_valid_path(spec.path, spec.params);
				const headers = authed_account.create_session_headers();

				const res = await fixture.transport(url, {
					method: spec.method,
					headers,
				});

				assert.strictEqual(res.status, 403, `${route_key} should return 403 for non-admin user`);

				let error_body: unknown;
				try {
					error_body = await res.clone().json();
				} catch {
					continue;
				}

				assert_no_sensitive_fields_in_json(error_body, sensitive_fields, `${route_key} 403`);
			}
		});

		// 2xx tests run last — handlers like logout and session-revoke-all
		// invalidate sessions as a side effect. Sort GET before POST so
		// data-returning routes are checked before destructive routes fire.

		test('all 2xx responses pass field blocklists', async () => {
			// sort GET before mutations to check data-returning routes
			// before destructive routes (logout, revoke-all) invalidate sessions
			const sorted_specs = [...route_specs].sort((a, b) => {
				if (a.method === 'GET' && b.method !== 'GET') return -1;
				if (a.method !== 'GET' && b.method === 'GET') return 1;
				return 0;
			});

			for (const spec of sorted_specs) {
				const route_key = `${spec.method} ${spec.path}`;
				if (skip_set.has(route_key)) continue;

				// keeper auth (daemon token) is strictly more privileged than admin
				const is_elevated =
					is_keeper_auth(spec.auth) || (spec.auth.roles?.includes('admin') ?? false);
				const url = resolve_valid_path(spec.path, spec.params);
				const body = generate_valid_body(spec.input);
				const headers = pick_auth_headers(spec, fixture, authed_account, admin_account);

				const request_init: RequestInit = {
					method: spec.method,
					headers: {
						...headers,
						...(body ? {'content-type': 'application/json'} : {}),
					},
					...(body ? {body: JSON.stringify(body)} : {}),
				};

				const res = await fixture.transport(url, request_init);

				if (res.headers.get('Content-Type')?.includes('text/event-stream')) {
					await res.body?.cancel();
					continue;
				}

				if (!res.ok) continue;

				let response_body: unknown;
				try {
					response_body = await res.clone().json();
				} catch {
					continue;
				}

				assert_no_sensitive_fields_in_json(
					response_body,
					sensitive_fields,
					`${route_key} (${res.status})`,
				);

				// Admin-only field check applies to non-elevated routes with strict
				// output schemas. Loose schemas (e.g. surface route returning JSON
				// Schema representations) may contain admin field names as metadata.
				if (!is_elevated && !is_null_schema(spec.output) && is_strict_object_schema(spec.output)) {
					assert_no_sensitive_fields_in_json(
						response_body,
						admin_only_fields,
						`non-admin ${route_key} (${res.status})`,
					);
				}
			}
		});
	});
};
