/**
 * Tests for the schema-level checks in `testing/data_exposure.ts` — every
 * output kind (route, RPC method, WS method, pushed WS params), both sides of
 * a transform, and the elevation predicate.
 *
 * @module
 */

import { route_raw } from '#lib/http/route_result.ts';
import { describe, test, assert } from 'vitest';
import {
	array,
	lazy,
	literal,
	object,
	pipe,
	string,
	transform,
	void as fuz_void,
	type AnySchema,
	type Schema
} from '@fuzdev/fuz_schema/schema.ts';

import {
	assert_output_schemas_no_sensitive_fields,
	assert_non_admin_schemas_no_admin_fields,
	collect_json_schema_property_names
} from '#lib/testing/data_exposure.ts';
import { schema_to_surface } from '#lib/http/schema_helpers.ts';
import { create_app_surface_spec, type AppSurfaceSpec } from '#lib/http/surface.ts';
import { define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import type { RouteAuth } from '#lib/http/auth_shape.ts';
import type {
	RequestResponseActionSpec,
	RemoteNotificationActionSpec
} from '#lib/actions/action_spec.ts';
import type { ResolvedWsEndpointSpec } from '#lib/actions/ws_endpoint_spec.ts';

const AUTHED: RouteAuth = { account: 'required', actor: 'none' };
const ADMIN: RouteAuth = { account: 'required', actor: 'none', roles: ['admin'] };

const Clean = object({ name: string });
const Sensitive = object({ password_hash: string });
const AdminOnly = object({ created_by: string });
// a transform's output has no JSON Schema form: its subtree is `{}` on the output side
const TransformedSensitive = object({
	account: pipe(
		Sensitive,
		transform((x) => x)
	)
});

const route = (output: AnySchema, auth: RouteAuth = AUTHED): RouteSpec =>
	define_route({
		method: 'GET',
		path: '/api/thing',
		auth,
		handler: () => route_raw(new Response(null)),
		description: 'A thing.',
		input: literal(null),
		output
	});

const rpc_spec = (
	output: AnySchema,
	auth: RouteAuth = AUTHED,
	initiator: RequestResponseActionSpec['initiator'] = 'frontend',
	input: AnySchema = object({})
): RequestResponseActionSpec => ({
	method: 'thing_get',
	kind: 'request_response',
	initiator,
	auth,
	side_effects: false,
	input,
	output,
	async: true,
	description: 'Get a thing.'
});

const notification_spec = (input: AnySchema): RemoteNotificationActionSpec => ({
	method: 'thing_changed',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input,
	output: fuz_void,
	async: true,
	description: 'A thing changed.'
});

const ws_endpoint = (
	actions: ResolvedWsEndpointSpec['actions'],
	required_roles: ResolvedWsEndpointSpec['required_roles'] = []
): ResolvedWsEndpointSpec => ({ path: '/api/ws', allowed_origins: [], required_roles, actions });

const handler = async () => ({});

const with_route = (output: AnySchema, auth?: RouteAuth): AppSurfaceSpec =>
	create_app_surface_spec({ route_specs: [route(output, auth)], middleware_specs: [] });

const with_rpc = (output: AnySchema, auth?: RouteAuth): AppSurfaceSpec =>
	create_app_surface_spec({
		route_specs: [],
		middleware_specs: [],
		rpc_endpoints: [{ path: '/api/rpc', actions: [{ spec: rpc_spec(output, auth), handler }] }]
	});

const with_ws = (
	output: AnySchema,
	auth?: RouteAuth,
	required_roles?: ResolvedWsEndpointSpec['required_roles']
): AppSurfaceSpec =>
	create_app_surface_spec({
		route_specs: [],
		middleware_specs: [],
		ws_endpoints: [ws_endpoint([{ spec: rpc_spec(output, auth), handler }], required_roles)]
	});

const with_ws_notification = (
	input: AnySchema,
	required_roles?: ResolvedWsEndpointSpec['required_roles']
): AppSurfaceSpec =>
	create_app_surface_spec({
		route_specs: [],
		middleware_specs: [],
		ws_endpoints: [ws_endpoint([{ spec: notification_spec(input) }], required_roles)]
	});

const output_names = (schema: AnySchema): Set<string> =>
	collect_json_schema_property_names(schema_to_surface(schema, { io: 'output', source: 'test' }));

describe('assert_output_schemas_no_sensitive_fields', () => {
	test('passes clean outputs of every kind', () => {
		assert_output_schemas_no_sensitive_fields(with_route(Clean));
		assert_output_schemas_no_sensitive_fields(with_rpc(Clean));
		assert_output_schemas_no_sensitive_fields(with_ws(Clean));
	});

	test('flags a route output', () => {
		assert.throws(
			() => assert_output_schemas_no_sensitive_fields(with_route(Sensitive)),
			/GET \/api\/thing: .*'password_hash'/
		);
	});

	test('flags an RPC method output', () => {
		assert.throws(
			() => assert_output_schemas_no_sensitive_fields(with_rpc(Sensitive)),
			/\/api\/rpc thing_get: .*'password_hash'/
		);
	});

	test('flags a WS method output', () => {
		assert.throws(
			() => assert_output_schemas_no_sensitive_fields(with_ws(Sensitive)),
			/\/api\/ws thing_get: .*'password_hash'/
		);
	});

	test('flags a field inside a transformed subtree, read on the input side', () => {
		const spec = with_route(TransformedSensitive);
		// the surface's output side doesn't show the field
		const output_schema = spec.surface.routes[0]!.output_schema as {
			properties: Record<string, unknown>;
		};
		assert.deepEqual(output_schema.properties.account, {});
		assert.throws(() => assert_output_schemas_no_sensitive_fields(spec), /'password_hash'/);
		assert.throws(
			() => assert_output_schemas_no_sensitive_fields(with_rpc(TransformedSensitive)),
			/'password_hash'/
		);
	});

	test('skips an output by its key', () => {
		assert_output_schemas_no_sensitive_fields(with_route(TransformedSensitive), undefined, [
			'GET /api/thing'
		]);
		assert_output_schemas_no_sensitive_fields(with_rpc(Sensitive), undefined, [
			'/api/rpc thing_get'
		]);
	});

	test("flags a WS notification's params, its pushed payload", () => {
		assert_output_schemas_no_sensitive_fields(with_ws_notification(Clean));
		assert.throws(
			() => assert_output_schemas_no_sensitive_fields(with_ws_notification(Sensitive)),
			/\/api\/ws thing_changed params: .*'password_hash'/
		);
		// an admin-gated endpoint still may not push a sensitive field
		assert.throws(() =>
			assert_output_schemas_no_sensitive_fields(with_ws_notification(Sensitive, ['admin']))
		);
		assert_output_schemas_no_sensitive_fields(with_ws_notification(Sensitive), undefined, [
			'/api/ws thing_changed params'
		]);
	});

	test('flags the params of a WS request the backend initiates', () => {
		const ws_request = (initiator: RequestResponseActionSpec['initiator']): AppSurfaceSpec =>
			create_app_surface_spec({
				route_specs: [],
				middleware_specs: [],
				ws_endpoints: [
					ws_endpoint([{ spec: rpc_spec(Clean, AUTHED, initiator, Sensitive), handler }])
				]
			});
		assert_output_schemas_no_sensitive_fields(ws_request('frontend'));
		assert.throws(
			() => assert_output_schemas_no_sensitive_fields(ws_request('backend')),
			/\/api\/ws thing_get params: .*'password_hash'/
		);
		assert.throws(() => assert_output_schemas_no_sensitive_fields(ws_request('both')));
	});
});

describe('assert_non_admin_schemas_no_admin_fields', () => {
	test('flags a non-admin route output', () => {
		assert.throws(
			() => assert_non_admin_schemas_no_admin_fields(with_route(AdminOnly)),
			/GET \/api\/thing: non-admin .*'created_by'/
		);
	});

	test('passes a route gated to admins or the keeper', () => {
		assert_non_admin_schemas_no_admin_fields(with_route(AdminOnly, ADMIN));
		assert_non_admin_schemas_no_admin_fields(
			with_route(AdminOnly, { ...AUTHED, roles: ['keeper'] })
		);
		assert_non_admin_schemas_no_admin_fields(
			with_route(AdminOnly, { ...AUTHED, roles: ['admin', 'keeper'] })
		);
		assert_non_admin_schemas_no_admin_fields(
			with_route(AdminOnly, { ...AUTHED, credential_types: ['daemon_token'] })
		);
	});

	test('reads an any-of gate with a non-admin role as non-admin', () => {
		assert.throws(() =>
			assert_non_admin_schemas_no_admin_fields(
				with_route(AdminOnly, { ...AUTHED, roles: ['admin', 'editor'] })
			)
		);
		assert.throws(() =>
			assert_non_admin_schemas_no_admin_fields(with_route(AdminOnly, { ...AUTHED, roles: [] }))
		);
	});

	// the blocklist matches by name, and domain RPC and WS outputs carry
	// `created_by`/`updated_by` legitimately (cells, a member's invites)
	test('reads route outputs only', () => {
		assert_non_admin_schemas_no_admin_fields(with_rpc(AdminOnly));
		assert_non_admin_schemas_no_admin_fields(with_ws(AdminOnly));
		assert_non_admin_schemas_no_admin_fields(with_ws_notification(AdminOnly));
	});
});

describe('collect_json_schema_property_names', () => {
	test('walks tuple items (`prefixItems`)', () => {
		const names = collect_json_schema_property_names({
			type: 'array',
			prefixItems: [{ type: 'string' }, { type: 'object', properties: { password_hash: {} } }]
		});
		assert.ok(names.has('password_hash'));
	});

	test('walks a lazy schema behind a `$ref`', () => {
		interface Node {
			password_hash: string;
			kids: Array<Node>;
		}
		const Node: Schema<Node> = lazy(() => object({ password_hash: string, kids: array(Node) }));
		assert.ok(output_names(object({ n: Node })).has('password_hash'));
	});

	test('walks a `$defs` entry behind a `$ref`', () => {
		const names = collect_json_schema_property_names({
			type: 'object',
			properties: { r: { $ref: '#/$defs/Registered' } },
			$defs: { Registered: { type: 'object', properties: { password_hash: {} } } }
		});
		assert.ok(names.has('password_hash'));
	});

	test('walks pattern properties, `not`, conditionals, and `contains`', () => {
		const leaf = (name: string) => ({ type: 'object', properties: { [name]: {} } });
		const names = collect_json_schema_property_names({
			patternProperties: { '^x': leaf('a') },
			not: leaf('b'),
			if: leaf('c'),
			then: leaf('d'),
			else: leaf('e'),
			contains: leaf('f'),
			definitions: { D: leaf('g') }
		});
		assert.deepEqual([...names].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
	});
});
