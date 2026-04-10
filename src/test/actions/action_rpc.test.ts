/**
 * Tests for action_rpc.ts — RPC-style route spec derivation.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Hono} from 'hono';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_rpc_route_specs, type RpcAction} from '$lib/actions/action_rpc.js';
import type {RequestResponseActionSpec} from '$lib/actions/action_spec.js';
import {apply_route_specs} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import {generate_app_surface} from '$lib/http/surface.js';
import {create_stub_db} from '$lib/testing/stubs.js';
import {REQUEST_CONTEXT_KEY} from '$lib/auth/request_context.js';
import {create_test_request_context} from '$lib/testing/auth_apps.js';
import {jsonrpc_errors, JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';

const log = new Logger('test', {level: 'off'});
const db = create_stub_db();

const create_post_spec = (): RequestResponseActionSpec => ({
	method: 'thing_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: z.strictObject({name: z.string()}),
	output: z.strictObject({id: z.string()}),
	async: true,
	description: 'Create a thing',
});

const create_get_spec = (): RequestResponseActionSpec => ({
	method: 'thing_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: false,
	input: z.null(),
	output: z.strictObject({items: z.array(z.string())}),
	async: true,
	description: 'List things',
});

const create_get_with_input_spec = (): RequestResponseActionSpec => ({
	method: 'thing_search',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: false,
	input: z.strictObject({query: z.string(), limit: z.number()}),
	output: z.strictObject({results: z.array(z.string())}),
	async: true,
	description: 'Search things',
});

describe('create_rpc_route_specs', () => {
	test('side_effects true derives POST method', () => {
		const specs = create_rpc_route_specs({
			path: '/api/rpc',
			actions: [{spec: create_post_spec(), handler: () => ({})}],
			log,
		});
		assert.strictEqual(specs.length, 1);
		assert.strictEqual(specs[0]!.method, 'POST');
	});

	test('side_effects false derives GET method', () => {
		const specs = create_rpc_route_specs({
			path: '/api/rpc',
			actions: [{spec: create_get_spec(), handler: () => ({})}],
			log,
		});
		assert.strictEqual(specs[0]!.method, 'GET');
	});

	test('path is mount/method_name', () => {
		const specs = create_rpc_route_specs({
			path: '/api/rpc',
			actions: [{spec: create_post_spec(), handler: () => ({})}],
			log,
		});
		assert.strictEqual(specs[0]!.path, '/api/rpc/thing_create');
	});

	test('transaction matches side_effects', () => {
		const actions: Array<RpcAction> = [
			{spec: create_post_spec(), handler: () => ({})},
			{spec: create_get_spec(), handler: () => ({})},
		];
		const specs = create_rpc_route_specs({path: '/api/rpc', actions, log});
		assert.strictEqual(specs[0]!.transaction, true);
		assert.strictEqual(specs[1]!.transaction, false);
	});

	test('auth derived via map_action_auth', () => {
		const authenticated_spec = create_post_spec();
		const public_spec = create_get_spec();
		const role_spec: RequestResponseActionSpec = {
			...create_post_spec(),
			method: 'admin_thing',
			auth: {role: 'admin'},
		};
		const keeper_spec: RequestResponseActionSpec = {
			...create_post_spec(),
			method: 'keeper_thing',
			auth: 'keeper',
		};

		const specs = create_rpc_route_specs({
			path: '/api/rpc',
			actions: [
				{spec: authenticated_spec, handler: () => ({})},
				{spec: public_spec, handler: () => ({})},
				{spec: role_spec, handler: () => ({})},
				{spec: keeper_spec, handler: () => ({})},
			],
			log,
		});

		assert.deepStrictEqual(specs[0]!.auth, {type: 'authenticated'});
		assert.deepStrictEqual(specs[1]!.auth, {type: 'none'});
		assert.deepStrictEqual(specs[2]!.auth, {type: 'role', role: 'admin'});
		assert.deepStrictEqual(specs[3]!.auth, {type: 'keeper'});
	});

	test('description comes from action spec', () => {
		const specs = create_rpc_route_specs({
			path: '/api/rpc',
			actions: [{spec: create_post_spec(), handler: () => ({})}],
			log,
		});
		assert.strictEqual(specs[0]!.description, 'Create a thing');
	});

	test('input and output schemas forwarded from spec', () => {
		const action_spec = create_post_spec();
		const specs = create_rpc_route_specs({
			path: '/api/rpc',
			actions: [{spec: action_spec, handler: () => ({})}],
			log,
		});
		assert.strictEqual(specs[0]!.input, action_spec.input);
		assert.strictEqual(specs[0]!.output, action_spec.output);
	});

	test('multiple actions produce multiple route specs', () => {
		const specs = create_rpc_route_specs({
			path: '/api/rpc',
			actions: [
				{spec: create_post_spec(), handler: () => ({})},
				{spec: create_get_spec(), handler: () => ({})},
				{spec: create_get_with_input_spec(), handler: () => ({})},
			],
			log,
		});
		assert.strictEqual(specs.length, 3);
		assert.strictEqual(specs[0]!.path, '/api/rpc/thing_create');
		assert.strictEqual(specs[1]!.path, '/api/rpc/thing_list');
		assert.strictEqual(specs[2]!.path, '/api/rpc/thing_search');
	});
});

describe('RPC handler wrapper', () => {
	test('POST handler receives validated input', async () => {
		let received_input: unknown;
		const actions: Array<RpcAction> = [
			{
				spec: create_post_spec(),
				handler: (input) => {
					received_input = input;
					return {id: '123'};
				},
			},
		];
		const route_specs = create_rpc_route_specs({path: '/api/rpc', actions, log});

		const app = new Hono();
		app.use('/*', async (c, next) => {
			(c as any).set(REQUEST_CONTEXT_KEY, create_test_request_context());
			await next();
		});
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/api/rpc/thing_create', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({name: 'test'}),
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.id, '123');
		assert.deepStrictEqual(received_input, {name: 'test'});
	});

	test('GET with null input passes null to handler', async () => {
		let received_input: unknown = 'sentinel';
		const actions: Array<RpcAction> = [
			{
				spec: create_get_spec(),
				handler: (input) => {
					received_input = input;
					return {items: ['a', 'b']};
				},
			},
		];
		const route_specs = create_rpc_route_specs({path: '/api/rpc', actions, log});

		const app = new Hono();
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/api/rpc/thing_list');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.deepStrictEqual(body.items, ['a', 'b']);
		assert.strictEqual(received_input, null);
	});

	test('GET with real input parses ?params= query string', async () => {
		let received_input: unknown;
		const actions: Array<RpcAction> = [
			{
				spec: create_get_with_input_spec(),
				handler: (input) => {
					received_input = input;
					return {results: ['found']};
				},
			},
		];
		const route_specs = create_rpc_route_specs({path: '/api/rpc', actions, log});

		const app = new Hono();
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const params = encodeURIComponent(JSON.stringify({query: 'test', limit: 10}));
		const res = await app.request(`/api/rpc/thing_search?params=${params}`);
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(received_input, {query: 'test', limit: 10});
	});

	test('GET with missing ?params= returns 400', async () => {
		const actions: Array<RpcAction> = [
			{spec: create_get_with_input_spec(), handler: () => ({results: []})},
		];
		const route_specs = create_rpc_route_specs({path: '/api/rpc', actions, log});

		const app = new Hono();
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/api/rpc/thing_search');
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error, 'invalid_request_body');
	});

	test('GET with invalid JSON in ?params= returns 400', async () => {
		const actions: Array<RpcAction> = [
			{spec: create_get_with_input_spec(), handler: () => ({results: []})},
		];
		const route_specs = create_rpc_route_specs({path: '/api/rpc', actions, log});

		const app = new Hono();
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/api/rpc/thing_search?params=not-json');
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error, 'invalid_json_body');
	});

	test('GET with schema-invalid ?params= returns 400 with issues', async () => {
		const actions: Array<RpcAction> = [
			{spec: create_get_with_input_spec(), handler: () => ({results: []})},
		];
		const route_specs = create_rpc_route_specs({path: '/api/rpc', actions, log});

		const app = new Hono();
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const params = encodeURIComponent(JSON.stringify({query: 123, limit: 'bad'}));
		const res = await app.request(`/api/rpc/thing_search?params=${params}`);
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error, 'invalid_request_body');
		assert.ok(Array.isArray(body.issues));
	});

	test('handler output returned as JSON response', async () => {
		const actions: Array<RpcAction> = [
			{
				spec: create_get_spec(),
				handler: () => ({items: ['x', 'y', 'z']}),
			},
		];
		const route_specs = create_rpc_route_specs({path: '/api/rpc', actions, log});

		const app = new Hono();
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/api/rpc/thing_list');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.deepStrictEqual(body, {items: ['x', 'y', 'z']});
	});

	test('thrown ThrownJsonrpcError caught by apply_route_specs catch layer', async () => {
		const actions: Array<RpcAction> = [
			{
				spec: create_get_spec(),
				handler: () => {
					throw jsonrpc_errors.not_found('thing');
				},
			},
		];
		const route_specs = create_rpc_route_specs({path: '/api/rpc', actions, log});

		const app = new Hono();
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const res = await app.request('/api/rpc/thing_list');
		assert.strictEqual(res.status, 404);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.not_found as number);
		assert.strictEqual(body.error.message, 'thing not found');
	});

	test('handler receives ActionContext with auth', async () => {
		let received_auth: unknown;
		const actions: Array<RpcAction> = [
			{
				spec: create_post_spec(),
				handler: (_input, ctx) => {
					received_auth = ctx.auth;
					return {id: '1'};
				},
			},
		];
		const route_specs = create_rpc_route_specs({path: '/api/rpc', actions, log});

		const app = new Hono();
		const test_ctx = create_test_request_context();
		app.use('/*', async (c, next) => {
			(c as any).set(REQUEST_CONTEXT_KEY, test_ctx);
			await next();
		});
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		await app.request('/api/rpc/thing_create', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({name: 'test'}),
		});
		assert.strictEqual(received_auth, test_ctx);
	});

	test('handler receives null auth for public routes', async () => {
		let received_auth: unknown = 'sentinel';
		const actions: Array<RpcAction> = [
			{
				spec: create_get_spec(),
				handler: (_input, ctx) => {
					received_auth = ctx.auth;
					return {items: []};
				},
			},
		];
		const route_specs = create_rpc_route_specs({path: '/api/rpc', actions, log});

		const app = new Hono();
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		await app.request('/api/rpc/thing_list');
		assert.strictEqual(received_auth, null);
	});
});

describe('RPC routes in app surface', () => {
	test('RPC routes appear as regular AppSurfaceRoute entries', () => {
		const route_specs = create_rpc_route_specs({
			path: '/api/rpc',
			actions: [
				{spec: create_post_spec(), handler: () => ({})},
				{spec: create_get_spec(), handler: () => ({})},
			],
			log,
		});

		const surface = generate_app_surface({middleware_specs: [], route_specs});

		assert.strictEqual(surface.routes.length, 2);
		assert.strictEqual(surface.routes[0]!.method, 'POST');
		assert.strictEqual(surface.routes[0]!.path, '/api/rpc/thing_create');
		assert.strictEqual(surface.routes[0]!.description, 'Create a thing');
		assert.deepStrictEqual(surface.routes[0]!.auth, {type: 'authenticated'});

		assert.strictEqual(surface.routes[1]!.method, 'GET');
		assert.strictEqual(surface.routes[1]!.path, '/api/rpc/thing_list');
		assert.strictEqual(surface.routes[1]!.description, 'List things');
		assert.deepStrictEqual(surface.routes[1]!.auth, {type: 'none'});
	});

	test('surface input_schema populated for GET with non-null input', () => {
		const route_specs = create_rpc_route_specs({
			path: '/api/rpc',
			actions: [{spec: create_get_with_input_spec(), handler: () => ({})}],
			log,
		});

		const surface = generate_app_surface({middleware_specs: [], route_specs});
		assert.ok(surface.routes[0]!.input_schema);
	});
});
