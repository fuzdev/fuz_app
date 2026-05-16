/**
 * Tests exercising the composable RPC test suites against local fixtures.
 *
 * Verifies that `describe_rpc_attack_surface_tests` and its internal
 * suites generate the expected test groups when given RPC endpoint specs.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import type {RequestResponseActionSpec} from '$lib/actions/action_spec.js';
import type {RpcAction} from '$lib/actions/action_rpc.js';
import {create_test_app_surface_spec} from '$lib/testing/stubs.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {ActingActor} from '$lib/http/auth_shape.js';
import {describe_rpc_attack_surface_tests} from '$lib/testing/rpc_attack_surface.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RpcEndpointSpec} from '$lib/http/surface.js';
import {
	create_rpc_post_init,
	create_rpc_get_url,
	assert_jsonrpc_error_response,
	assert_jsonrpc_success_response,
	resolve_rpc_endpoints_for_setup,
} from '$lib/testing/rpc_helpers.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {JSONRPC_VERSION} from '$lib/http/jsonrpc.js';

const session_options = create_session_config('test_rpc_session');

// --- Fixture action specs ---

const public_read_spec: RequestResponseActionSpec = {
	method: 'widget_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'none', actor: 'none'},
	side_effects: false,
	input: z.void(),
	output: z.strictObject({items: z.array(z.string())}),
	async: true,
	description: 'List widgets',
};

const authed_read_spec: RequestResponseActionSpec = {
	method: 'widget_get',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'none'},
	side_effects: false,
	input: z.strictObject({id: z.string().min(1)}),
	output: z.strictObject({name: z.string()}),
	async: true,
	description: 'Get a widget',
};

const admin_mutation_spec: RequestResponseActionSpec = {
	method: 'widget_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'required', roles: ['admin']},
	side_effects: true,
	input: z.strictObject({name: z.string().min(1).max(100), acting: ActingActor}),
	output: z.strictObject({id: z.string()}),
	async: true,
	description: 'Create a widget',
};

const keeper_spec: RequestResponseActionSpec = {
	method: 'widget_nuke',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {
		account: 'required',
		actor: 'required',
		roles: ['keeper'],
		credential_types: ['daemon_token'],
	},
	side_effects: true,
	input: z.strictObject({acting: ActingActor}),
	output: z.strictObject({ok: z.literal(true)}),
	async: true,
	description: 'Nuke all widgets',
};

const fixture_actions: Array<RpcAction> = [
	{spec: public_read_spec, handler: () => ({items: ['a']})},
	{spec: authed_read_spec, handler: (input: any) => ({name: `widget-${input.id}`})},
	{spec: admin_mutation_spec, handler: (input: any) => ({id: `new-${input.name}`})},
	{spec: keeper_spec, handler: () => ({ok: true})},
];

const rpc_endpoint_spec: RpcEndpointSpec = {
	path: '/api/rpc',
	actions: fixture_actions,
};

// RPC endpoints are auto-mounted by create_test_app_surface_spec from the
// `rpc_endpoints` option — no duplication here.
const create_route_specs = (_ctx: AppServerContext): Array<RouteSpec> => [];

const build = () =>
	create_test_app_surface_spec({
		session_options,
		create_route_specs,
		rpc_endpoints: [rpc_endpoint_spec],
	});

// --- Run the composable suite ---

describe_rpc_attack_surface_tests({
	build,
	roles: ['admin', 'keeper'],
});

// --- Unit tests for rpc_helpers ---

describe('rpc_helpers', () => {
	test('create_rpc_post_init creates valid JSON-RPC envelope', () => {
		const init = create_rpc_post_init('my_method', {foo: 'bar'}, 42);
		assert.strictEqual(init.method, 'POST');
		const body = JSON.parse(init.body as string);
		assert.strictEqual(body.jsonrpc, JSONRPC_VERSION);
		assert.strictEqual(body.method, 'my_method');
		assert.deepStrictEqual(body.params, {foo: 'bar'});
		assert.strictEqual(body.id, 42);
	});

	test('create_rpc_post_init uses default id', () => {
		const init = create_rpc_post_init('m');
		const body = JSON.parse(init.body as string);
		assert.strictEqual(body.id, 'test');
	});

	test('create_rpc_post_init strips both undefined and null params', () => {
		// Pins the helper's null-stripping affordance — JSON-RPC 2.0 §4.2
		// forbids `params: null` on the wire, so the helper produces an
		// envelope without a `params` field for both `undefined` (the
		// new z.void() convention) and `null` (the legacy z.null() shape).
		// Tests that need to construct a literal `"params": null` envelope
		// must build the body inline.
		const omitted = create_rpc_post_init('m').body as string;
		const undefined_params = create_rpc_post_init('m', undefined).body as string;
		const null_params = create_rpc_post_init('m', null).body as string;
		assert.strictEqual(undefined_params, omitted);
		assert.strictEqual(null_params, omitted);
		assert.ok(!Object.hasOwn(JSON.parse(omitted), 'params'));
	});

	test('create_rpc_get_url builds query string', () => {
		const url = create_rpc_get_url('/api/rpc', 'my_method', {a: 1}, 'x');
		assert.ok(url.startsWith('/api/rpc?'));
		assert.ok(url.includes('method=my_method'));
		assert.ok(url.includes('id=x'));
		assert.ok(url.includes('params='));
	});

	test('create_rpc_get_url omits params for null', () => {
		const url = create_rpc_get_url('/api/rpc', 'my_method', null);
		assert.ok(!url.includes('params='));
	});

	test('assert_jsonrpc_error_response validates structure', () => {
		const valid = {jsonrpc: '2.0', id: '1', error: {code: -32600, message: 'bad'}};
		assert_jsonrpc_error_response(valid);
		assert_jsonrpc_error_response(valid, JSONRPC_ERROR_CODES.invalid_request);
	});

	test('assert_jsonrpc_error_response rejects invalid', () => {
		assert.throws(() => assert_jsonrpc_error_response({foo: 'bar'}));
	});

	test('assert_jsonrpc_success_response validates structure', () => {
		const valid = {jsonrpc: '2.0', id: '1', result: {ok: true}};
		assert_jsonrpc_success_response(valid);
	});

	test('assert_jsonrpc_success_response rejects invalid', () => {
		assert.throws(() => assert_jsonrpc_success_response({error: {code: 1, message: 'bad'}}));
	});

	test('assert_jsonrpc_success_response validates result against output schema', () => {
		const schema = z.strictObject({name: z.string(), count: z.number()});
		const valid = {jsonrpc: '2.0', id: '1', result: {name: 'test', count: 5}};
		assert_jsonrpc_success_response(valid, schema);
	});

	test('assert_jsonrpc_success_response rejects result mismatching output schema', () => {
		const schema = z.strictObject({name: z.string(), count: z.number()});
		const invalid = {jsonrpc: '2.0', id: '1', result: {name: 42}};
		assert.throws(() => assert_jsonrpc_success_response(invalid, schema));
	});

	test('assert_jsonrpc_success_response without output schema skips result validation', () => {
		// result has unexpected shape but no schema to check — passes
		const valid = {jsonrpc: '2.0', id: '1', result: {anything: 'goes'}};
		assert_jsonrpc_success_response(valid);
	});

	test('resolve_rpc_endpoints_for_setup returns array form unchanged', () => {
		const input: Array<RpcEndpointSpec> = [{path: '/api/rpc', actions: fixture_actions}];
		const resolved = resolve_rpc_endpoints_for_setup(input, session_options);
		assert.strictEqual(resolved, input);
	});

	test('resolve_rpc_endpoints_for_setup invokes factory twice with stub AppServerContexts for path-purity check', () => {
		let captured_ctx: AppServerContext | undefined;
		let call_count = 0;
		const factory = (ctx: AppServerContext): Array<RpcEndpointSpec> => {
			call_count++;
			captured_ctx = ctx;
			return [{path: '/api/rpc', actions: fixture_actions}];
		};

		const resolved = resolve_rpc_endpoints_for_setup(factory, session_options);

		// Two invocations: one returned, one for the path-purity comparison.
		assert.strictEqual(call_count, 2);
		// Reference identity on `actions` confirms the returned array came
		// from the factory — a fabricated shape matching only on `path`
		// would not pin `actions` to the module-level `fixture_actions` ref.
		assert.strictEqual(resolved[0]?.actions, fixture_actions);
		if (!captured_ctx) throw new Error('factory should have been invoked with a ctx');
		assert.strictEqual(captured_ctx.session_options, session_options);
		// Stub ctx exposes `deps` and nulled rate limiters — enough for
		// canonical action factories like `create_standard_rpc_actions`.
		assert.ok(captured_ctx.deps);
		assert.strictEqual(captured_ctx.ip_rate_limiter, null);
	});

	test('resolve_rpc_endpoints_for_setup throws when factory is not path-pure', () => {
		let call_count = 0;
		const drifting_factory = (): Array<RpcEndpointSpec> => {
			call_count++;
			return [
				{
					path: call_count === 1 ? '/api/rpc' : '/api/rpc-drifted',
					actions: fixture_actions,
				},
			];
		};

		assert.throws(
			() => resolve_rpc_endpoints_for_setup(drifting_factory, session_options),
			/not path-pure/,
		);
	});

	test('resolve_rpc_endpoints_for_setup throws when factory drifts on action method list', () => {
		let call_count = 0;
		const drifting_factory = (): Array<RpcEndpointSpec> => {
			call_count++;
			return [
				{
					path: '/api/rpc',
					actions: call_count === 1 ? fixture_actions : [],
				},
			];
		};

		assert.throws(
			() => resolve_rpc_endpoints_for_setup(drifting_factory, session_options),
			/not path-pure/,
		);
	});
});

// --- ws_endpoints thread-through ---
//
// `create_test_app_surface_spec` mirrors `create_app_server`'s auto-mount
// for both `rpc_endpoints` and `ws_endpoints` so consumer attack-surface
// tests see the same surface production wires. Without this the rpc
// thread-through was tested via the `describe_rpc_attack_surface_tests`
// run above, but the ws thread-through had no coverage — drift between
// production and tests would surface as a missing WS section in
// snapshots without an obvious cause.

describe('create_test_app_surface_spec — ws_endpoints', () => {
	const ws_endpoint_spec = {
		path: '/api/ws',
		allowed_origins: [] as ReadonlyArray<RegExp>,
		actions: fixture_actions,
	};

	test('array form threads ws_endpoints into the generated surface', () => {
		const spec = create_test_app_surface_spec({
			session_options,
			create_route_specs: () => [],
			ws_endpoints: [ws_endpoint_spec],
		});

		assert.strictEqual(spec.surface.ws_endpoints.length, 1);
		assert.strictEqual(spec.surface.ws_endpoints[0]!.path, '/api/ws');
		assert.strictEqual(spec.ws_endpoints.length, 1);
		assert.strictEqual(spec.ws_endpoints[0]!.path, '/api/ws');
	});

	test('factory form threads ws_endpoints and receives a stub AppServerContext', () => {
		let captured_ctx: AppServerContext | undefined;
		const spec = create_test_app_surface_spec({
			session_options,
			create_route_specs: () => [],
			ws_endpoints: (ctx) => {
				captured_ctx = ctx;
				return [ws_endpoint_spec];
			},
		});

		assert.isDefined(captured_ctx);
		assert.isDefined(captured_ctx.deps);
		assert.strictEqual(spec.surface.ws_endpoints.length, 1);
		assert.strictEqual(spec.surface.ws_endpoints[0]!.path, '/api/ws');
	});

	test('omitting ws_endpoints leaves the surface ws section empty (no implicit default)', () => {
		const spec = create_test_app_surface_spec({
			session_options,
			create_route_specs: () => [],
		});
		assert.strictEqual(spec.surface.ws_endpoints.length, 0);
		assert.strictEqual(spec.ws_endpoints.length, 0);
	});
});
