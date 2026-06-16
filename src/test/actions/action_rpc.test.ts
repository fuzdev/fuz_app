/**
 * Tests for action_rpc.ts — single JSON-RPC 2.0 endpoint.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Hono} from 'hono';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.ts';

import {create_rpc_endpoint, type RpcAction} from '$lib/actions/action_rpc.ts';
import type {RequestResponseActionSpec} from '$lib/actions/action_spec.ts';
import {apply_route_specs} from '$lib/http/route_spec.ts';
import {fuz_auth_guard_resolver} from '$lib/auth/auth_guard_resolver.ts';
import {generate_app_surface} from '$lib/http/surface.ts';
import {create_stub_db} from '$lib/testing/stubs.ts';
import {REQUEST_CONTEXT_KEY} from '$lib/auth/request_context.ts';
import {
	ACCOUNT_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	TEST_CONTEXT_PRESET_KEY,
	type CredentialType,
} from '$lib/hono_context.ts';
import {create_test_request_context} from '$lib/testing/auth_apps.ts';
import {create_test_actor} from '$lib/testing/entities.ts';
import {jsonrpc_errors, JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.ts';
import {ERROR_AUTHENTICATION_REQUIRED} from '$lib/http/error_schemas.ts';
import {RateLimiter} from '$lib/rate_limiter.ts';
import {ActingActor} from '$lib/http/auth_shape.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';

const log = new Logger('test', {level: 'off'});
const db = create_stub_db();

const create_post_spec = (): RequestResponseActionSpec => ({
	method: 'thing_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'none'},
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
	auth: {account: 'none', actor: 'none'},
	side_effects: false,
	input: z.void(),
	output: z.strictObject({items: z.array(z.string())}),
	async: true,
	description: 'List things',
});

const create_get_with_input_spec = (): RequestResponseActionSpec => ({
	method: 'thing_search',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'none', actor: 'none'},
	side_effects: false,
	input: z.strictObject({query: z.string(), limit: z.number()}),
	output: z.strictObject({results: z.array(z.string())}),
	async: true,
	description: 'Search things',
});

const create_meta_spec = (): RequestResponseActionSpec => ({
	method: 'thing_with_meta',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'none', actor: 'none'},
	side_effects: true,
	input: z.strictObject({
		name: z.string(),
		_meta: z.looseObject({progressToken: z.string().optional()}).optional(),
	}),
	output: z.strictObject({ok: z.literal(true)}),
	async: true,
	description: 'Action with _meta in input schema',
});

/** JSON-RPC request helper. */
const rpc_request = (method: string, params?: unknown, id: string | number = '1') =>
	JSON.stringify({jsonrpc: '2.0', method, params, id});

/** Create a Hono app with the RPC endpoint mounted. */
const create_test_app = (
	actions: Array<RpcAction>,
	{
		auth_context,
		credential_type,
	}: {
		auth_context?: ReturnType<typeof create_test_request_context>;
		credential_type?: CredentialType;
	} = {},
): Hono => {
	const app = new Hono();
	if (auth_context) {
		app.use('/*', async (c, next) => {
			(c as any).set(ACCOUNT_ID_KEY, auth_context.account.id);
			(c as any).set(REQUEST_CONTEXT_KEY, auth_context);
			(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
			if (credential_type) {
				(c as any).set(CREDENTIAL_TYPE_KEY, credential_type);
			}
			await next();
		});
	}
	const route_specs = create_rpc_endpoint({path: '/api/rpc', actions, log});
	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);
	return app;
};

describe('create_rpc_endpoint', () => {
	test('returns two route specs (POST + GET) on same path', () => {
		const specs = create_rpc_endpoint({
			path: '/api/rpc',
			actions: [{spec: create_post_spec(), handler: () => ({})}],
			log,
		});
		assert.strictEqual(specs.length, 2);
		assert.strictEqual(specs[0]!.method, 'POST');
		assert.strictEqual(specs[0]!.path, '/api/rpc');
		assert.strictEqual(specs[1]!.method, 'GET');
		assert.strictEqual(specs[1]!.path, '/api/rpc');
	});

	test('both specs have auth none and transaction false', () => {
		const specs = create_rpc_endpoint({
			path: '/api/rpc',
			actions: [{spec: create_post_spec(), handler: () => ({})}],
			log,
		});
		assert.deepStrictEqual(specs[0]!.auth, {account: 'none', actor: 'none'});
		assert.deepStrictEqual(specs[1]!.auth, {account: 'none', actor: 'none'});
		assert.strictEqual(specs[0]!.transaction, false);
		assert.strictEqual(specs[1]!.transaction, false);
	});

	test('throws on duplicate method names', () => {
		assert.throws(
			() =>
				create_rpc_endpoint({
					path: '/api/rpc',
					actions: [
						{spec: create_post_spec(), handler: () => ({})},
						{spec: create_post_spec(), handler: () => ({})},
					],
					log,
				}),
			/Duplicate RPC action method/,
		);
	});

	test('throws on z.null() input spec (JSON-RPC 2.0 forbids `params: null`)', () => {
		const legacy_null_spec: RequestResponseActionSpec = {
			method: 'thing_legacy_null',
			kind: 'request_response',
			initiator: 'frontend',
			auth: {account: 'none', actor: 'none'},
			side_effects: false,
			input: z.null(),
			output: z.strictObject({ok: z.literal(true)}),
			async: true,
			description: 'Legacy null-input action',
		};
		assert.throws(
			() =>
				create_rpc_endpoint({
					path: '/api/rpc',
					actions: [{spec: legacy_null_spec, handler: () => ({ok: true as const})}],
					log,
				}),
			/RPC action "thing_legacy_null".*z\.null\(\).*z\.void\(\)/s,
		);
	});

	test('description includes method count', () => {
		const specs = create_rpc_endpoint({
			path: '/api/rpc',
			actions: [
				{spec: create_post_spec(), handler: () => ({})},
				{spec: create_get_spec(), handler: () => ({})},
			],
			log,
		});
		assert.ok(specs[0]!.description.includes('2 methods'));
	});
});

describe('POST dispatcher', () => {
	test('dispatches valid request and returns JSON-RPC response', async () => {
		const app = create_test_app(
			[
				{
					spec: create_post_spec(),
					handler: (input: any) => ({id: `created-${input.name}`}),
				},
			],
			{auth_context: create_test_request_context()},
		);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_create', {name: 'test'}),
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.jsonrpc, '2.0');
		assert.strictEqual(body.id, '1');
		assert.strictEqual(body.result.id, 'created-test');
	});

	test('returns parse_error for invalid JSON body', async () => {
		const app = create_test_app([{spec: create_get_spec(), handler: () => ({items: []})}]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: 'not-json',
		});
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.parse_error as number);
	});

	test('returns invalid_request for malformed envelope', async () => {
		const app = create_test_app([{spec: create_get_spec(), handler: () => ({items: []})}]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({method: 'thing_list'}), // missing jsonrpc and id
		});
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_request as number);
	});

	test('returns method_not_found for unknown method', async () => {
		const app = create_test_app([{spec: create_get_spec(), handler: () => ({items: []})}]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('nonexistent'),
		});
		assert.strictEqual(res.status, 404);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.method_not_found as number);
		assert.ok(body.error.message.includes('nonexistent'));
	});

	test('returns unauthenticated for auth-required action without context', async () => {
		const app = create_test_app([{spec: create_post_spec(), handler: () => ({id: '1'})}]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_create', {name: 'test'}),
		});
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.unauthenticated as number);
		// The pre-validation 401 carries `data.reason` (symmetric with the 403
		// gates) so callers can assert reason, not just status.
		assert.strictEqual(body.error.data.reason, ERROR_AUTHENTICATION_REQUIRED);
	});

	test('returns forbidden for role-gated action without role', async () => {
		const admin_spec: RequestResponseActionSpec = {
			...create_post_spec(),
			method: 'admin_action',
			auth: {account: 'required', actor: 'required', roles: ['admin']},
			input: z.strictObject({name: z.string(), acting: ActingActor}),
		};
		const app = create_test_app(
			[{spec: admin_spec, handler: () => ({id: '1'})}],
			{auth_context: create_test_request_context()}, // no admin role
		);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('admin_action', {name: 'test'}),
		});
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.forbidden as number);
	});

	test('returns invalid_params for schema-invalid params', async () => {
		const app = create_test_app([{spec: create_post_spec(), handler: () => ({id: '1'})}], {
			auth_context: create_test_request_context(),
		});

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_create', {name: 123}), // name should be string
		});
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_params as number);
		assert.ok(body.error.data.issues);
	});

	test('handler receives ActionContext with auth', async () => {
		let received_auth: unknown;
		const test_ctx = create_test_request_context();
		const app = create_test_app(
			[
				{
					spec: create_post_spec(),
					handler: (_input, ctx) => {
						received_auth = ctx.auth;
						return {id: '1'};
					},
				},
			],
			{auth_context: test_ctx},
		);

		await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_create', {name: 'test'}),
		});
		assert.strictEqual(received_auth, test_ctx);
	});

	test('handler receives null auth for public actions', async () => {
		let received_auth: unknown = 'sentinel';
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: (_input, ctx) => {
					received_auth = ctx.auth;
					return {items: []};
				},
			},
		]);

		await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_list'),
		});
		assert.strictEqual(received_auth, null);
	});

	test('void input schemas accept missing params', async () => {
		let received_input: unknown = 'sentinel';
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: (input) => {
					received_input = input;
					return {items: []};
				},
			},
		]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_list'),
		});
		assert.strictEqual(res.status, 200);
		assert.strictEqual(received_input, undefined);
	});

	test('void input schemas reject params: {} with invalid_params', async () => {
		const app = create_test_app([{spec: create_get_spec(), handler: () => ({items: []})}]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_list', {}),
		});
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_params as number);
	});

	test('void input schemas reject literal "params": null with invalid_request', async () => {
		// Regression for the production bug a hand-rolled consumer client hit:
		// JSON-RPC 2.0 §4.2 forbids `params: null` (must be omitted or a
		// Structured value). The envelope schema rejects null params before
		// the dispatcher's input validation ever runs, so the failure lands
		// on `invalid_request`, not `invalid_params` — different error code
		// from `params: {}` against the same void-input method.
		const app = create_test_app([{spec: create_get_spec(), handler: () => ({items: []})}]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({jsonrpc: '2.0', method: 'thing_list', params: null, id: '1'}),
		});
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_request as number);
	});

	test('object input schemas treat missing params as empty object', async () => {
		// Mirrors audit_log_list / audit_log_role_grant_history shape: strictObject
		// with every field nullish. Callers that don't pass `params` on the
		// envelope must not trip schema validation — the handler gets `{}`.
		let received_input: unknown = 'sentinel';
		const all_optional_spec: RequestResponseActionSpec = {
			method: 'thing_all_optional',
			kind: 'request_response',
			initiator: 'frontend',
			auth: {account: 'none', actor: 'none'},
			side_effects: false,
			input: z.strictObject({foo: z.string().nullish()}),
			output: z.strictObject({ok: z.literal(true)}),
			async: true,
			description: 'All-optional object input',
		};
		const app = create_test_app([
			{
				spec: all_optional_spec,
				handler: (input) => {
					received_input = input;
					return {ok: true as const};
				},
			},
		]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_all_optional'),
		});
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(received_input, {});
	});

	test('ThrownJsonrpcError caught and formatted as JSON-RPC error', async () => {
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: () => {
					throw jsonrpc_errors.not_found('thing');
				},
			},
		]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_list'),
		});
		assert.strictEqual(res.status, 404);
		const body = await res.json();
		assert.strictEqual(body.jsonrpc, '2.0');
		assert.strictEqual(body.id, '1');
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.not_found as number);
		assert.strictEqual(body.error.message, 'thing not found');
	});

	test('preserves request id in error responses', async () => {
		const app = create_test_app([{spec: create_get_spec(), handler: () => ({items: []})}]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('nonexistent', undefined, 'my-id-42'),
		});
		const body = await res.json();
		assert.strictEqual(body.id, 'my-id-42');
	});

	test('salvages id from invalid envelope', async () => {
		const app = create_test_app([{spec: create_get_spec(), handler: () => ({items: []})}]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			// has id but missing required jsonrpc field
			body: JSON.stringify({id: 'salvage-me', method: 'thing_list'}),
		});
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.id, 'salvage-me');
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_request as number);
	});

	test('rejects batch (array) requests', async () => {
		const app = create_test_app([{spec: create_get_spec(), handler: () => ({items: []})}]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify([{jsonrpc: '2.0', id: '1', method: 'thing_list'}]),
		});
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_request as number);
		assert.strictEqual(body.id, null); // array has no extractable id
	});

	test('unhandled error returns 500 with JSON-RPC format', async () => {
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: () => {
					throw new Error('unexpected kaboom');
				},
			},
		]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_list'),
		});
		assert.strictEqual(res.status, 500);
		const body = await res.json();
		assert.strictEqual(body.jsonrpc, '2.0');
		assert.strictEqual(body.id, '1');
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.internal_error as number);
	});

	test('dispatches side_effects:false action via POST', async () => {
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: () => ({items: ['a']}),
			},
		]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_list'),
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.deepStrictEqual(body.result.items, ['a']);
	});

	test('returns forbidden for keeper action without keeper role', async () => {
		const keeper_spec: RequestResponseActionSpec = {
			...create_post_spec(),
			method: 'keeper_action',
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token'],
			},
			input: z.strictObject({name: z.string(), acting: ActingActor}),
		};
		const app = create_test_app(
			[{spec: keeper_spec, handler: () => ({id: '1'})}],
			{auth_context: create_test_request_context()}, // no keeper role
		);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('keeper_action', {name: 'test'}),
		});
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.forbidden as number);
	});

	test('succeeds for keeper action with daemon_token and keeper role', async () => {
		const keeper_spec: RequestResponseActionSpec = {
			...create_post_spec(),
			method: 'keeper_action',
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token'],
			},
			input: z.strictObject({name: z.string(), acting: ActingActor}),
		};
		const app = create_test_app(
			[{spec: keeper_spec, handler: (input: any) => ({id: input.name})}],
			{auth_context: create_test_request_context('keeper'), credential_type: 'daemon_token'},
		);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('keeper_action', {name: 'test'}),
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.result.id, 'test');
	});

	test('returns forbidden for keeper action with session credential', async () => {
		const keeper_spec: RequestResponseActionSpec = {
			...create_post_spec(),
			method: 'keeper_action',
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token'],
			},
			input: z.strictObject({name: z.string(), acting: ActingActor}),
		};
		const app = create_test_app([{spec: keeper_spec, handler: () => ({id: '1'})}], {
			auth_context: create_test_request_context('keeper'),
			credential_type: 'session',
		});

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('keeper_action', {name: 'test'}),
		});
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.forbidden as number);
	});

	test('returns forbidden for keeper action with api_token credential', async () => {
		const keeper_spec: RequestResponseActionSpec = {
			...create_post_spec(),
			method: 'keeper_action',
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token'],
			},
			input: z.strictObject({name: z.string(), acting: ActingActor}),
		};
		const app = create_test_app([{spec: keeper_spec, handler: () => ({id: '1'})}], {
			auth_context: create_test_request_context('keeper'),
			credential_type: 'api_token',
		});

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('keeper_action', {name: 'test'}),
		});
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.forbidden as number);
	});

	test('returns forbidden for keeper action with daemon_token but no keeper role', async () => {
		const keeper_spec: RequestResponseActionSpec = {
			...create_post_spec(),
			method: 'keeper_action',
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token'],
			},
			input: z.strictObject({name: z.string(), acting: ActingActor}),
		};
		const app = create_test_app([{spec: keeper_spec, handler: () => ({id: '1'})}], {
			auth_context: create_test_request_context(),
			credential_type: 'daemon_token',
		});

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('keeper_action', {name: 'test'}),
		});
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.forbidden as number);
	});

	test('wrong-type _meta produces invalid_params not invalid_request', async () => {
		const app = create_test_app([{spec: create_meta_spec(), handler: () => ({ok: true as const})}]);

		// _meta as a string — must pass the envelope (step 1) and fail at
		// per-action params validation (step 4) with invalid_params (-32602)
		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_with_meta', {name: 'test', _meta: 'not_an_object'}),
		});
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_params as number);
	});

	test('valid _meta passes through to handler', async () => {
		let received_meta: unknown;
		const app = create_test_app([
			{
				spec: create_meta_spec(),
				handler: (input: any) => {
					received_meta = input._meta;
					return {ok: true as const};
				},
			},
		]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_with_meta', {name: 'test', _meta: {progressToken: 'tok-1'}}),
		});
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(received_meta, {progressToken: 'tok-1'});
	});

	test('ThrownJsonrpcError preserves data field', async () => {
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: () => {
					throw jsonrpc_errors.invalid_params('bad field', {field: 'name', expected: 'string'});
				},
			},
		]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_list'),
		});
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_params as number);
		assert.strictEqual(body.error.data.field, 'name');
		assert.strictEqual(body.error.data.expected, 'string');
	});
});

describe('GET dispatcher', () => {
	test('dispatches side_effects:false action via query string', async () => {
		let received_input: unknown = 'sentinel';
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: (input) => {
					received_input = input;
					return {items: ['a', 'b']};
				},
			},
		]);

		const res = await app.request('/api/rpc?method=thing_list&id=1');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.jsonrpc, '2.0');
		assert.deepStrictEqual(body.result.items, ['a', 'b']);
		assert.strictEqual(received_input, undefined);
	});

	test('void input schemas reject ?params={} with invalid_params', async () => {
		// GET parity for the POST-side void-schema reject test — the GET path
		// parses `params` out of the query string (separate code path from the
		// POST body parse), so a void-input method must reject `?params={}`
		// with the same `invalid_params` shape.
		const app = create_test_app([{spec: create_get_spec(), handler: () => ({items: []})}]);

		const params = encodeURIComponent(JSON.stringify({}));
		const res = await app.request(`/api/rpc?method=thing_list&id=1&params=${params}`);
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_params as number);
	});

	test('parses params from query string', async () => {
		let received_input: unknown;
		const app = create_test_app([
			{
				spec: create_get_with_input_spec(),
				handler: (input) => {
					received_input = input;
					return {results: ['found']};
				},
			},
		]);

		const params = encodeURIComponent(JSON.stringify({query: 'test', limit: 10}));
		const res = await app.request(`/api/rpc?method=thing_search&id=1&params=${params}`);
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(received_input, {query: 'test', limit: 10});
	});

	test('rejects side_effects:true actions', async () => {
		const app = create_test_app([{spec: create_post_spec(), handler: () => ({id: '1'})}], {
			auth_context: create_test_request_context(),
		});

		const res = await app.request('/api/rpc?method=thing_create&id=1');
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_request as number);
		assert.ok(body.error.data.reason.includes('side effects'));
	});

	test('returns error for missing method query param', async () => {
		const app = create_test_app([{spec: create_get_spec(), handler: () => ({items: []})}]);

		const res = await app.request('/api/rpc?id=1');
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_request as number);
	});

	test('returns error for missing id query param', async () => {
		const app = create_test_app([{spec: create_get_spec(), handler: () => ({items: []})}]);

		const res = await app.request('/api/rpc?method=thing_list');
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_request as number);
	});

	test('parses integer id from query string', async () => {
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: (_input, ctx) => ({items: [String(ctx.request_id), typeof ctx.request_id]}),
			},
		]);

		const res = await app.request('/api/rpc?method=thing_list&id=42');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.id, 42);
		assert.deepStrictEqual(body.result.items, ['42', 'number']);
	});

	test('parses zero id as number', async () => {
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: () => ({items: []}),
			},
		]);

		const res = await app.request('/api/rpc?method=thing_list&id=0');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.id, 0);
	});

	test('parses negative integer id as number', async () => {
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: () => ({items: []}),
			},
		]);

		const res = await app.request('/api/rpc?method=thing_list&id=-1');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.id, -1);
	});

	test('keeps string id that does not round-trip as number', async () => {
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: () => ({items: []}),
			},
		]);

		// "042" round-trips as "42", so it stays a string
		const res = await app.request('/api/rpc?method=thing_list&id=042');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.id, '042');
	});

	test('keeps non-numeric string id as string', async () => {
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: () => ({items: []}),
			},
		]);

		const res = await app.request('/api/rpc?method=thing_list&id=abc-123');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.id, 'abc-123');
	});

	test('keeps fractional numeric id as string per JSON-RPC spec', async () => {
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: () => ({items: []}),
			},
		]);

		// JSON-RPC spec: "Numbers SHOULD NOT contain fractional parts"
		const res = await app.request('/api/rpc?method=thing_list&id=3.14');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.id, '3.14');
	});

	test('keeps scientific notation id as string', async () => {
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: () => ({items: []}),
			},
		]);

		// 1e5 parses to 100000 but String(100000) !== "1e5"
		const res = await app.request('/api/rpc?method=thing_list&id=1e5');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.id, '1e5');
	});

	test('returns error for invalid JSON in params', async () => {
		const app = create_test_app([
			{spec: create_get_with_input_spec(), handler: () => ({results: []})},
		]);

		const res = await app.request('/api/rpc?method=thing_search&id=1&params=not-json');
		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_params as number);
	});
});

describe('RPC endpoint in app surface', () => {
	test('endpoint route specs appear in surface.routes', () => {
		const route_specs = create_rpc_endpoint({
			path: '/api/rpc',
			actions: [
				{spec: create_post_spec(), handler: () => ({})},
				{spec: create_get_spec(), handler: () => ({})},
			],
			log,
		});

		const surface = generate_app_surface({middleware_specs: [], route_specs});

		// two route entries (POST + GET on same path)
		assert.strictEqual(surface.routes.length, 2);
		assert.strictEqual(surface.routes[0]!.method, 'POST');
		assert.strictEqual(surface.routes[0]!.path, '/api/rpc');
		assert.strictEqual(surface.routes[1]!.method, 'GET');
		assert.strictEqual(surface.routes[1]!.path, '/api/rpc');
	});

	test('rpc_endpoints populated when passed to generate_app_surface', () => {
		const actions: Array<RpcAction> = [
			{spec: create_post_spec(), handler: () => ({})},
			{spec: create_get_spec(), handler: () => ({})},
		];
		const route_specs = create_rpc_endpoint({path: '/api/rpc', actions, log});

		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs,
			rpc_endpoints: [{path: '/api/rpc', actions}],
		});

		assert.deepStrictEqual(surface.rpc_endpoints, [
			{
				path: '/api/rpc',
				methods: [
					{
						name: 'thing_create',
						auth: {account: 'required', actor: 'none'},
						input_schema: surface.rpc_endpoints[0]!.methods[0]!.input_schema, // JSON Schema, non-trivial to inline
						output_schema: surface.rpc_endpoints[0]!.methods[0]!.output_schema,
						side_effects: true,
						description: 'Create a thing',
						rate_limit_key: null,
					},
					{
						name: 'thing_list',
						auth: {account: 'none', actor: 'none'},
						input_schema: null,
						output_schema: surface.rpc_endpoints[0]!.methods[1]!.output_schema,
						side_effects: false,
						description: 'List things',
						rate_limit_key: null,
					},
				],
			},
		]);
		// verify schemas are populated (not just null)
		assert.ok(surface.rpc_endpoints[0]!.methods[0]!.input_schema);
		assert.ok(surface.rpc_endpoints[0]!.methods[0]!.output_schema);
		assert.ok(surface.rpc_endpoints[0]!.methods[1]!.output_schema);
		// null input produces null schema
		assert.strictEqual(surface.rpc_endpoints[0]!.methods[1]!.input_schema, null);
	});
});

describe('ActionContext notify + signal', () => {
	test('ctx.notify is a function and no-ops on HTTP transport', async () => {
		let captured_notify: ((method: string, params: unknown) => void) | null = null;
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: (_input, ctx) => {
					captured_notify = ctx.notify;
					// invoking should not throw — HTTP transport drops notifications
					ctx.notify('something_progress', {foo: 'bar'});
					return {items: []};
				},
			},
		]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_list'),
		});
		assert.strictEqual(res.status, 200);
		assert.strictEqual(typeof captured_notify, 'function');
	});

	test('ctx.signal is an AbortSignal tied to the Hono request', async () => {
		let captured_signal: unknown = null;
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: (_input, ctx) => {
					captured_signal = ctx.signal;
					return {items: []};
				},
			},
		]);

		const res = await app.request('/api/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: rpc_request('thing_list'),
		});
		assert.strictEqual(res.status, 200);
		assert.ok(captured_signal instanceof AbortSignal);
	});

	test('ctx.signal reflects request abort', async () => {
		const controller = new AbortController();
		let captured_signal: unknown = null;
		const app = create_test_app([
			{
				spec: create_get_spec(),
				handler: (_input, ctx) => {
					captured_signal = ctx.signal;
					// abort before we return to simulate client disconnect mid-request
					controller.abort();
					return {items: []};
				},
			},
		]);

		await app.request(
			new Request('http://localhost/api/rpc', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: rpc_request('thing_list'),
				signal: controller.signal,
			}),
		);
		assert.ok(captured_signal instanceof AbortSignal);
		assert.strictEqual(captured_signal.aborted, true);
	});
});

describe('rate limit', () => {
	const make_limiter = (max_attempts: number): RateLimiter =>
		new RateLimiter({
			max_attempts,
			window_ms: 60_000,
			cleanup_interval_ms: 0,
			max_keys: null,
		});

	const account_keyed_spec = (): RequestResponseActionSpec => ({
		method: 'thing_throttled',
		kind: 'request_response',
		initiator: 'frontend',
		auth: {account: 'required', actor: 'none'},
		side_effects: true,
		input: z.strictObject({name: z.string()}),
		output: z.strictObject({ok: z.literal(true)}),
		async: true,
		description: 'Account-keyed throttled action',
		rate_limit: 'account',
	});

	test('registration rejects public + account-keyed', () => {
		const bad_spec: RequestResponseActionSpec = {
			...account_keyed_spec(),
			auth: {account: 'none', actor: 'none'},
		};
		assert.throws(
			() =>
				create_rpc_endpoint({
					path: '/api/rpc',
					actions: [{spec: bad_spec, handler: () => ({ok: true as const})}],
					log,
				}),
			/auth\.account !== 'required'.*account-keyed/,
		);
	});

	test('registration rejects public + both', () => {
		const bad_spec: RequestResponseActionSpec = {
			...account_keyed_spec(),
			auth: {account: 'none', actor: 'none'},
			rate_limit: 'both',
		};
		assert.throws(
			() =>
				create_rpc_endpoint({
					path: '/api/rpc',
					actions: [{spec: bad_spec, handler: () => ({ok: true as const})}],
					log,
				}),
			/auth\.account !== 'required'.*account-keyed/,
		);
	});

	test('registration allows public + ip-keyed', () => {
		const ok_spec: RequestResponseActionSpec = {
			...account_keyed_spec(),
			auth: {account: 'none', actor: 'none'},
			rate_limit: 'ip',
		};
		assert.doesNotThrow(() =>
			create_rpc_endpoint({
				path: '/api/rpc',
				actions: [{spec: ok_spec, handler: () => ({ok: true as const})}],
				log,
			}),
		);
	});

	test('account limiter blocks once exhausted', async () => {
		const limiter = make_limiter(2);
		const auth_context = create_test_request_context();
		const app = new Hono();
		app.use('/*', async (c, next) => {
			(c as any).set(ACCOUNT_ID_KEY, auth_context.account.id);
			(c as any).set(REQUEST_CONTEXT_KEY, auth_context);
			(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
			(c as any).set(CREDENTIAL_TYPE_KEY, 'session' as CredentialType);
			await next();
		});
		const route_specs = create_rpc_endpoint({
			path: '/api/rpc',
			actions: [{spec: account_keyed_spec(), handler: () => ({ok: true as const})}],
			log,
			action_account_rate_limiter: limiter,
		});
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const send = () =>
			app.request(
				new Request('http://localhost/api/rpc', {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: rpc_request('thing_throttled', {name: 'a'}),
				}),
			);

		const first = await (await send()).json();
		assert.strictEqual(first.result?.ok, true);
		const second = await (await send()).json();
		assert.strictEqual(second.result?.ok, true);
		const third_response = await send();
		const third = await third_response.json();
		assert.strictEqual(third_response.status, 429);
		assert.strictEqual(third.error?.code, JSONRPC_ERROR_CODES.rate_limited);
		assert.strictEqual(typeof third.error?.data?.retry_after, 'number');
	});

	test('per-account isolation — separate budgets', async () => {
		const limiter = make_limiter(1);
		// Account-keyed rate limiting hashes on `account.id`. `create_test_request_context()`
		// returns the shared default account; build a second context with a
		// distinct account so the two contexts hash to different buckets.
		const actor_a = create_test_request_context();
		const base_b = create_test_request_context();
		const actor_b = {
			...base_b,
			account: {...base_b.account, id: 'acc_2' as Uuid, username: 'beta'},
			actor: create_test_actor({id: 'act_2', account_id: 'acc_2'}),
		};

		const make_app = (auth_context: ReturnType<typeof create_test_request_context>) => {
			const app = new Hono();
			app.use('/*', async (c, next) => {
				(c as any).set(ACCOUNT_ID_KEY, auth_context.account.id);
				(c as any).set(REQUEST_CONTEXT_KEY, auth_context);
				(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
				(c as any).set(CREDENTIAL_TYPE_KEY, 'session' as CredentialType);
				await next();
			});
			const route_specs = create_rpc_endpoint({
				path: '/api/rpc',
				actions: [{spec: account_keyed_spec(), handler: () => ({ok: true as const})}],
				log,
				action_account_rate_limiter: limiter,
			});
			apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);
			return app;
		};

		const app_a = make_app(actor_a);
		const app_b = make_app(actor_b);

		const send_a = () =>
			app_a.request(
				new Request('http://localhost/api/rpc', {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: rpc_request('thing_throttled', {name: 'a'}),
				}),
			);
		const send_b = () =>
			app_b.request(
				new Request('http://localhost/api/rpc', {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: rpc_request('thing_throttled', {name: 'b'}),
				}),
			);

		// account a consumes their entire budget
		assert.strictEqual((await (await send_a()).json()).result?.ok, true);
		assert.strictEqual((await send_a()).status, 429);
		// account b has not started — still allowed
		assert.strictEqual((await (await send_b()).json()).result?.ok, true);
	});

	test('action without rate_limit is unaffected', async () => {
		const limiter = make_limiter(1);
		const auth_context = create_test_request_context();
		const app = new Hono();
		app.use('/*', async (c, next) => {
			(c as any).set(ACCOUNT_ID_KEY, auth_context.account.id);
			(c as any).set(REQUEST_CONTEXT_KEY, auth_context);
			(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
			(c as any).set(CREDENTIAL_TYPE_KEY, 'session' as CredentialType);
			await next();
		});
		// post_spec has no rate_limit set
		const route_specs = create_rpc_endpoint({
			path: '/api/rpc',
			actions: [{spec: create_post_spec(), handler: () => ({id: 'x'})}],
			log,
			action_account_rate_limiter: limiter,
		});
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const send = () =>
			app.request(
				new Request('http://localhost/api/rpc', {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: rpc_request('thing_create', {name: 'x'}),
				}),
			);

		// budget is 1 but the action ignores it — both calls succeed.
		assert.strictEqual((await (await send()).json()).result?.id, 'x');
		assert.strictEqual((await (await send()).json()).result?.id, 'x');
	});

	test('null limiter skips check (silent partial enforcement)', async () => {
		const auth_context = create_test_request_context();
		const app = new Hono();
		app.use('/*', async (c, next) => {
			(c as any).set(ACCOUNT_ID_KEY, auth_context.account.id);
			(c as any).set(REQUEST_CONTEXT_KEY, auth_context);
			(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
			(c as any).set(CREDENTIAL_TYPE_KEY, 'session' as CredentialType);
			await next();
		});
		const route_specs = create_rpc_endpoint({
			path: '/api/rpc',
			actions: [{spec: account_keyed_spec(), handler: () => ({ok: true as const})}],
			log,
			// no limiter wired — declared `rate_limit: 'account'` is silently a no-op
		});
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const send = () =>
			app.request(
				new Request('http://localhost/api/rpc', {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: rpc_request('thing_throttled', {name: 'a'}),
				}),
			);

		// 100 calls all pass because no limiter is wired
		for (let i = 0; i < 5; i++) {
			assert.strictEqual((await (await send()).json()).result?.ok, true);
		}
	});

	test('surface exposes rate_limit_key on RPC method', () => {
		const actions = [{spec: account_keyed_spec(), handler: () => ({ok: true as const})}];
		const route_specs = create_rpc_endpoint({path: '/api/rpc', actions, log});
		const surface = generate_app_surface({
			middleware_specs: [],
			route_specs,
			rpc_endpoints: [{path: '/api/rpc', actions}],
		});
		assert.strictEqual(surface.rpc_endpoints[0]!.methods[0]!.rate_limit_key, 'account');
	});
});
