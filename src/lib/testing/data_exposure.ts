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
 * @module
 */

import {describe, test, beforeAll, afterAll, assert} from 'vitest';

import type {AppSurface, AppSurfaceSpec} from '../http/surface.js';
import type {RouteSpec} from '../http/route_spec.js';
import type {AppServerContext, AppServerOptions} from '../server/app_server.js';
import type {SessionOptions} from '../auth/session_cookie.js';
import {ROLE_ADMIN} from '../auth/role_schema.js';
import {create_test_app, type TestApp, type TestAccount} from './app_server.js';
import {create_pglite_factory, type DbFactory} from './db.js';
import {resolve_valid_path, generate_valid_body} from './schema_generators.js';
import {run_migrations} from '../db/migrate.js';
import {AUTH_MIGRATION_NS} from '../auth/migrations.js';
import type {Db} from '../db/db.js';
import {is_null_schema, is_strict_object_schema} from '../http/schema_helpers.js';
import {
	SENSITIVE_FIELD_BLOCKLIST,
	ADMIN_ONLY_FIELD_BLOCKLIST,
	assert_no_sensitive_fields_in_json,
} from './integration_helpers.js';

// --- Schema introspection ---

/**
 * Recursively collect all property names from a JSON Schema.
 *
 * Walks `properties`, `items`, `allOf`/`anyOf`/`oneOf`, and
 * `additionalProperties` to find every declared field name at any depth.
 *
 * @param schema - JSON Schema object
 * @returns set of all property names found
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
 *
 * @param surface - the app surface to check
 * @param sensitive_fields - field names to flag
 */
export const assert_output_schemas_no_sensitive_fields = (
	surface: AppSurface,
	sensitive_fields: ReadonlyArray<string> = SENSITIVE_FIELD_BLOCKLIST,
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
 *
 * @param surface - the app surface to check
 * @param admin_only_fields - field names that are admin-only
 */
export const assert_non_admin_schemas_no_admin_fields = (
	surface: AppSurface,
	admin_only_fields: ReadonlyArray<string> = ADMIN_ONLY_FIELD_BLOCKLIST,
): void => {
	const non_admin = surface.routes.filter(
		(r) => r.auth.type !== 'keeper' && !(r.auth.type === 'role' && r.auth.role === 'admin'),
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
	/** Build the app surface spec (for schema-level checks). */
	build: () => AppSurfaceSpec;
	/** Session config for runtime tests. */
	session_options: SessionOptions<string>;
	/** Route spec factory for runtime tests. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/** Fields that must never appear in any response. Default: `SENSITIVE_FIELD_BLOCKLIST`. */
	sensitive_fields?: ReadonlyArray<string>;
	/** Fields that must not appear in non-admin responses. Default: `ADMIN_ONLY_FIELD_BLOCKLIST`. */
	admin_only_fields?: ReadonlyArray<string>;
	/** Optional overrides for `AppServerOptions`. */
	app_options?: Partial<
		Omit<AppServerOptions, 'backend' | 'session_options' | 'create_route_specs'>
	>;
	/** Database factories to run tests against. Default: pglite only. */
	db_factories?: Array<DbFactory>;
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
 *
 * @param options - test configuration
 */
export const describe_data_exposure_tests = (options: DataExposureTestOptions): void => {
	const {
		build,
		sensitive_fields = SENSITIVE_FIELD_BLOCKLIST,
		admin_only_fields = ADMIN_ONLY_FIELD_BLOCKLIST,
	} = options;

	describe('data exposure — schema-level', () => {
		const {surface} = build();

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

	describe_data_exposure_runtime_tests(options);
};

// --- Runtime tests ---

const describe_data_exposure_runtime_tests = (options: DataExposureTestOptions): void => {
	const {
		sensitive_fields = SENSITIVE_FIELD_BLOCKLIST,
		admin_only_fields = ADMIN_ONLY_FIELD_BLOCKLIST,
	} = options;
	const skip_set = new Set(options.skip_routes);

	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, [AUTH_MIGRATION_NS]);
	};
	const factories = options.db_factories ?? [create_pglite_factory(init_schema)];

	for (const factory of factories) {
		describe(`data exposure — runtime (${factory.name})`, () => {
			if (factory.skip) return;

			let test_app: TestApp;
			let authed_account: TestAccount;
			let admin_account: TestAccount;
			let db: Db;

			beforeAll(async () => {
				db = await factory.create();
				test_app = await create_test_app({
					session_options: options.session_options,
					create_route_specs: options.create_route_specs,
					db,
					app_options: options.app_options,
				});
				authed_account = await test_app.create_account({
					username: 'exposure_authed',
					roles: [],
				});
				admin_account = await test_app.create_account({
					username: 'exposure_admin',
					roles: [ROLE_ADMIN],
				});
			});

			afterAll(async () => {
				await test_app.cleanup();
				await factory.close(db);
			});

			// Tests that don't fire authenticated requests run first — they don't
			// invalidate sessions and are independent of test order.

			test('unauthenticated error responses contain no sensitive fields', async () => {
				const protected_specs = test_app.route_specs.filter((s) => s.auth.type !== 'none');

				for (const spec of protected_specs) {
					const route_key = `${spec.method} ${spec.path}`;
					if (skip_set.has(route_key)) continue;

					const url = resolve_valid_path(spec.path, spec.params);

					// eslint-disable-next-line no-await-in-loop
					const res = await test_app.app.request(url, {
						method: spec.method,
						headers: {host: 'localhost', origin: 'http://localhost:5173'},
					});

					if (res.headers.get('Content-Type')?.includes('text/event-stream')) {
						await res.body?.cancel(); // eslint-disable-line no-await-in-loop
						continue;
					}

					let error_body: unknown;
					try {
						error_body = await res.clone().json(); // eslint-disable-line no-await-in-loop
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
				const admin_specs = test_app.route_specs.filter(
					(s) => s.auth.type === 'role' && s.auth.role === 'admin',
				);

				for (const spec of admin_specs) {
					const route_key = `${spec.method} ${spec.path}`;
					if (skip_set.has(route_key)) continue;

					const url = resolve_valid_path(spec.path, spec.params);
					const headers = authed_account.create_session_headers();

					// eslint-disable-next-line no-await-in-loop
					const res = await test_app.app.request(url, {
						method: spec.method,
						headers,
					});

					assert.strictEqual(res.status, 403, `${route_key} should return 403 for non-admin user`);

					let error_body: unknown;
					try {
						error_body = await res.clone().json(); // eslint-disable-line no-await-in-loop
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
				const sorted_specs = [...test_app.route_specs].sort((a, b) => {
					if (a.method === 'GET' && b.method !== 'GET') return -1;
					if (a.method !== 'GET' && b.method === 'GET') return 1;
					return 0;
				});

				for (const spec of sorted_specs) {
					const route_key = `${spec.method} ${spec.path}`;
					if (skip_set.has(route_key)) continue;

					// keeper auth (daemon token) is strictly more privileged than admin
					const is_elevated =
						spec.auth.type === 'keeper' ||
						(spec.auth.type === 'role' && spec.auth.role === 'admin');
					const url = resolve_valid_path(spec.path, spec.params);
					const body = generate_valid_body(spec.input);
					const headers = pick_auth_headers(spec, test_app, authed_account, admin_account);

					const request_init: RequestInit = {
						method: spec.method,
						headers: {
							...headers,
							...(body ? {'content-type': 'application/json'} : {}),
						},
						...(body ? {body: JSON.stringify(body)} : {}),
					};

					const res = await test_app.app.request(url, request_init); // eslint-disable-line no-await-in-loop

					if (res.headers.get('Content-Type')?.includes('text/event-stream')) {
						await res.body?.cancel(); // eslint-disable-line no-await-in-loop
						continue;
					}

					if (!res.ok) continue;

					let response_body: unknown;
					try {
						response_body = await res.clone().json(); // eslint-disable-line no-await-in-loop
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
					if (
						!is_elevated &&
						!is_null_schema(spec.output) &&
						is_strict_object_schema(spec.output)
					) {
						assert_no_sensitive_fields_in_json(
							response_body,
							admin_only_fields,
							`non-admin ${route_key} (${res.status})`,
						);
					}
				}
			});
		});
	}
};

/**
 * Pick auth headers matching a route spec's auth requirement.
 */
const pick_auth_headers = (
	spec: RouteSpec,
	test_app: TestApp,
	authed_account: TestAccount,
	admin_account: TestAccount,
): Record<string, string> => {
	switch (spec.auth.type) {
		case 'none':
			return {host: 'localhost', origin: 'http://localhost:5173'};
		case 'authenticated':
			return authed_account.create_session_headers();
		case 'role':
			if (spec.auth.role === ROLE_ADMIN) {
				return admin_account.create_session_headers();
			}
			// keeper role uses the bootstrapped account
			return test_app.create_session_headers();
		case 'keeper':
			return test_app.create_bearer_headers();
	}
};
