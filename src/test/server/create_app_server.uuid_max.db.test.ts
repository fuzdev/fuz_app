/**
 * The max UUID in upper or mixed case through the assembled app: a `Uuid`
 * params field, an `ActingActor` on a REST `query`, and a `Uuid` RPC
 * input field each take it past validation, lowercased, as the Rust spine's
 * `is_valid_uuid` does, rather than answering 400 / `invalid_params`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { literal, object, string, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_test_app } from '#lib/testing/app_server.ts';
import { TEST_ORIGIN } from '#lib/testing/test_origin.ts';
import {
	ERROR_ACTOR_NOT_ON_ACCOUNT,
	ERROR_INVALID_QUERY_PARAMS,
	ERROR_INVALID_ROUTE_PARAMS
} from '#lib/http/error_schemas.ts';
import { JSONRPC_INVALID_PARAMS } from '#lib/http/jsonrpc.ts';
import { define_route, get_route_params, type RouteSpec } from '#lib/http/route_spec.ts';
import { route_ok } from '#lib/http/route_result.ts';

import { describe_db } from '../auth_db_default.ts';
import { ActingActor, Uuid } from '#lib/primitive_schemas.ts';

const session_options = create_session_config('test_session');

const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const MAX_UUID_CASES = [
	'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
	'ffffffff-FFFF-ffff-FFFF-ffffffffffff'
];

// off-grammar spellings each layer must still refuse: the control that shows
// the max is taken by the grammar, not because validation was skipped
const OFF_GRAMMAR_CASES = [
	'not-a-uuid',
	'{a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d}',
	'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFE'
];

const ThingParams = object({ id: Uuid });
const ActingQuery = object({ acting: ActingActor });

const create_route_specs = (): Array<RouteSpec> => [
	define_route({
		method: 'GET',
		path: '/api/things/:id',
		auth: { account: 'required', actor: 'none' },
		description: 'Echo the validated id param',
		params: ThingParams,
		input: literal(null),
		output: object({ id: string }),
		handler: (c) => route_ok({ id: get_route_params(c, ThingParams).id })
	}),
	define_route({
		method: 'GET',
		path: '/api/acting_echo',
		auth: { account: 'required', actor: 'required' },
		description: 'Answer with the resolved actor',
		query: ActingQuery,
		input: literal(null),
		output: object({ ok: literal(true) }),
		handler: () => route_ok({ ok: true as const })
	})
];

const EchoInput = object({ id: Uuid });

const echo_spec = {
	method: 'test_uuid_echo',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: EchoInput,
	output: object({ id: string }),
	async: true,
	description: 'Echoes the validated id.'
} as const;

const rpc_endpoints = [
	{
		path: '/api/rpc',
		actions: [
			{
				spec: echo_spec,
				handler: async (input: unknown) => ({ id: (input as Infer<typeof EchoInput>).id })
			}
		]
	}
];

describe_db('the max UUID in any case through the assembled app', (get_db) => {
	const setup = () =>
		create_test_app({ session_options, create_route_specs, rpc_endpoints, db: get_db() });

	describe('REST', () => {
		test('a Uuid params field takes it, lowercased', async () => {
			const test_app = await setup();
			for (const id of MAX_UUID_CASES) {
				const res = await test_app.app.request(`/api/things/${id}`, {
					headers: test_app.create_session_headers()
				});
				const body = await res.json();
				assert.strictEqual(res.status, 200, JSON.stringify(body));
				assert.deepEqual(body, { id: MAX_UUID });
			}
		});

		test('an ActingActor query takes it, and the authorization phase refuses the actor', async () => {
			const test_app = await setup();
			for (const acting of MAX_UUID_CASES) {
				const res = await test_app.app.request(`/api/acting_echo?acting=${acting}`, {
					headers: test_app.create_session_headers()
				});
				// past query validation (no `invalid_query_params`), to the actor lookup
				assert.deepEqual(await res.json(), { error: ERROR_ACTOR_NOT_ON_ACCOUNT });
			}
		});
	});

	describe('controls', () => {
		test('a Uuid params field still refuses an off-grammar id', async () => {
			const test_app = await setup();
			for (const id of OFF_GRAMMAR_CASES) {
				const res = await test_app.app.request(`/api/things/${encodeURIComponent(id)}`, {
					headers: test_app.create_session_headers()
				});
				const body = await res.json();
				assert.strictEqual(res.status, 400, `${id}: ${JSON.stringify(body)}`);
				assert.strictEqual(body.error, ERROR_INVALID_ROUTE_PARAMS, id);
			}
		});

		test('an ActingActor query still refuses an off-grammar selector', async () => {
			const test_app = await setup();
			for (const acting of OFF_GRAMMAR_CASES) {
				const res = await test_app.app.request(
					`/api/acting_echo?acting=${encodeURIComponent(acting)}`,
					{ headers: test_app.create_session_headers() }
				);
				const body = await res.json();
				assert.strictEqual(res.status, 400, `${acting}: ${JSON.stringify(body)}`);
				assert.strictEqual(body.error, ERROR_INVALID_QUERY_PARAMS, acting);
			}
		});

		test('a Uuid input field still refuses an off-grammar id', async () => {
			const test_app = await setup();
			for (const id of OFF_GRAMMAR_CASES) {
				const res = await test_app.app.request('/api/rpc', {
					method: 'POST',
					headers: test_app.create_session_headers({
						'content-type': 'application/json',
						origin: TEST_ORIGIN
					}),
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test_uuid_echo', params: { id } })
				});
				const body = await res.json();
				assert.strictEqual(
					body.error?.code,
					JSONRPC_INVALID_PARAMS,
					`${id}: ${JSON.stringify(body)}`
				);
			}
		});
	});

	describe('RPC', () => {
		test('a Uuid input field takes it, lowercased', async () => {
			const test_app = await setup();
			for (const id of MAX_UUID_CASES) {
				const res = await test_app.app.request('/api/rpc', {
					method: 'POST',
					headers: test_app.create_session_headers({
						'content-type': 'application/json',
						origin: TEST_ORIGIN
					}),
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test_uuid_echo', params: { id } })
				});
				const body = await res.json();
				assert.strictEqual(res.status, 200, JSON.stringify(body));
				assert.deepEqual(body.result, { id: MAX_UUID });
			}
		});
	});
});
