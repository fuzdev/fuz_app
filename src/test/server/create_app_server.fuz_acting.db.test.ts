/**
 * An action whose fuz_schema input declares the fuz_schema `ActingActor`
 * twin, through the assembled app: registration accepts it on an
 * actor-required spec, and the authorization phase resolves the actor from
 * its `acting` selector as it does for the Zod `ActingActor`.
 *
 * @module
 */

import { describe, test, assert, beforeAll, afterAll } from 'vitest';
import { object } from '@fuzdev/fuz_schema/schema.ts';
import { z } from 'zod';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_app_server, type AppServer } from '#lib/server/app_server.ts';
import {
	create_test_app_server,
	create_loopback_app_server_options,
	type TestAppServer
} from '#lib/testing/app_server.ts';
import { TEST_ORIGIN } from '#lib/testing/test_origin.ts';
import { ActingActor } from '#lib/primitive_schemas_fuz.ts';
import { ERROR_ACTOR_NOT_ON_ACCOUNT } from '#lib/http/error_schemas.ts';

const session_options = create_session_config('test_session');

const whoami_spec = {
	method: 'fuz_whoami',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required' },
	side_effects: false,
	input: object({ acting: ActingActor }),
	output: z.strictObject({ actor_id: z.string(), acting: z.string().nullable() }),
	async: true,
	description: 'Returns the resolved actor and the parsed selector.'
} as const;

describe('a fuz_schema input declaring the ActingActor twin', () => {
	let test_server: TestAppServer;
	let server: AppServer;

	beforeAll(async () => {
		test_server = await create_test_app_server({ session_options });
		server = await create_app_server({
			...create_loopback_app_server_options(),
			backend: test_server,
			session_options,
			create_route_specs: () => [],
			rpc_endpoints: [
				{
					path: '/api/rpc',
					actions: [
						{
							spec: whoami_spec,
							handler: async (input: unknown, ctx) => ({
								actor_id: ctx.auth!.actor!.id,
								acting: (input as { acting?: string }).acting ?? null
							})
						}
					]
				}
			]
		});
	});

	afterAll(async () => {
		await test_server.cleanup();
	});

	const call = async (params: Record<string, unknown>) => {
		const res = await server.app.request('/api/rpc', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: TEST_ORIGIN,
				cookie: `test_session=${test_server.session_cookie}`
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'fuz_whoami', params })
		});
		return { status: res.status, body: await res.json() };
	};

	test('an omitted selector resolves the sole actor', async () => {
		const { status, body } = await call({});
		assert.strictEqual(status, 200, JSON.stringify(body));
		assert.deepEqual(body.result, { actor_id: test_server.actor.id, acting: null });
	});

	test('the actor id as the selector resolves it, in either case', async () => {
		for (const acting of [test_server.actor.id, test_server.actor.id.toUpperCase()]) {
			const { status, body } = await call({ acting });
			assert.strictEqual(status, 200, JSON.stringify(body));
			assert.deepEqual(body.result, {
				actor_id: test_server.actor.id,
				acting: test_server.actor.id
			});
		}
	});

	test('the uppercase max UUID is a selector naming no actor on the account', async () => {
		const { body } = await call({ acting: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' });
		assert.isDefined(body.error, JSON.stringify(body));
		assert.strictEqual(body.error.data?.reason, ERROR_ACTOR_NOT_ON_ACCOUNT, JSON.stringify(body));
	});

	test('a malformed selector reads as omitted, then the input refuses it', async () => {
		const { body } = await call({ acting: 'not-a-uuid' });
		assert.strictEqual(body.error?.code, -32602, JSON.stringify(body));
	});
});
