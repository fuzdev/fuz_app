/**
 * The assembled app refuses to boot on a schema slot holding a value of
 * neither library, the throw naming the spec and the slot: an `rpc_endpoints`
 * action's at registration (`compile_action_registry`), a route's, an
 * event's and a `ws_endpoints` action's in surface generation
 * (`schema_to_surface`), and a route's `null` `params`, which surface
 * generation skips, at route registration (`apply_route_specs`). Assembly
 * fails before any database work, so the database throws on every call.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';
import { object } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_app_server, type AppServerOptions } from '#lib/server/app_server.ts';
import { Db } from '#lib/db/db.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import { create_realtime_closer } from '#lib/actions/connection_closer.ts';
import { parse_allowed_origins } from '#lib/http/origin.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import type { RpcAction } from '#lib/actions/action_types.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import { create_stub_upgrade } from '#lib/testing/ws_round_trip.ts';
import { create_test_keyring } from '../auth/session_test_helpers.ts';

const log = new Logger('test', { level: 'off' });

const boot = async (overrides: Partial<AppServerOptions>): Promise<unknown> => {
	const origins = parse_allowed_origins('http://localhost:5173');
	assert.ok(origins.ok);
	const refuse = (): never => {
		throw new Error('the database was reached');
	};
	const db = new Db({ client: { query: refuse }, transaction: refuse });
	return create_app_server({
		backend: {
			db_type: 'pglet-memory',
			db_name: '(memory)',
			migration_results: [],
			close: async () => {},
			deps: {
				log,
				keyring: create_test_keyring('test-key-that-is-at-least-32-chars-long!!'),
				password: { hash_password: refuse, verify_password: refuse, verify_dummy: refuse },
				db,
				audit: create_audit_emitter({ db, log }),
				connection_closer: create_realtime_closer(),
				read_secure_file: refuse,
				delete_file: refuse
			}
		},
		session_options: create_session_config('test_session'),
		allowed_origins: origins.origins,
		env_schema: object({}),
		proxy: { trusted_proxies: ['127.0.0.1'], get_connection_ip: () => '127.0.0.1' },
		create_route_specs: () => [],
		...overrides
	});
};

// the message of the error a boot throws; the test fails if it boots
const boot_error = async (overrides: Partial<AppServerOptions>): Promise<string> => {
	let thrown: unknown;
	try {
		await boot(overrides);
	} catch (error) {
		thrown = error;
	}
	assert.instanceOf(thrown, Error);
	return thrown.message;
};

const route = (overrides: Record<string, unknown>): RouteSpec => ({
	method: 'POST',
	path: '/api/things',
	auth: { account: 'none', actor: 'none' },
	description: 'Takes a thing.',
	input: z.strictObject({ name: z.string() }),
	output: z.strictObject({ ok: z.literal(true) }),
	handler: (c) => c.json({ ok: true }),
	...overrides
});

const action = (slots: { input?: unknown; output?: unknown }): RpcAction =>
	({
		spec: {
			method: 'take_thing',
			kind: 'request_response',
			initiator: 'frontend',
			auth: { account: 'none', actor: 'none' },
			side_effects: false,
			input: z.strictObject({ name: z.string() }),
			output: z.strictObject({ ok: z.literal(true) }),
			async: true,
			description: 'Takes a thing.',
			...slots
		},
		handler: async () => ({ ok: true })
	}) as unknown as RpcAction;

const rpc_endpoints = (a: RpcAction): AppServerOptions['rpc_endpoints'] => [
	{ path: '/api/rpc', actions: [a] }
];

describe('create_app_server on a schema slot of neither library', () => {
	test("an rpc_endpoints action's slot throws at boot, naming the action and the slot", async () => {
		assert.strictEqual(
			await boot_error({ rpc_endpoints: rpc_endpoints(action({ output: {} })) }),
			'RPC action "take_thing": output is neither a Zod schema nor a @fuzdev/fuz_schema schema'
		);
	});

	test("a route's slot throws at boot, naming the route and the slot", async () => {
		assert.strictEqual(
			await boot_error({ create_route_specs: () => [route({ output: {} })] }),
			'POST /api/things output is neither a Zod schema nor a @fuzdev/fuz_schema schema'
		);
	});

	test("a route's null params throws at boot, naming the route and the slot", async () => {
		assert.strictEqual(
			await boot_error({
				create_route_specs: () => [route({ path: '/api/things/:id', params: null })]
			}),
			'Route "POST /api/things/:id": params is neither a Zod schema nor a @fuzdev/fuz_schema schema'
		);
	});

	test("an event spec's params throws at boot, naming the event", async () => {
		assert.strictEqual(
			await boot_error({
				event_specs: [{ method: 'thing_happened', description: 'A thing happened.', params: {} }]
			} as unknown as Partial<AppServerOptions>),
			'event thing_happened params is neither a Zod schema nor a @fuzdev/fuz_schema schema'
		);
	});

	test("a ws_endpoints action's slot throws at boot, naming the endpoint, the action and the slot", async () => {
		assert.strictEqual(
			await boot_error({
				create_upgrade_websocket: () => create_stub_upgrade().upgradeWebSocket,
				ws_endpoints: [{ path: '/api/ws', actions: [action({ input: {} })], receive_timeout: null }]
			}),
			'/api/ws take_thing input is neither a Zod schema nor a @fuzdev/fuz_schema schema'
		);
	});

	test('boots on a schema in every slot, an errors entry left undefined included', async () => {
		await boot({
			create_route_specs: () => [route({ errors: { 404: undefined } })],
			rpc_endpoints: rpc_endpoints(action({}))
		});
	});
});
