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
import {describe_rpc_attack_surface_tests} from '$lib/testing/rpc_attack_surface.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RpcEndpointSpec} from '$lib/http/surface.js';
import {
	create_rpc_post_init,
	create_rpc_get_url,
	assert_jsonrpc_error_response,
	assert_jsonrpc_success_response,
} from '$lib/testing/rpc_helpers.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {JSONRPC_VERSION} from '$lib/http/jsonrpc.js';

const session_options = create_session_config('test_rpc_session');

// --- Fixture action specs ---

const public_read_spec: RequestResponseActionSpec = {
	method: 'widget_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: false,
	input: z.null(),
	output: z.strictObject({items: z.array(z.string())}),
	async: true,
	description: 'List widgets',
};

const authed_read_spec: RequestResponseActionSpec = {
	method: 'widget_get',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
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
	auth: {role: 'admin'},
	side_effects: true,
	input: z.strictObject({name: z.string().min(1).max(100)}),
	output: z.strictObject({id: z.string()}),
	async: true,
	description: 'Create a widget',
};

const keeper_spec: RequestResponseActionSpec = {
	method: 'widget_nuke',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'keeper',
	side_effects: true,
	input: z.null(),
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
});
