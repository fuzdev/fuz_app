/**
 * Tests for `create_frontend_rpc_client` — bundles
 * `ActionRegistry + ActionEventEnvironment + Transports + ActionPeer +
 * create_rpc_client` into one factory call.
 *
 * Variable convention follows the recommended consumer pattern: the
 * underlying Result-returning Proxy is bound to `api_raw` (returned
 * here as `api`), the throwing wrapper to `api`. These tests use the
 * `api` field directly because they exercise Result-shaped returns.
 *
 * @module
 */

import {describe, assert, test, vi} from 'vitest';
import {z} from 'zod';

import {create_frontend_rpc_client} from '$lib/actions/frontend_rpc_client.js';
import {ActionPeer} from '$lib/actions/action_peer.js';
import {FrontendHttpTransport} from '$lib/actions/transports_http.js';
import type {Transport} from '$lib/actions/transports.js';
import type {ActionSpecUnion, RequestResponseActionSpec} from '$lib/actions/action_spec.js';
import type {Result} from '@fuzdev/fuz_util/result.js';
import type {JsonrpcErrorObject} from '$lib/http/jsonrpc.js';

const ping_spec = {
	method: 'ping',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: false,
	input: z.null(),
	output: z.strictObject({pong: z.literal(true)}),
	async: true,
	description: 'Health check',
} satisfies ActionSpecUnion;

const echo_spec = {
	method: 'echo',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({message: z.string()}),
	output: z.strictObject({message: z.string()}),
	async: true,
	description: 'Echo back the input',
} satisfies ActionSpecUnion;

/** Transport that records sends and replies with a canned response. */
const create_recording_transport = (name: string): Transport & {sent: Array<unknown>} => {
	const sent: Array<unknown> = [];
	return {
		transport_name: name,
		sent,
		send: (async (message: any) => {
			sent.push(message);
			if ('id' in message) {
				return {jsonrpc: '2.0', id: message.id, result: {pong: true}};
			}
			return null;
		}) as Transport['send'],
		is_ready: () => true,
	};
};

describe('create_frontend_rpc_client', () => {
	test('registers a default FrontendHttpTransport when transports omitted', () => {
		const {peer} = create_frontend_rpc_client({specs: [ping_spec]});
		const transport = peer.transports.get_transport();
		assert.ok(transport, 'a transport must be registered');
		assert.instanceOf(transport, FrontendHttpTransport);
		assert.strictEqual(transport.transport_name, 'frontend_http_rpc');
	});

	test('default path is /api/rpc; overrideable via path option', async () => {
		const fetch_spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({jsonrpc: '2.0', id: 1, result: {pong: true}}), {
				status: 200,
				headers: {'content-type': 'application/json'},
			}),
		);
		try {
			const default_client = create_frontend_rpc_client({specs: [ping_spec]});
			await (default_client.api as any).ping(null);
			assert.strictEqual(fetch_spy.mock.calls[0]![0], '/api/rpc');

			fetch_spy.mockClear();
			const custom_client = create_frontend_rpc_client({
				specs: [ping_spec],
				path: '/api/v2/rpc',
			});
			await (custom_client.api as any).ping(null);
			assert.strictEqual(fetch_spy.mock.calls[0]![0], '/api/v2/rpc');
		} finally {
			fetch_spy.mockRestore();
		}
	});

	test('explicit transports replace the default; no FrontendHttpTransport registered', () => {
		const ws_like = create_recording_transport('frontend_websocket_rpc');
		const {peer} = create_frontend_rpc_client({
			specs: [ping_spec],
			transports: [ws_like],
		});
		const transport = peer.transports.get_transport();
		assert.strictEqual(transport, ws_like);
		assert.strictEqual(
			peer.transports.get_transport_by_name('frontend_http_rpc'),
			null,
			'default HTTP transport must NOT be registered when transports is provided',
		);
	});

	test('environment.executor is frontend', () => {
		const {environment} = create_frontend_rpc_client({specs: [ping_spec]});
		assert.strictEqual(environment.executor, 'frontend');
	});

	test('environment.lookup_action_handler always returns undefined', () => {
		const {environment} = create_frontend_rpc_client({specs: [ping_spec]});
		assert.strictEqual(environment.lookup_action_handler('ping', 'send_request'), undefined);
		assert.strictEqual(environment.lookup_action_handler('anything', 'execute'), undefined);
	});

	test('environment.lookup_action_spec resolves registered specs and returns undefined for unknown', () => {
		const {environment} = create_frontend_rpc_client({specs: [ping_spec, echo_spec]});
		assert.strictEqual(environment.lookup_action_spec('ping'), ping_spec);
		assert.strictEqual(environment.lookup_action_spec('echo'), echo_spec);
		assert.strictEqual(environment.lookup_action_spec('missing'), undefined);
	});

	test('returned peer is an ActionPeer wired to the same environment', () => {
		const {peer, environment} = create_frontend_rpc_client({specs: [ping_spec]});
		assert.instanceOf(peer, ActionPeer);
		assert.strictEqual(peer.environment, environment);
	});

	test('api dispatches a request_response method through the registered transport', async () => {
		const recording = create_recording_transport('frontend_http_rpc');
		interface PingApi {
			ping: (input?: null) => Promise<Result<{value: {pong: true}}, {error: JsonrpcErrorObject}>>;
		}
		const {api} = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [recording],
		});
		const result = await api.ping(null);
		assert.strictEqual(recording.sent.length, 1, 'transport should have been invoked exactly once');
		const sent = recording.sent[0] as {method: string; params: unknown};
		assert.strictEqual(sent.method, 'ping');
		assert.isTrue(result.ok, `expected ok result, got ${JSON.stringify(result)}`);
		assert.deepStrictEqual(result.value, {pong: true});
	});

	test('api returns undefined for methods absent from specs', () => {
		const {api} = create_frontend_rpc_client<Record<string, unknown>>({specs: [ping_spec]});
		assert.strictEqual(api.missing, undefined);
	});
});

describe('create_frontend_rpc_client — type-only fixtures', () => {
	// Compile-time assertions: if the generic `TApi` stops flowing through
	// `FrontendRpcClient<TApi>['api']`, these stop compiling and `gro check`
	// fails before any runtime test runs.
	test('TApi flows through to the api field', () => {
		interface MyApi {
			ping: (input?: null) => Promise<Result<{value: {pong: true}}, {error: JsonrpcErrorObject}>>;
			toggle: (input?: {
				on: boolean;
			}) => Promise<Result<{value: void}, {error: JsonrpcErrorObject}>>;
		}

		// Never executed — types only. Wrapping in a never-called arrow keeps
		// the runtime side a no-op.
		const _check = (): void => {
			const {api, peer} = create_frontend_rpc_client<MyApi>({
				specs: [ping_spec satisfies RequestResponseActionSpec],
			});
			const _ping_check: MyApi['ping'] = api.ping;
			const _toggle_check: MyApi['toggle'] = api.toggle;
			const _peer_check: ActionPeer = peer;
			void _ping_check;
			void _toggle_check;
			void _peer_check;
		};
		void _check;
		assert.ok(true);
	});
});
