/**
 * Tests for register_action_ws — WebSocket JSON-RPC dispatch.
 *
 * Drives the dispatcher directly with a stub `upgradeWebSocket` that captures
 * the `createEvents` callback, then feeds onOpen/onMessage/onClose with a fake
 * Hono context and a fake `WSContext`. Exercises: envelope parsing, batch
 * rejection, per-action auth, input validation, handler dispatch, DEV output
 * validation, socket-scoped notify, per-socket signal, transport bookkeeping.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Hono} from 'hono';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {
	register_action_ws,
	type BaseHandlerContext,
	type SocketCloseContext,
	type SocketOpenContext,
} from '$lib/actions/register_action_ws.js';
import type {ActionSpecUnion, RequestResponseActionSpec} from '$lib/actions/action_spec.js';
import {BackendWebsocketTransport} from '$lib/actions/transports_ws_backend.js';
import {type CredentialType} from '$lib/hono_context.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {
	create_fake_hono_context,
	create_fake_ws,
	create_stub_upgrade,
	dispatch_ws_message,
	type FakeWs,
} from '$lib/testing/ws_round_trip.js';

const log = new Logger('test', {level: 'off'});

// --- spec fixtures -------------------------------------------------------

const echo_spec: RequestResponseActionSpec = {
	method: 'echo',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: z.strictObject({value: z.string()}),
	output: z.strictObject({value: z.string()}),
	async: true,
	description: 'echo',
};

const no_input_spec: RequestResponseActionSpec = {
	method: 'ping',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: false,
	input: z.null(),
	output: z.null(),
	async: true,
	description: 'ping',
};

const keeper_spec: RequestResponseActionSpec = {
	method: 'keeper_only',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'keeper',
	side_effects: false,
	input: z.null(),
	output: z.null(),
	async: true,
	description: 'keeper only',
};

const role_spec: RequestResponseActionSpec = {
	method: 'role_only',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {role: 'admin'},
	side_effects: false,
	input: z.null(),
	output: z.null(),
	async: true,
	description: 'role only',
};

const specs: Array<ActionSpecUnion> = [echo_spec, no_input_spec, keeper_spec, role_spec];

// --- harness -------------------------------------------------------------

interface Harness {
	transport: BackendWebsocketTransport;
	fake: FakeWs;
	/** Returns a promise for async hooks; existing callers can still ignore it. */
	on_open: () => Promise<void>;
	on_message: (data: unknown) => Promise<void>;
	/** Returns a promise for async hooks; existing callers can still ignore it. */
	on_close: () => Promise<void>;
}

const build_harness = async (opts: {
	handlers: Record<string, (input: unknown, ctx: BaseHandlerContext) => unknown>;
	credential_type?: CredentialType;
	role?: string;
	artificial_delay?: number;
	on_socket_open?: (ctx: SocketOpenContext) => void | Promise<void>;
	on_socket_close?: (ctx: SocketCloseContext) => void | Promise<void>;
}): Promise<Harness> => {
	const stub = create_stub_upgrade();
	const {transport} = register_action_ws({
		path: '/ws',
		app: new Hono(),
		upgradeWebSocket: stub.upgradeWebSocket,
		specs,
		handlers: opts.handlers,
		extend_context: (base) => base,
		artificial_delay: opts.artificial_delay,
		on_socket_open: opts.on_socket_open,
		on_socket_close: opts.on_socket_close,
		log,
	});

	const c = create_fake_hono_context({
		credential_type: opts.credential_type ?? 'session',
		role: opts.role,
	});
	const events = await stub.get_create_events()(c);
	const fake = create_fake_ws();

	return {
		transport,
		fake,
		on_open: async () => {
			await (events.onOpen?.(new Event('open'), fake.ws) as Promise<void> | void);
		},
		on_message: async (data: unknown) => {
			const event = new MessageEvent('message', {
				data: typeof data === 'string' ? data : JSON.stringify(data),
			});
			if (events.onMessage) await dispatch_ws_message(events.onMessage, event, fake.ws);
		},
		on_close: async () => {
			await (events.onClose?.(new CloseEvent('close'), fake.ws) as Promise<void> | void);
		},
	};
};

const parse_json = (s: string): any => JSON.parse(s);

// --- tests ---------------------------------------------------------------

describe('register_action_ws', () => {
	test('dispatches a valid request and returns the handler output', async () => {
		const h = await build_harness({
			handlers: {
				echo: (input) => ({value: `hi ${(input as {value: string}).value}`}),
			},
		});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'echo', params: {value: 'world'}});

		assert.strictEqual(h.fake.sends.length, 1);
		const res = parse_json(h.fake.sends[0]!);
		assert.deepStrictEqual(res, {jsonrpc: '2.0', id: 1, result: {value: 'hi world'}});
	});

	test('handler receives request_id, notify, and signal on ctx', async () => {
		const captured: {ctx: BaseHandlerContext | null} = {ctx: null};
		const h = await build_harness({
			handlers: {
				echo: (input, ctx) => {
					captured.ctx = ctx;
					return {value: (input as {value: string}).value};
				},
			},
		});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 'req-abc', method: 'echo', params: {value: 'x'}});

		assert.ok(captured.ctx);
		assert.strictEqual(captured.ctx.request_id, 'req-abc');
		assert.strictEqual(typeof captured.ctx.notify, 'function');
		assert.ok(captured.ctx.signal instanceof AbortSignal);
	});

	test('ctx.notify routes a JSON-RPC notification to the originating socket', async () => {
		const h = await build_harness({
			handlers: {
				echo: (_input, ctx) => {
					ctx.notify('progress', {n: 1});
					ctx.notify('progress', {n: 2});
					return {value: 'ok'};
				},
			},
		});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'echo', params: {value: 'x'}});

		assert.strictEqual(h.fake.sends.length, 3);
		const n1 = parse_json(h.fake.sends[0]!);
		const n2 = parse_json(h.fake.sends[1]!);
		const res = parse_json(h.fake.sends[2]!);
		assert.deepStrictEqual(n1, {jsonrpc: '2.0', method: 'progress', params: {n: 1}});
		assert.deepStrictEqual(n2, {jsonrpc: '2.0', method: 'progress', params: {n: 2}});
		assert.strictEqual(res.id, 1);
	});

	test('ctx.signal fires when the socket is closed', async () => {
		const captured: {signal: AbortSignal | null} = {signal: null};
		const h = await build_harness({
			handlers: {
				echo: (input, ctx) => {
					captured.signal = ctx.signal;
					return {value: (input as {value: string}).value};
				},
			},
		});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'echo', params: {value: 'x'}});
		assert.ok(captured.signal);
		assert.strictEqual(captured.signal.aborted, false);

		await h.on_close();
		assert.strictEqual(captured.signal.aborted, true);
	});

	test('rejects batch JSON-RPC with invalid_request', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		await h.on_open();
		await h.on_message([{jsonrpc: '2.0', id: 1, method: 'echo', params: {value: 'x'}}]);

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.id, null);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_request);
		// `invalid_request(data)` puts the batch-reason string in `data`, not `message`.
		assert.match(String(res.error.data), /batch/i);
	});

	test('parse error on malformed JSON', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		await h.on_open();
		const event = new MessageEvent('message', {data: '{not json'});
		// drive onMessage directly with bad data
		const stub = create_stub_upgrade();
		register_action_ws({
			path: '/ws',
			app: new Hono(),
			upgradeWebSocket: stub.upgradeWebSocket,
			specs,
			handlers: {echo: () => ({value: 'x'})},
			extend_context: (base) => base,
			log,
		});
		const events = await stub.get_create_events()(
			create_fake_hono_context({credential_type: 'session'}),
		);
		const fake = create_fake_ws();
		events.onOpen?.(new Event('open'), fake.ws);
		if (events.onMessage) await dispatch_ws_message(events.onMessage, event, fake.ws);

		const res = parse_json(fake.sends[0]!);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.parse_error);
	});

	test('silently drops JSON-RPC notifications (method + no id)', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', method: 'echo', params: {value: 'x'}});
		assert.strictEqual(h.fake.sends.length, 0);
	});

	test('invalid envelope (not request, not notification) returns invalid_request', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1}); // missing method

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_request);
	});

	test('method_not_found for unknown method', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'missing'});

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.id, 1);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.method_not_found);
	});

	test('method_not_found when handler is missing for a registered spec', async () => {
		// spec exists (echo) but no handler wired
		const h = await build_harness({handlers: {}});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'echo', params: {value: 'x'}});

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.method_not_found);
	});

	test('keeper action rejected without daemon_token + keeper role', async () => {
		const h = await build_harness({
			handlers: {keeper_only: () => null},
			credential_type: 'session',
			role: 'keeper',
		});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'keeper_only', params: null});

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
	});

	test('keeper action allowed with daemon_token + keeper role', async () => {
		const h = await build_harness({
			handlers: {keeper_only: () => null},
			credential_type: 'daemon_token',
			role: 'keeper',
		});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'keeper_only', params: null});

		const res = parse_json(h.fake.sends[0]!);
		assert.ok(!res.error, `unexpected error: ${JSON.stringify(res.error)}`);
		assert.strictEqual(res.result, null);
	});

	test('role-based auth allowed when request_context has the required role', async () => {
		const h = await build_harness({
			handlers: {role_only: () => null},
			role: 'admin',
		});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'role_only', params: null});

		const res = parse_json(h.fake.sends[0]!);
		assert.ok(!res.error, `unexpected error: ${JSON.stringify(res.error)}`);
		assert.strictEqual(res.result, null);
	});

	test('role-based auth rejected when request_context lacks the required role', async () => {
		const h = await build_harness({
			handlers: {role_only: () => null},
			// no role — default RequestContext has no permits
		});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'role_only', params: null});

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
		assert.match(res.error.message, /requires role: admin/i);
	});

	test('invalid params return invalid_params with issues', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'echo', params: {value: 42}});

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
		assert.ok(Array.isArray(res.error.data?.issues));
	});

	test('handler throws → JSON-RPC error response with same id', async () => {
		const h = await build_harness({
			handlers: {
				echo: () => {
					throw new Error('boom');
				},
			},
		});
		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 77, method: 'echo', params: {value: 'x'}});

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.id, 77);
		assert.ok(res.error);
	});

	test('extend_context receives the base + Hono context and merges fields into handler ctx', async () => {
		const stub = create_stub_upgrade();
		const domain = {tag: 'zzz'};
		let captured: {tag: string; request_id: unknown} | null = null;
		register_action_ws<BaseHandlerContext & {domain: typeof domain}>({
			path: '/ws',
			app: new Hono(),
			upgradeWebSocket: stub.upgradeWebSocket,
			specs,
			handlers: {
				echo: (input, ctx) => {
					captured = {tag: ctx.domain.tag, request_id: ctx.request_id};
					return {value: (input as {value: string}).value};
				},
			},
			extend_context: (base) => ({...base, domain}),
			log,
		});

		const events = await stub.get_create_events()(
			create_fake_hono_context({credential_type: 'session'}),
		);
		const fake = create_fake_ws();
		events.onOpen?.(new Event('open'), fake.ws);
		if (events.onMessage) {
			await dispatch_ws_message(
				events.onMessage,
				new MessageEvent('message', {
					data: JSON.stringify({jsonrpc: '2.0', id: 'r1', method: 'echo', params: {value: 'x'}}),
				}),
				fake.ws,
			);
		}

		assert.deepStrictEqual(captured, {tag: 'zzz', request_id: 'r1'});
	});

	test('artificial_delay waits before dispatching', async () => {
		let dispatched_at = 0;
		const h = await build_harness({
			handlers: {
				echo: (input) => {
					dispatched_at = Date.now();
					return {value: (input as {value: string}).value};
				},
			},
			artificial_delay: 30,
		});
		await h.on_open();
		const sent_at = Date.now();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'echo', params: {value: 'x'}});
		assert.ok(
			dispatched_at - sent_at >= 25,
			`expected ≥25ms delay, got ${dispatched_at - sent_at}ms`,
		);
	});

	test('transport tracks connections on open and removes on close', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		assert.strictEqual(h.transport.is_ready(), false);
		await h.on_open();
		assert.strictEqual(h.transport.is_ready(), true);
		await h.on_close();
		assert.strictEqual(h.transport.is_ready(), false);
	});

	test('returns the supplied transport when provided', async () => {
		const supplied = new BackendWebsocketTransport();
		const stub = create_stub_upgrade();
		const result = register_action_ws({
			path: '/ws',
			app: new Hono(),
			upgradeWebSocket: stub.upgradeWebSocket,
			specs,
			handlers: {echo: () => ({value: 'x'})},
			extend_context: (base) => base,
			transport: supplied,
			log,
		});
		assert.strictEqual(result.transport, supplied);
	});
});

describe('register_action_ws socket lifecycle hooks', () => {
	test('on_socket_open fires once with connection_id, identity, notify, signal', async () => {
		let captured: SocketOpenContext | null = null;
		let calls = 0;
		const h = await build_harness({
			handlers: {echo: () => ({value: 'x'})},
			on_socket_open: (ctx) => {
				calls++;
				captured = ctx;
			},
		});

		await h.on_open();
		assert.strictEqual(calls, 1);
		assert.ok(captured);
		const ctx = captured as SocketOpenContext;
		assert.strictEqual(typeof ctx.connection_id, 'string');
		assert.ok(ctx.connection_id.length > 0);
		assert.strictEqual(ctx.identity.account_id, 'acc_1'); // from create_fake_hono_context
		assert.strictEqual(typeof ctx.identity.token_hash, 'string'); // session credential
		assert.strictEqual(ctx.identity.api_token_id, null);
		assert.strictEqual(typeof ctx.notify, 'function');
		assert.ok(ctx.signal instanceof AbortSignal);
	});

	test('on_socket_open runs after add_connection — transport is ready inside the hook', async () => {
		let is_ready_inside: boolean | null = null;
		let captured_transport: BackendWebsocketTransport | null = null;
		const h = await build_harness({
			handlers: {echo: () => ({value: 'x'})},
			on_socket_open: () => {
				is_ready_inside = captured_transport!.is_ready();
			},
		});
		captured_transport = h.transport;

		await h.on_open();
		assert.strictEqual(is_ready_inside, true);
	});

	test('on_socket_open notify routes a notification back to the originating socket', async () => {
		const h = await build_harness({
			handlers: {echo: () => ({value: 'x'})},
			on_socket_open: (ctx) => {
				ctx.notify('hello', {connection_id: ctx.connection_id});
			},
		});

		await h.on_open();
		assert.strictEqual(h.fake.sends.length, 1);
		const msg = parse_json(h.fake.sends[0]!);
		assert.strictEqual(msg.method, 'hello');
		assert.strictEqual(typeof msg.params.connection_id, 'string');
		// no `id` — it's a notification
		assert.strictEqual('id' in msg, false);
	});

	test('on_socket_open signal is the same abort signal per-message handlers see', async () => {
		// Object wrapper avoids TS control-flow inferring the closures never run.
		const captured: {open: AbortSignal | null; handler: AbortSignal | null} = {
			open: null,
			handler: null,
		};
		const h = await build_harness({
			handlers: {
				echo: (_input, ctx) => {
					captured.handler = ctx.signal;
					return {value: 'x'};
				},
			},
			on_socket_open: (ctx) => {
				captured.open = ctx.signal;
			},
		});

		await h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'echo', params: {value: 'x'}});
		assert.ok(captured.open);
		assert.ok(captured.handler);
		assert.strictEqual(captured.open, captured.handler);

		assert.strictEqual(captured.open.aborted, false);
		await h.on_close();
		assert.strictEqual(captured.open.aborted, true);
	});

	test('on_socket_open is awaited before onMessage dispatches', async () => {
		const events: Array<string> = [];
		const h = await build_harness({
			handlers: {
				echo: () => {
					events.push('handler');
					return {value: 'x'};
				},
			},
			on_socket_open: async () => {
				events.push('open:start');
				await new Promise((resolve) => setTimeout(resolve, 10));
				events.push('open:end');
			},
		});

		// Simulate real adapter: open fires, then messages arrive. Caller drives
		// them in sequence (awaiting open before sending is the harness contract).
		const open_promise = h.on_open();
		await open_promise;
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'echo', params: {value: 'x'}});

		assert.deepStrictEqual(events, ['open:start', 'open:end', 'handler']);
	});

	test('on_socket_open that throws closes the socket with an error frame + code 1011', async () => {
		const h = await build_harness({
			handlers: {echo: () => ({value: 'x'})},
			on_socket_open: () => {
				throw new Error('bootstrap boom');
			},
		});

		await h.on_open();
		// error frame written, then close called
		assert.strictEqual(h.fake.sends.length, 1);
		const err = parse_json(h.fake.sends[0]!);
		assert.strictEqual(err.error.code, JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(h.fake.closes.length, 1);
		assert.strictEqual(h.fake.closes[0]!.code, 1011);
	});

	test('on_socket_close fires with connection_id + identity before transport.remove_connection', async () => {
		let close_seen_connection_id: string | null = null;
		let close_seen_account_id: string | null = null;
		let transport_ready_inside_close: boolean | null = null;
		const h = await build_harness({
			handlers: {echo: () => ({value: 'x'})},
			on_socket_close: (ctx) => {
				close_seen_connection_id = ctx.connection_id;
				close_seen_account_id = ctx.identity.account_id;
				transport_ready_inside_close = h.transport.is_ready();
			},
		});

		await h.on_open();
		assert.strictEqual(h.transport.is_ready(), true);
		await h.on_close();

		// the hook saw a valid connection_id and saw the transport while it still
		// held the connection (remove_connection runs after the hook returns).
		assert.strictEqual(typeof close_seen_connection_id, 'string');
		assert.strictEqual(close_seen_account_id, 'acc_1');
		assert.strictEqual(transport_ready_inside_close, true);
		assert.strictEqual(h.transport.is_ready(), false);
	});

	test('on_socket_close identity stays readable after audit-revocation wipes transport state', async () => {
		// Models the audit-guard path: `transport.close_sockets_for_account`
		// clears the transport's internal identity map and calls `ws.close()`.
		// Hono then fires onClose. The hook must still see the identity because
		// it was captured at open time, independently of the transport.
		let close_identity_account: string | null = null;
		const h = await build_harness({
			handlers: {echo: () => ({value: 'x'})},
			on_socket_close: (ctx) => {
				close_identity_account = ctx.identity.account_id;
			},
		});

		await h.on_open();
		// audit guard path — clears identity map and calls ws.close()
		const closed = h.transport.close_sockets_for_account('acc_1' as never);
		assert.strictEqual(closed, 1);
		assert.strictEqual(h.transport.is_ready(), false); // identity map already cleared
		// Hono would fire onClose in response to ws.close(); simulate that.
		await h.on_close();

		// Identity still valid inside the hook despite transport having been wiped.
		assert.strictEqual(close_identity_account, 'acc_1');
	});

	test('on_socket_close error is logged and swallowed (transport still cleans up)', async () => {
		const h = await build_harness({
			handlers: {echo: () => ({value: 'x'})},
			on_socket_close: () => {
				throw new Error('cleanup boom');
			},
		});

		await h.on_open();
		assert.strictEqual(h.transport.is_ready(), true);
		// Must not throw despite the hook throwing.
		await h.on_close();
		assert.strictEqual(h.transport.is_ready(), false);
	});

	test('on_socket_close is skipped when the socket never opened', async () => {
		let close_calls = 0;
		const h = await build_harness({
			handlers: {echo: () => ({value: 'x'})},
			on_socket_close: () => {
				close_calls++;
			},
		});

		// Drive onClose without ever opening — no captured_connection_id,
		// so the hook is not invoked (there's nothing to clean up for this socket).
		await h.on_close();
		assert.strictEqual(close_calls, 0);
	});
});
