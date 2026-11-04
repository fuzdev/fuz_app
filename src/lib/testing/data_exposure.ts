import './assert_dev_env.ts';

/**
 * Composable data exposure test suite.
 *
 * Verifies that sensitive database fields never leak through HTTP responses:
 * - Schema-level: walks the JSON Schema of every route, RPC, and WebSocket
 *   output (both sides of a transform), the params the server pushes over
 *   WebSocket, and every route error schema for sensitive property names,
 *   and non-admin route outputs for admin-only ones
 * - Runtime: fires real requests and checks response bodies against field blocklists
 * - Cross-privilege: verifies admin routes return 403 for non-admin users,
 *   and non-admin responses exclude admin-only fields
 *
 * Cadence: per-describe `setup_test()` call (see `testing/round_trip.ts` module
 * docstring). The runtime body manages its own request ordering (auth-free
 * → cross-privilege → 2xx) to avoid session-invalidation contamination
 * between assertions, so per-test fixture re-creation isn't needed.
 *
 * @module
 */

import { describe, test, beforeAll, assert } from 'vitest';

import type { AppSurfaceSpec } from '../http/surface.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '../auth/role_schema.ts';
import type { TestAccount } from './app_server.ts';
import { create_test_request_headers } from './test_origin.ts';
import {
	resolve_valid_path,
	generate_valid_body,
	to_route_content_type
} from './schema_generators.ts';
import {
	is_null_schema,
	is_strict_object_schema,
	schema_to_surface
} from '../http/schema_helpers.ts';
import { is_keeper_auth, is_public_auth, type RouteAuth } from '../http/auth_shape.ts';
import type { ValidationSchema } from '../schema_issues.ts';
import {
	sensitive_field_blocklist,
	admin_only_field_blocklist,
	assert_no_sensitive_fields_in_json,
	pick_auth_headers
} from './integration_helpers.ts';
import type { SetupTest, TestFixture } from './cross_backend/setup.ts';

// --- Schema introspection ---

/**
 * Recursively collect all property names from a JSON Schema.
 *
 * Walks `properties`, `patternProperties`, `additionalProperties`, `items`,
 * `prefixItems`, `contains`, `allOf`/`anyOf`/`oneOf`, `not`/`if`/`then`/`else`,
 * and the values of `$defs`/`definitions` (where a recursive or registered
 * schema's body sits behind a `$ref`) to find every declared field name at
 * any depth.
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
		// `items` is a schema, or an array of them in older drafts
		for (const key of ['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else']) {
			const sub = obj[key];
			if (Array.isArray(sub)) {
				for (const item of sub) walk(item);
			} else {
				walk(sub);
			}
		}
		for (const key of ['prefixItems', 'allOf', 'anyOf', 'oneOf']) {
			if (Array.isArray(obj[key])) {
				for (const sub of obj[key] as Array<unknown>) walk(sub);
			}
		}
		// schema maps: walk the values, the keys aren't field names
		for (const key of ['patternProperties', '$defs', 'definitions']) {
			const map = obj[key];
			if (map && typeof map === 'object') {
				for (const sub of Object.values(map as Record<string, unknown>)) walk(sub);
			}
		}
	};
	walk(schema);
	return names;
};

// --- Schema-level assertions ---

/**
 * A schema the schema-level checks read as something a caller receives: a
 * route's output, an RPC or WebSocket method's output, or the params of a
 * message the server pushes over WebSocket.
 */
interface OutputSchemaEntry {
	/**
	 * `'METHOD /path'` for a route, `'/path method_name'` for an RPC or WS
	 * method's output, `'/path method_name params'` for a pushed message's params.
	 */
	key: string;
	kind: 'route' | 'rpc' | 'ws';
	schema: ValidationSchema;
	/** Whether only admins or the keeper reach it. */
	elevated: boolean;
}

// any-of roles gate only admins and the keeper when every role is one of them
const is_elevated_roles = (roles: ReadonlyArray<string> | undefined): boolean =>
	!!roles?.length && roles.every((r) => r === ROLE_ADMIN || r === ROLE_KEEPER);

const is_elevated_auth = (auth: RouteAuth | null): boolean =>
	auth !== null && (is_keeper_auth(auth) || is_elevated_roles(auth.roles));

// every schema a caller can receive: route outputs, RPC method outputs, and
// over WS the method outputs plus the params the server pushes — a
// `remote_notification`'s payload, and the request of a `request_response`
// the backend can initiate (`local_call` specs never dispatch over WS, as in
// `generate_app_surface`)
const collect_output_schema_entries = (
	surface_source: AppSurfaceSpec
): Array<OutputSchemaEntry> => {
	const entries: Array<OutputSchemaEntry> = [];
	for (const r of surface_source.route_specs) {
		entries.push({
			key: `${r.method} ${r.path}`,
			kind: 'route',
			schema: r.output,
			elevated: is_elevated_auth(r.auth)
		});
	}
	for (const ep of surface_source.rpc_endpoints) {
		for (const a of ep.actions) {
			entries.push({
				key: `${ep.path} ${a.spec.method}`,
				kind: 'rpc',
				schema: a.spec.output,
				elevated: is_elevated_auth(a.spec.auth)
			});
		}
	}
	for (const ep of surface_source.ws_endpoints) {
		// the upgrade gate holds for every message on the socket
		const endpoint_elevated = is_elevated_roles(ep.required_roles);
		for (const a of ep.actions) {
			const { spec } = a;
			if (spec.kind === 'local_call') continue;
			const params_entry: OutputSchemaEntry = {
				key: `${ep.path} ${spec.method} params`,
				kind: 'ws',
				schema: spec.input,
				// a pushed message reaches every socket on the endpoint
				elevated: endpoint_elevated
			};
			if (spec.kind === 'remote_notification') {
				// its `output` is `z.void()`: the payload is its params
				entries.push(params_entry);
				continue;
			}
			entries.push({
				key: `${ep.path} ${spec.method}`,
				kind: 'ws',
				schema: spec.output,
				elevated: endpoint_elevated || is_elevated_auth(spec.auth)
			});
			if (spec.initiator === 'backend' || spec.initiator === 'both') entries.push(params_entry);
		}
	}
	return entries;
};

// the property names an output schema can carry on each side: its output
// side, as the surface writes it, and its input side — a transform's output
// has no JSON Schema form and is written as `{}` on the output side, so a
// field inside a transformed subtree is only seen on the input side, the
// pre-transform shape and a conservative superset
const collect_output_property_names = (
	entry: OutputSchemaEntry
): { output: Set<string>; input: Set<string> } => ({
	output: collect_json_schema_property_names(
		schema_to_surface(entry.schema, { io: 'output', source: `${entry.key} output` })
	),
	input: collect_json_schema_property_names(
		schema_to_surface(entry.schema, { io: 'input', source: `${entry.key} output (input side)` })
	)
});

const assert_output_entries_exclude = (
	entries: Array<OutputSchemaEntry>,
	fields: ReadonlyArray<string>,
	skip_routes: ReadonlyArray<string> | undefined,
	label: string
): void => {
	const skip_set = new Set(skip_routes);
	for (const entry of entries) {
		if (skip_set.has(entry.key)) continue;
		const names = collect_output_property_names(entry);
		for (const field of fields) {
			assert.ok(!names.output.has(field), `${entry.key}: ${label} '${field}'`);
			assert.ok(
				!names.input.has(field),
				`${entry.key}: ${label} '${field}' on its input side, inside a transformed ` +
					`subtree — if the transform drops it, add '${entry.key}' to skip_routes`
			);
		}
	}
};

/**
 * Assert that no output schema — of a route, an RPC method, or a WebSocket
 * method, or the params of a message the server pushes over WebSocket (a
 * `remote_notification`, or a `request_response` the backend initiates) —
 * contains sensitive field names.
 *
 * Each output is read on both sides (`schema_to_surface`): the output side the
 * surface records, and the input side, since a transform's output has no JSON
 * Schema form and a field inside a transformed subtree shows only there. The
 * input side is a superset, so a transform that deliberately drops a
 * sensitive field is flagged too; skip that output by its key.
 *
 * @param surface_source - the surface with the specs it was generated from
 * @param sensitive_fields - field names no output may carry
 * @param skip_routes - outputs to skip: `'METHOD /path'` for a route, `'/path method_name'` for an RPC or WS method, `'/path method_name params'` for pushed params
 * @throws Error when an output schema can't be written as JSON Schema on either side
 */
export const assert_output_schemas_no_sensitive_fields = (
	surface_source: AppSurfaceSpec,
	sensitive_fields: ReadonlyArray<string> = sensitive_field_blocklist,
	skip_routes?: ReadonlyArray<string>
): void => {
	assert_output_entries_exclude(
		collect_output_schema_entries(surface_source),
		sensitive_fields,
		skip_routes,
		'output schema contains sensitive field'
	);
};

/**
 * Assert that route output schemas a non-admin can reach — routes without an
 * admin or keeper gate — don't contain admin-only field names. Reads both
 * sides of each output, as `assert_output_schemas_no_sensitive_fields` does.
 *
 * Routes only: the default blocklist matches by name (`created_by`,
 * `updated_by`), and RPC and WebSocket methods return domain shapes that
 * carry those columns legitimately (cells, invites a member created).
 *
 * @param surface_source - the surface with the specs it was generated from
 * @param admin_only_fields - field names no non-admin route output may carry
 * @param skip_routes - routes to skip, as `'METHOD /path'`
 * @throws Error when an output schema can't be written as JSON Schema on either side
 */
export const assert_non_admin_schemas_no_admin_fields = (
	surface_source: AppSurfaceSpec,
	admin_only_fields: ReadonlyArray<string> = admin_only_field_blocklist,
	skip_routes?: ReadonlyArray<string>
): void => {
	assert_output_entries_exclude(
		// TODO: replace name-matching with schema identity — flag a non-admin output
		// (route, RPC, or WS) that embeds `AdminAccountJson`, `InviteJson`, or
		// `AppSettingsJson`, which would also cover RPC and WS outputs
		collect_output_schema_entries(surface_source).filter(
			(entry) => !entry.elevated && entry.kind === 'route'
		),
		admin_only_fields,
		skip_routes,
		'non-admin output schema contains admin-only field'
	);
};

// --- Composable suite ---

/** Options for `describe_data_exposure_tests`. */
export interface DataExposureTestOptions {
	/** Per-test fixture-producing function (per-describe cadence). */
	setup_test: SetupTest;
	/**
	 * App surface for schema-level + route-iteration checks. Constructed in
	 * TS by the consumer; same shape for in-process and cross-process tests.
	 */
	surface_source: AppSurfaceSpec;
	/** Fields that must never appear in any response. Default: `sensitive_field_blocklist`. */
	sensitive_fields?: ReadonlyArray<string>;
	/** Fields that must not appear in non-admin responses. Default: `admin_only_field_blocklist`. */
	admin_only_fields?: ReadonlyArray<string>;
	/**
	 * Routes to skip, in `'METHOD /path'` format, and RPC or WebSocket method
	 * outputs to skip in the schema-level checks, as `'/path method_name'`
	 * (`'/path method_name params'` for params the server pushes over WebSocket).
	 */
	skip_routes?: Array<string>;
}

/**
 * Composable data exposure test suite.
 *
 * Three test groups:
 * 1. Schema-level — walk route, RPC, and WebSocket output schemas (both sides
 *    of a transform), pushed WebSocket params, and route error schemas for
 *    sensitive field names, and non-admin route outputs for admin-only ones
 * 2. Runtime — fire real requests and check response bodies against blocklists
 * 3. Cross-privilege — admin routes return 403 for non-admin, error responses
 *    contain no sensitive fields
 */
export const describe_data_exposure_tests = (options: DataExposureTestOptions): void => {
	const { surface, route_specs } = options.surface_source;
	const {
		sensitive_fields = sensitive_field_blocklist,
		admin_only_fields = admin_only_field_blocklist
	} = options;
	const skip_set = new Set(options.skip_routes);

	describe('data exposure — schema-level', () => {
		test('no sensitive fields in any output schema', () => {
			assert_output_schemas_no_sensitive_fields(
				options.surface_source,
				sensitive_fields,
				options.skip_routes
			);
		});

		test('no admin-only fields in non-admin output schemas', () => {
			assert_non_admin_schemas_no_admin_fields(
				options.surface_source,
				admin_only_fields,
				options.skip_routes
			);
		});

		test('no sensitive fields in any error schema', () => {
			for (const route of surface.routes) {
				if (!route.error_schemas) continue;
				for (const [status, schema] of Object.entries(route.error_schemas)) {
					const prop_names = collect_json_schema_property_names(schema);
					for (const field of sensitive_fields) {
						assert.ok(
							!prop_names.has(field),
							`${route.method} ${route.path} error ${status}: contains sensitive field '${field}'`
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
				roles: []
			});
			admin_account = await fixture.create_account({
				username: 'exposure_admin',
				roles: [ROLE_ADMIN]
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
					headers: create_test_request_headers({
						'content-type': to_route_content_type(spec)
					})
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
					`unauthenticated ${route_key} (${res.status})`
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
				const res = await fixture.transport(url, {
					method: spec.method,
					headers: {
						...authed_account.create_session_headers(),
						'content-type': to_route_content_type(spec)
					}
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
				const is_elevated = is_elevated_auth(spec.auth);
				const url = resolve_valid_path(spec.path, spec.params);
				const body = generate_valid_body(spec.input);
				const headers = pick_auth_headers(spec, fixture, authed_account, admin_account);

				const request_init: RequestInit = {
					method: spec.method,
					headers: { ...headers, 'content-type': to_route_content_type(spec) },
					...(body ? { body: JSON.stringify(body) } : {})
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
					`${route_key} (${res.status})`
				);

				// Admin-only field check applies to non-elevated routes with strict
				// output schemas. Loose schemas (e.g. surface route returning JSON
				// Schema representations) may contain admin field names as metadata.
				if (!is_elevated && !is_null_schema(spec.output) && is_strict_object_schema(spec.output)) {
					assert_no_sensitive_fields_in_json(
						response_body,
						admin_only_fields,
						`non-admin ${route_key} (${res.status})`
					);
				}
			}
		});
	});
};
