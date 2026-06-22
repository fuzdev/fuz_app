/**
 * Tests for `create_frontend_rpc_client` — bundles
 * `ActionRegistry + ActionEventEnvironment + Transports + ActionDispatcher +
 * create_rpc_client + create_throwing_api` into one factory call.
 *
 * The factory returns both Proxy shapes: `api` (typed throwing) and
 * `api_result` (typed Result-shaped). Tests below exercise both — the
 * Result-shape tests use `api_result` because they assert the
 * `{ok, value}` envelope; the throwing-shape tests use `api`.
 *
 * @module
 */

import {describe, assert, test, vi} from 'vitest';
import {z} from 'zod';

import {create_frontend_rpc_client} from '$lib/actions/frontend_rpc_client.ts';
import {ActionDispatcher} from '$lib/actions/action_dispatcher.ts';
import {FrontendHttpTransport} from '$lib/actions/transports_http.ts';
import type {Transport} from '$lib/actions/transports.ts';
import type {ActionSpecUnion, RequestResponseActionSpec} from '$lib/actions/action_spec.ts';
import type {Result} from '@fuzdev/fuz_util/result.ts';
import type {JsonrpcErrorObject} from '$lib/http/jsonrpc.ts';

const ping_spec = {
	method: 'ping',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'none', actor: 'none'},
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
	auth: {account: 'none', actor: 'none'},
	side_effects: true,
	input: z.strictObject({message: z.string()}),
	output: z.strictObject({message: z.string()}),
	async: true,
	description: 'Echo back the input',
} satisfies ActionSpecUnion;

/** Shared typed surface for the `ping_spec` — used across runtime + type-check tests. */
interface PingApi {
	ping: (input?: null) => Promise<Result<{value: {pong: true}}, {error: JsonrpcErrorObject}>>;
}

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
		const {peer} = create_frontend_rpc_client<PingApi>({specs: [ping_spec]});
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
			const default_client = create_frontend_rpc_client<PingApi>({specs: [ping_spec]});
			await default_client.api_result.ping(null);
			assert.strictEqual(fetch_spy.mock.calls[0]![0], '/api/rpc');

			fetch_spy.mockClear();
			const custom_client = create_frontend_rpc_client<PingApi>({
				specs: [ping_spec],
				path: '/api/v2/rpc',
			});
			await custom_client.api_result.ping(null);
			assert.strictEqual(fetch_spy.mock.calls[0]![0], '/api/v2/rpc');
		} finally {
			fetch_spy.mockRestore();
		}
	});

	test('explicit transports replace the default; no FrontendHttpTransport registered', () => {
		const ws_like = create_recording_transport('frontend_websocket_rpc');
		const {peer} = create_frontend_rpc_client<PingApi>({
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
		const {environment} = create_frontend_rpc_client<PingApi>({specs: [ping_spec]});
		assert.strictEqual(environment.executor, 'frontend');
	});

	test('environment.lookup_action_handler always returns undefined', () => {
		const {environment} = create_frontend_rpc_client<PingApi>({specs: [ping_spec]});
		assert.strictEqual(environment.lookup_action_handler('ping', 'send_request'), undefined);
		assert.strictEqual(environment.lookup_action_handler('anything', 'execute'), undefined);
	});

	test('environment.lookup_action_spec resolves registered specs and returns undefined for unknown', () => {
		const {environment} = create_frontend_rpc_client<PingApi>({specs: [ping_spec, echo_spec]});
		assert.strictEqual(environment.lookup_action_spec('ping'), ping_spec);
		assert.strictEqual(environment.lookup_action_spec('echo'), echo_spec);
		assert.strictEqual(environment.lookup_action_spec('missing'), undefined);
	});

	test('returned peer is an ActionDispatcher wired to the same environment', () => {
		const {peer, environment} = create_frontend_rpc_client<PingApi>({specs: [ping_spec]});
		assert.instanceOf(peer, ActionDispatcher);
		assert.strictEqual(peer.environment, environment);
	});

	test('api_result dispatches a request_response method through the registered transport', async () => {
		const recording = create_recording_transport('frontend_http_rpc');
		const {api_result} = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [recording],
		});
		const result = await api_result.ping(null);
		assert.strictEqual(recording.sent.length, 1, 'transport should have been invoked exactly once');
		const sent = recording.sent[0] as {method: string; params: unknown};
		assert.strictEqual(sent.method, 'ping');
		assert.isTrue(result.ok, `expected ok result, got ${JSON.stringify(result)}`);
		assert.deepStrictEqual(result.value, {pong: true});
	});

	test('api unwraps the same dispatch to the bare value (throwing form)', async () => {
		const recording = create_recording_transport('frontend_http_rpc');
		const {api} = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [recording],
		});
		// `api` is the typed throwing Proxy — the Result wrapper is stripped.
		const value = await api.ping(null);
		assert.deepStrictEqual(value, {pong: true});
	});

	test('api and api_result share the same underlying transport (one dispatch each)', async () => {
		const recording = create_recording_transport('frontend_http_rpc');
		const {api, api_result} = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [recording],
		});
		await api.ping(null);
		await api_result.ping(null);
		// Both Proxies must hit the same transport — pick-per-call-site has no
		// construction cost.
		assert.strictEqual(recording.sent.length, 2);
	});

	test('api_result returns undefined for methods absent from specs', () => {
		const {api_result} = create_frontend_rpc_client<Record<string, unknown>>({
			specs: [ping_spec],
		});
		assert.strictEqual(api_result.missing, undefined);
	});

	test('api throws "rpc method not found" for methods absent from specs', () => {
		// `api` is the throwing Proxy — its get trap returns a thrower for
		// unknown string-keyed methods (matches `create_throwing_api`'s
		// behavior). `typeof api.missing === 'function'` so probe-then-call
		// patterns don't blow up at access time.
		const {api} = create_frontend_rpc_client<Record<string, unknown>>({specs: [ping_spec]});
		assert.strictEqual(typeof (api as any).missing, 'function');
		assert.throws(() => (api as any).missing(), /rpc method not found: missing/);
	});

	test('transport_for_method routes per-method dispatch (pass-through to create_rpc_client)', async () => {
		// Pin the factory's `transport_for_method` pass-through. tx-style
		// mixed setups (request_response over WS, REST RPC over HTTP)
		// depend on this option reaching the underlying client.
		const ws = create_recording_transport('frontend_websocket_rpc');
		const http = create_recording_transport('frontend_http_rpc');
		const {api_result} = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [http, ws],
			transport_for_method: (method) => (method === 'ping' ? 'frontend_websocket_rpc' : undefined),
		});
		await api_result.ping(null);
		assert.strictEqual(ws.sent.length, 1, 'ping must land on the WS transport');
		assert.strictEqual(http.sent.length, 0, 'HTTP transport must not be touched');
	});

	test('on_action_event fires once per dispatch with the live ActionEvent (pass-through to create_rpc_client)', async () => {
		// Pin the factory's `on_action_event` pass-through. zzz-style consumers
		// thread the live `ActionEvent` into a reactive Cell so observers
		// (`pending` / `failed` / `value` derivations) wire up before the
		// dispatch's first `parse()` transition.
		const recording = create_recording_transport('frontend_http_rpc');
		const observed: Array<{method: string; event: unknown}> = [];
		const {api_result} = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [recording],
			on_action_event: (event) => {
				observed.push({method: event.spec.method, event});
			},
		});
		await api_result.ping(null);
		assert.strictEqual(observed.length, 1, 'callback must fire once per dispatch');
		assert.strictEqual(observed[0]!.method, 'ping');
		assert.ok(observed[0]!.event, 'the live ActionEvent must be passed through');
	});
});

describe('create_frontend_rpc_client — type-only fixtures', () => {
	// Compile-time assertions: if `TApi` stops flowing through to
	// `api_result` (raw), or `ThrowingApi<TApi>` stops flowing through to
	// `api` (unwrapped), these stop compiling and `gro check` fails
	// before any runtime test runs.
	test('TApi flows through to api_result; ThrowingApi<TApi> flows through to api', () => {
		interface MyApi {
			ping: (input?: null) => Promise<Result<{value: {pong: true}}, {error: JsonrpcErrorObject}>>;
			toggle: (input?: {
				on: boolean;
			}) => Promise<Result<{value: void}, {error: JsonrpcErrorObject}>>;
		}

		// Never executed — types only. Wrapping in a never-called arrow keeps
		// the runtime side a no-op.
		const _check = (): void => {
			const {api, api_result, peer} = create_frontend_rpc_client<MyApi>({
				specs: [ping_spec satisfies RequestResponseActionSpec],
			});
			// api_result preserves the original Result-shaped signatures.
			const _ping_result_check: MyApi['ping'] = api_result.ping;
			const _toggle_result_check: MyApi['toggle'] = api_result.toggle;
			// api strips Promise<Result<{value: T}>> → Promise<T>.
			const _ping_throwing_check: (input?: null) => Promise<{pong: true}> = api.ping;
			const _toggle_throwing_check: (input?: {on: boolean}) => Promise<void> = api.toggle;
			const _peer_check: ActionDispatcher = peer;
			void _ping_result_check;
			void _toggle_result_check;
			void _ping_throwing_check;
			void _toggle_throwing_check;
			void _peer_check;
		};
		void _check;
		assert.ok(true);
	});

	test('on_action_event narrows event.spec.method and event.data.method to keyof TApi & string', () => {
		interface MyApi {
			ping: (input?: null) => Promise<Result<{value: {pong: true}}, {error: JsonrpcErrorObject}>>;
			toggle: (input?: {
				on: boolean;
			}) => Promise<Result<{value: void}, {error: JsonrpcErrorObject}>>;
		}

		const _check = (): void => {
			create_frontend_rpc_client<MyApi>({
				specs: [ping_spec satisfies RequestResponseActionSpec],
				on_action_event: (event) => {
					// If the callback widens back to `ActionEvent` / `ActionEvent<string>`,
					// these literal-union assignments stop compiling.
					const _spec_method_check: 'ping' | 'toggle' = event.spec.method;
					const _data_method_check: 'ping' | 'toggle' = event.data.method;
					void _spec_method_check;
					void _data_method_check;
				},
			});
		};
		void _check;
		assert.ok(true);
	});
});
