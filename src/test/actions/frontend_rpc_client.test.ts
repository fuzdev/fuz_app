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

import { describe, assert, test, vi } from 'vitest';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_frontend_rpc_client } from '#lib/actions/frontend_rpc_client.ts';
import { ActionDispatcher } from '#lib/actions/action_dispatcher.ts';
import { FrontendHttpTransport } from '#lib/actions/transports_http.ts';
import {
	FrontendWebsocketTransport,
	type WebsocketRpcConnection
} from '#lib/actions/transports_ws.ts';
import { JSONRPC_ERROR_CODES, ThrownJsonrpcError } from '#lib/http/jsonrpc_errors.ts';
import type { Transport } from '#lib/actions/transports.ts';
import type { ActionSpecUnion, RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import type { JsonrpcErrorObject } from '#lib/http/jsonrpc.ts';

const ping_spec = {
	method: 'ping',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'none', actor: 'none' },
	side_effects: false,
	input: z.null(),
	output: z.strictObject({ pong: z.literal(true) }),
	async: true,
	description: 'Health check'
} satisfies ActionSpecUnion;

const echo_spec = {
	method: 'echo',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'none', actor: 'none' },
	side_effects: true,
	input: z.strictObject({ message: z.string() }),
	output: z.strictObject({ message: z.string() }),
	async: true,
	description: 'Echo back the input'
} satisfies ActionSpecUnion;

interface EchoApi {
	echo: (input: {
		message: string;
	}) => Promise<Result<{ value: { message: string } }, { error: JsonrpcErrorObject }>>;
}

/** Shared typed surface for the `ping_spec` — used across runtime + type-check tests. */
interface PingApi {
	ping: (input?: null) => Promise<Result<{ value: { pong: true } }, { error: JsonrpcErrorObject }>>;
}

/** Transport that records sends and replies with a canned response. */
const create_recording_transport = (name: string): Transport & { sent: Array<unknown> } => {
	const sent: Array<unknown> = [];
	return {
		transport_name: name,
		sent,
		send: (async (message: any) => {
			sent.push(message);
			if ('id' in message) {
				return { jsonrpc: '2.0', id: message.id, result: { pong: true } };
			}
			return null;
		}) as Transport['send'],
		is_ready: () => true
	};
};

describe('create_frontend_rpc_client', () => {
	test('registers a default FrontendHttpTransport when transports omitted', () => {
		const { peer } = create_frontend_rpc_client<PingApi>({ specs: [ping_spec] });
		const transport = peer.transports.get_transport();
		assert.ok(transport, 'a transport must be registered');
		assert.instanceOf(transport, FrontendHttpTransport);
		assert.strictEqual(transport.transport_name, 'frontend_http_rpc');
	});

	test('default path is /api/rpc; overrideable via path option', async () => {
		const fetch_spy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () =>
				Response.json({ jsonrpc: '2.0', id: 1, result: { message: 'x' } })
			);
		try {
			const default_client = create_frontend_rpc_client<EchoApi>({ specs: [echo_spec] });
			await default_client.api_result.echo({ message: 'x' });
			assert.strictEqual(fetch_spy.mock.calls[0]![0], '/api/rpc');

			fetch_spy.mockClear();
			const custom_client = create_frontend_rpc_client<EchoApi>({
				specs: [echo_spec],
				path: '/api/v2/rpc'
			});
			await custom_client.api_result.echo({ message: 'x' });
			assert.strictEqual(fetch_spy.mock.calls[0]![0], '/api/v2/rpc');
		} finally {
			fetch_spy.mockRestore();
		}
	});

	test('explicit transports replace the default; no FrontendHttpTransport registered', () => {
		const ws_like = create_recording_transport('frontend_websocket_rpc');
		const { peer } = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [ws_like]
		});
		const transport = peer.transports.get_transport();
		assert.strictEqual(transport, ws_like);
		assert.strictEqual(
			peer.transports.get_transport('frontend_http_rpc'),
			ws_like,
			'default HTTP transport must NOT be registered when transports is provided'
		);
	});

	test('environment.executor is frontend', () => {
		const { environment } = create_frontend_rpc_client<PingApi>({ specs: [ping_spec] });
		assert.strictEqual(environment.executor, 'frontend');
	});

	test('environment.lookup_action_handler always returns undefined', () => {
		const { environment } = create_frontend_rpc_client<PingApi>({ specs: [ping_spec] });
		assert.strictEqual(environment.lookup_action_handler('ping', 'send_request'), undefined);
		assert.strictEqual(environment.lookup_action_handler('anything', 'execute'), undefined);
	});

	test('log passes through to the environment, null included', () => {
		assert.strictEqual(
			create_frontend_rpc_client<PingApi>({ specs: [ping_spec] }).environment.log,
			undefined
		);
		assert.strictEqual(
			create_frontend_rpc_client<PingApi>({ specs: [ping_spec], log: null }).environment.log,
			null
		);
		const log = new Logger('[test]');
		assert.strictEqual(
			create_frontend_rpc_client<PingApi>({ specs: [ping_spec], log }).environment.log,
			log
		);
	});

	test('environment.lookup_action_spec resolves registered specs and returns undefined for unknown', () => {
		const { environment } = create_frontend_rpc_client<PingApi>({ specs: [ping_spec, echo_spec] });
		assert.strictEqual(environment.lookup_action_spec('ping'), ping_spec);
		assert.strictEqual(environment.lookup_action_spec('echo'), echo_spec);
		assert.strictEqual(environment.lookup_action_spec('missing'), undefined);
	});

	test('returned peer is an ActionDispatcher wired to the same environment', () => {
		const { peer, environment } = create_frontend_rpc_client<PingApi>({ specs: [ping_spec] });
		assert.instanceOf(peer, ActionDispatcher);
		assert.strictEqual(peer.environment, environment);
	});

	test('api_result dispatches a request_response method through the registered transport', async () => {
		const recording = create_recording_transport('frontend_http_rpc');
		const { api_result } = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [recording]
		});
		const result = await api_result.ping(null);
		assert.strictEqual(recording.sent.length, 1, 'transport should have been invoked exactly once');
		const sent = recording.sent[0] as { method: string; params: unknown };
		assert.strictEqual(sent.method, 'ping');
		assert.isTrue(result.ok, `expected ok result, got ${JSON.stringify(result)}`);
		assert.deepStrictEqual(result.value, { pong: true });
	});

	test('api unwraps the same dispatch to the bare value (throwing form)', async () => {
		const recording = create_recording_transport('frontend_http_rpc');
		const { api } = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [recording]
		});
		// `api` is the typed throwing Proxy — the Result wrapper is stripped.
		const value = await api.ping(null);
		assert.deepStrictEqual(value, { pong: true });
	});

	test('api and api_result share the same underlying transport (one dispatch each)', async () => {
		const recording = create_recording_transport('frontend_http_rpc');
		const { api, api_result } = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [recording]
		});
		await api.ping(null);
		await api_result.ping(null);
		// Both Proxies must hit the same transport — pick-per-call-site has no
		// construction cost.
		assert.strictEqual(recording.sent.length, 2);
	});

	test('api_result returns undefined for methods absent from specs', () => {
		const { api_result } = create_frontend_rpc_client<Record<string, unknown>>({
			specs: [ping_spec]
		});
		assert.strictEqual(api_result.missing, undefined);
	});

	test('api throws "rpc method not found" for methods absent from specs', () => {
		// `api` is the throwing Proxy — its get trap returns a thrower for
		// unknown string-keyed methods (matches `create_throwing_api`'s
		// behavior). `typeof api.missing === 'function'` so probe-then-call
		// patterns don't blow up at access time.
		const { api } = create_frontend_rpc_client<Record<string, unknown>>({ specs: [ping_spec] });
		assert.strictEqual(typeof (api as any).missing, 'function');
		assert.throws(() => (api as any).missing(), /rpc method not found: missing/);
	});

	test('transport_for_method routes per-method dispatch (pass-through to create_rpc_client)', async () => {
		// Pin the factory's `transport_for_method` pass-through. tx-style
		// mixed setups (request_response over WS, REST RPC over HTTP)
		// depend on this option reaching the underlying client.
		const ws = create_recording_transport('frontend_websocket_rpc');
		const http = create_recording_transport('frontend_http_rpc');
		const { api_result } = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [http, ws],
			transport_for_method: (method) => (method === 'ping' ? 'frontend_websocket_rpc' : undefined)
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
		const observed: Array<{ method: string; event: unknown }> = [];
		const { api_result } = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			transports: [recording],
			on_action_event: (event) => {
				observed.push({ method: event.spec.method, event });
			}
		});
		await api_result.ping(null);
		assert.strictEqual(observed.length, 1, 'callback must fire once per dispatch');
		assert.strictEqual(observed[0]!.method, 'ping');
		assert.ok(observed[0]!.event, 'the live ActionEvent must be passed through');
	});
});

/**
 * A `WebsocketRpcConnection` whose `connected` the test flips, recording each
 * `request` call; a queued request waits for `open()` the way the client's
 * durable queue waits for the reconnect. While disconnected it reports
 * `will_reconnect` (a reconnect is coming); the real client's answer is
 * pinned in `socket.svelte.test.ts`.
 */
const create_fake_ws_client = (
	connected = true
): WebsocketRpcConnection & {
	requests: Array<{ method: string; queue: boolean | undefined }>;
	open: () => void;
	set_connected: (value: boolean) => void;
} => {
	const requests: Array<{ method: string; queue: boolean | undefined }> = [];
	const waiting: Array<() => void> = [];
	let is_connected = connected;
	return {
		requests,
		get connected() {
			return is_connected;
		},
		get will_reconnect() {
			return !is_connected;
		},
		set_connected: (value) => {
			is_connected = value;
		},
		open: () => {
			is_connected = true;
			for (const release of waiting.splice(0)) release();
		},
		send: () => is_connected,
		add_message_handler: () => () => {},
		add_error_handler: () => () => {},
		request: async (method, _params, options) => {
			requests.push({ method, queue: options?.queue });
			if (!is_connected) {
				if (!options?.queue) {
					throw new ThrownJsonrpcError(JSONRPC_ERROR_CODES.service_unavailable, 'not connected');
				}
				await new Promise<void>((resolve) => waiting.push(resolve));
			}
			return method === 'ping' ? { pong: true } : { message: 'over ws' };
		}
	};
};

describe('create_frontend_rpc_client — HTTP reads', () => {
	const ok = (result: unknown) => async (input: RequestInfo | URL) => {
		const id = new URL(input as string, 'http://localhost').searchParams.get('id') ?? 1;
		return Response.json({ jsonrpc: '2.0', id, result });
	};

	test('a read spec is a GET, a mutation a POST — derived from the specs', async () => {
		const fetch_spy = vi.spyOn(globalThis, 'fetch').mockImplementation(ok({ pong: true }));
		try {
			const { api_result } = create_frontend_rpc_client<PingApi & EchoApi>({
				specs: [ping_spec, echo_spec]
			});
			await api_result.ping(null);
			assert.strictEqual(fetch_spy.mock.calls[0]![1]!.method, 'GET');
			assert.match(fetch_spy.mock.calls[0]![0] as string, /^\/api\/rpc\?method=ping&/);
			fetch_spy.mockImplementation(ok({ message: 'x' }));
			await api_result.echo({ message: 'x' });
			assert.strictEqual(fetch_spy.mock.calls[1]![1]!.method, 'POST');
		} finally {
			fetch_spy.mockRestore();
		}
	});

	test('a read whose input carries a secret or personal field at any depth is a POST', async () => {
		const sensitive_inputs: Array<[string, z.ZodType]> = [
			['secret_read', z.strictObject({ token: z.string().meta({ sensitivity: 'secret' }) })],
			['personal_read', z.strictObject({ query: z.string().meta({ sensitivity: 'personal' }) })],
			[
				'nested_read',
				z.strictObject({
					filter: z.strictObject({ email: z.string().meta({ sensitivity: 'personal' }) }).optional()
				})
			]
		];
		const specs = sensitive_inputs.map(
			([method, input]) => ({ ...ping_spec, method, input }) satisfies ActionSpecUnion
		);
		const fetch_spy = vi.spyOn(globalThis, 'fetch').mockImplementation(ok({ pong: true }));
		try {
			const { api_result } = create_frontend_rpc_client<
				Record<
					string,
					(
						input: unknown
					) => Promise<Result<{ value: { pong: true } }, { error: JsonrpcErrorObject }>>
				>
			>({ specs });
			await api_result.secret_read!({ token: 'hunter2' });
			await api_result.personal_read!({ query: 'alice@example' });
			await api_result.nested_read!({ filter: { email: 'bob@example' } });
			for (const [i, needle] of ['hunter2', 'alice', 'bob'].entries()) {
				const [url, init] = fetch_spy.mock.calls[i]!;
				assert.strictEqual(init!.method, 'POST', needle);
				assert.notInclude(url as string, needle);
			}
		} finally {
			fetch_spy.mockRestore();
		}
	});

	test('http_headers reach every call', async () => {
		const fetch_spy = vi.spyOn(globalThis, 'fetch').mockImplementation(ok({ message: 'x' }));
		try {
			const { api_result } = create_frontend_rpc_client<EchoApi>({
				specs: [echo_spec],
				http_headers: { Authorization: 'Bearer t' }
			});
			await api_result.echo({ message: 'x' });
			const headers = fetch_spy.mock.calls[0]![1]!.headers as Record<string, string>;
			assert.strictEqual(headers.authorization, 'Bearer t');
		} finally {
			fetch_spy.mockRestore();
		}
	});
});

describe('create_frontend_rpc_client — ws', () => {
	test('registers HTTP then the WS transport over the client, and returns the client', () => {
		const client = create_fake_ws_client();
		const { peer, socket } = create_frontend_rpc_client<PingApi>({
			specs: [ping_spec],
			ws: { client }
		});
		assert.strictEqual(socket, client);
		assert.instanceOf(
			peer.transports.get_transport(),
			FrontendHttpTransport,
			'HTTP is the default'
		);
		assert.instanceOf(
			peer.transports.get_transport('frontend_websocket_rpc'),
			FrontendWebsocketTransport
		);
		assert.strictEqual(
			create_frontend_rpc_client<PingApi>({ specs: [ping_spec] }).socket,
			null,
			'no client without ws'
		);
	});

	test('request_response methods route to the socket by default', async () => {
		const client = create_fake_ws_client();
		const fetch_spy = vi.spyOn(globalThis, 'fetch');
		try {
			const { api_result } = create_frontend_rpc_client<EchoApi>({
				specs: [echo_spec],
				ws: { client }
			});
			const result = await api_result.echo({ message: 'x' });
			assert.ok(result.ok);
			assert.deepStrictEqual(result.value, { message: 'over ws' });
			assert.deepStrictEqual(client.requests, [{ method: 'echo', queue: false }]);
			assert.strictEqual(fetch_spy.mock.calls.length, 0);
		} finally {
			fetch_spy.mockRestore();
		}
	});

	test('a disconnected socket falls back to HTTP without queue', async () => {
		const client = create_fake_ws_client(false);
		const fetch_spy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () =>
				Response.json({ jsonrpc: '2.0', id: 1, result: { message: 'over http' } })
			);
		try {
			const { api_result } = create_frontend_rpc_client<EchoApi>({
				specs: [echo_spec],
				ws: { client }
			});
			await api_result.echo({ message: 'x' });
			assert.strictEqual(fetch_spy.mock.calls.length, 1);
			assert.deepStrictEqual(client.requests, []);
		} finally {
			fetch_spy.mockRestore();
		}
	});

	test('ws.queue sends a disconnected request to the socket, where it waits for the open', async () => {
		const client = create_fake_ws_client(false);
		const fetch_spy = vi.spyOn(globalThis, 'fetch');
		try {
			const { api_result, peer } = create_frontend_rpc_client<EchoApi>({
				specs: [echo_spec],
				ws: { client, queue: true }
			});
			assert.strictEqual(peer.default_send_options.queue, true);
			const pending = api_result.echo({ message: 'x' });
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.deepStrictEqual(client.requests, [{ method: 'echo', queue: true }]);
			client.open();
			const result = await pending;
			assert.ok(result.ok);
			assert.deepStrictEqual(result.value, { message: 'over ws' });
			assert.strictEqual(fetch_spy.mock.calls.length, 0, 'never fell back to HTTP');
		} finally {
			fetch_spy.mockRestore();
		}
	});

	test('a notification never queues: disconnected, it goes over HTTP', async () => {
		const notify_spec = {
			method: 'thing_note',
			kind: 'remote_notification',
			initiator: 'frontend',
			auth: null,
			side_effects: true,
			input: z.strictObject({ n: z.number() }),
			output: z.void(),
			async: true,
			description: 'note'
		} satisfies ActionSpecUnion;
		const client = create_fake_ws_client(false);
		const fetch_spy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => new Response(null, { status: 204 }));
		try {
			const { peer } = create_frontend_rpc_client({
				specs: [notify_spec],
				ws: { client, queue: true }
			});
			await peer.send(
				{ jsonrpc: '2.0', method: 'thing_note', params: { n: 1 } },
				{ transport_name: 'frontend_websocket_rpc' }
			);
			assert.strictEqual(fetch_spy.mock.calls.length, 1, 'fell back to the ready HTTP transport');
		} finally {
			fetch_spy.mockRestore();
		}
	});

	test('transports is exclusive with ws', () => {
		assert.throws(
			() =>
				create_frontend_rpc_client<PingApi>({
					specs: [ping_spec],
					transports: [create_recording_transport('x')],
					ws: { client: create_fake_ws_client() }
				}),
			/`transports` replaces the built-in transports/
		);
	});
});

describe('create_frontend_rpc_client — type-only fixtures', () => {
	// Compile-time assertions: if `TApi` stops flowing through to
	// `api_result` (raw), or `ThrowingApi<TApi>` stops flowing through to
	// `api` (unwrapped), these stop compiling and `gro check` fails
	// before any runtime test runs.
	test('TApi flows through to api_result; ThrowingApi<TApi> flows through to api', () => {
		interface MyApi {
			ping: (
				input?: null
			) => Promise<Result<{ value: { pong: true } }, { error: JsonrpcErrorObject }>>;
			toggle: (input?: {
				on: boolean;
			}) => Promise<Result<{ value: void }, { error: JsonrpcErrorObject }>>;
		}

		// Never executed — types only. Wrapping in a never-called arrow keeps
		// the runtime side a no-op.
		const _check = (): void => {
			const { api, api_result, peer } = create_frontend_rpc_client<MyApi>({
				specs: [ping_spec satisfies RequestResponseActionSpec]
			});
			// api_result preserves the original Result-shaped signatures.
			const _ping_result_check: MyApi['ping'] = api_result.ping;
			const _toggle_result_check: MyApi['toggle'] = api_result.toggle;
			// api strips Promise<Result<{value: T}>> → Promise<T>.
			const _ping_throwing_check: (input?: null) => Promise<{ pong: true }> = api.ping;
			const _toggle_throwing_check: (input?: { on: boolean }) => Promise<void> = api.toggle;
			const _peer_check: ActionDispatcher = peer;
			_ping_result_check;
			_toggle_result_check;
			_ping_throwing_check;
			_toggle_throwing_check;
			_peer_check;
		};
		_check;
		assert.ok(true);
	});

	test('on_action_event narrows event.spec.method and event.data.method to keyof TApi & string', () => {
		interface MyApi {
			ping: (
				input?: null
			) => Promise<Result<{ value: { pong: true } }, { error: JsonrpcErrorObject }>>;
			toggle: (input?: {
				on: boolean;
			}) => Promise<Result<{ value: void }, { error: JsonrpcErrorObject }>>;
		}

		const _check = (): void => {
			create_frontend_rpc_client<MyApi>({
				specs: [ping_spec satisfies RequestResponseActionSpec],
				on_action_event: (event) => {
					// If the callback widens back to `ActionEvent` / `ActionEvent<string>`,
					// these literal-union assignments stop compiling.
					const _spec_method_check: 'ping' | 'toggle' = event.spec.method;
					const _data_method_check: 'ping' | 'toggle' = event.data.method;
					_spec_method_check;
					_data_method_check;
				}
			});
		};
		_check;
		assert.ok(true);
	});
});
