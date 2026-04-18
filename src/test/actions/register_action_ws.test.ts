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
import {Hono, type Context} from 'hono';
import {WSContext, type WSContextInit, type WSEvents} from 'hono/ws';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {register_action_ws, type BaseHandlerContext} from '$lib/actions/register_action_ws.js';
import type {ActionSpecUnion, RequestResponseActionSpec} from '$lib/actions/action_spec.js';
import {BackendWebsocketTransport} from '$lib/actions/transports_ws_backend.js';
import {REQUEST_CONTEXT_KEY} from '$lib/auth/request_context.js';
import {
	CREDENTIAL_TYPE_KEY,
	AUTH_API_TOKEN_ID_KEY,
	type CredentialType,
} from '$lib/hono_context.js';
import {create_test_request_context} from '$lib/testing/auth_apps.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';

const log = new Logger('test', {level: 'off'});

// --- stubs ---------------------------------------------------------------

interface FakeWs {
	ws: WSContext;
	sends: Array<string>;
	closes: Array<{code?: number; reason?: string}>;
}

/**
 * Hono types `WSEvents.onMessage` as `() => void | Promise<void>` to support
 * both sync and async consumers. Widen to `unknown` so we can `instanceof`
 * narrow; then `await` only the Promise branch. The eslint-disable covers
 * assigning a `void | Promise<void>` expression — inherent to Hono's type.
 */
const dispatch_message = async (
	on_message: NonNullable<WSEvents['onMessage']>,
	event: MessageEvent,
	ws: WSContext,
): Promise<void> => {
	// eslint-disable-next-line @typescript-eslint/no-confusing-void-expression
	const result: unknown = on_message(event, ws);
	if (result instanceof Promise) await result;
};

const create_fake_ws = (): FakeWs => {
	const sends: Array<string> = [];
	const closes: Array<{code?: number; reason?: string}> = [];
	const init: WSContextInit = {
		send: (data) => {
			sends.push(typeof data === 'string' ? data : '<binary>');
		},
		close: (code, reason) => {
			closes.push({code, reason});
		},
		readyState: 1,
	};
	return {ws: new WSContext(init), sends, closes};
};

/** Fake Hono context — only `.get()` is exercised by the dispatcher. */
const create_fake_context = (opts: {
	credential_type: CredentialType;
	role?: string;
	auth_session_id?: string | null;
	api_token_id?: string | null;
}): Context => {
	const request_context = create_test_request_context(opts.role);
	const vars: Record<string, unknown> = {
		[REQUEST_CONTEXT_KEY]: request_context,
		[CREDENTIAL_TYPE_KEY]: opts.credential_type,
		auth_session_id: opts.auth_session_id ?? (opts.credential_type === 'session' ? 's1' : null),
		[AUTH_API_TOKEN_ID_KEY]: opts.api_token_id ?? null,
	};
	return {
		get: (key: string) => vars[key],
	} as unknown as Context;
};

/** Stub `upgradeWebSocket` — captures the createEvents callback. */
const create_stub_upgrade = (): {
	upgradeWebSocket: any;
	get_create_events: () => (c: Context) => WSEvents | Promise<WSEvents>;
} => {
	let captured: ((c: Context) => WSEvents | Promise<WSEvents>) | null = null;
	const upgradeWebSocket: any = (createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => {
		captured = createEvents;
		return async (_c: Context, next: () => Promise<void>) => next();
	};
	return {
		upgradeWebSocket,
		get_create_events: () => {
			if (!captured) throw new Error('upgradeWebSocket was not called');
			return captured;
		},
	};
};

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
	on_open: () => void;
	on_message: (data: unknown) => Promise<void>;
	on_close: () => void;
}

const build_harness = async (opts: {
	handlers: Record<string, (input: unknown, ctx: BaseHandlerContext) => unknown>;
	credential_type?: CredentialType;
	role?: string;
	artificial_delay?: number;
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
		log,
	});

	const c = create_fake_context({
		credential_type: opts.credential_type ?? 'session',
		role: opts.role,
	});
	const events = await stub.get_create_events()(c);
	const fake = create_fake_ws();

	return {
		transport,
		fake,
		on_open: () => {
			events.onOpen?.(new Event('open'), fake.ws);
		},
		on_message: async (data: unknown) => {
			const event = new MessageEvent('message', {
				data: typeof data === 'string' ? data : JSON.stringify(data),
			});
			if (events.onMessage) await dispatch_message(events.onMessage, event, fake.ws);
		},
		on_close: () => {
			events.onClose?.(new CloseEvent('close'), fake.ws);
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
		h.on_open();
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
		h.on_open();
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
		h.on_open();
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
		h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'echo', params: {value: 'x'}});
		assert.ok(captured.signal);
		assert.strictEqual(captured.signal.aborted, false);

		h.on_close();
		assert.strictEqual(captured.signal.aborted, true);
	});

	test('rejects batch JSON-RPC with invalid_request', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		h.on_open();
		await h.on_message([{jsonrpc: '2.0', id: 1, method: 'echo', params: {value: 'x'}}]);

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.id, null);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_request);
		// `invalid_request(data)` puts the batch-reason string in `data`, not `message`.
		assert.match(String(res.error.data), /batch/i);
	});

	test('parse error on malformed JSON', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		h.on_open();
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
			create_fake_context({credential_type: 'session'}),
		);
		const fake = create_fake_ws();
		events.onOpen?.(new Event('open'), fake.ws);
		if (events.onMessage) await dispatch_message(events.onMessage, event, fake.ws);

		const res = parse_json(fake.sends[0]!);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.parse_error);
	});

	test('silently drops JSON-RPC notifications (method + no id)', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		h.on_open();
		await h.on_message({jsonrpc: '2.0', method: 'echo', params: {value: 'x'}});
		assert.strictEqual(h.fake.sends.length, 0);
	});

	test('invalid envelope (not request, not notification) returns invalid_request', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1}); // missing method

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_request);
	});

	test('method_not_found for unknown method', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'missing'});

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.id, 1);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.method_not_found);
	});

	test('method_not_found when handler is missing for a registered spec', async () => {
		// spec exists (echo) but no handler wired
		const h = await build_harness({handlers: {}});
		h.on_open();
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
		h.on_open();
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
		h.on_open();
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
		h.on_open();
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
		h.on_open();
		await h.on_message({jsonrpc: '2.0', id: 1, method: 'role_only', params: null});

		const res = parse_json(h.fake.sends[0]!);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
		assert.match(res.error.message, /requires role: admin/i);
	});

	test('invalid params return invalid_params with issues', async () => {
		const h = await build_harness({handlers: {echo: () => ({value: 'x'})}});
		h.on_open();
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
		h.on_open();
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
			create_fake_context({credential_type: 'session'}),
		);
		const fake = create_fake_ws();
		events.onOpen?.(new Event('open'), fake.ws);
		if (events.onMessage) {
			await dispatch_message(
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
		h.on_open();
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
		h.on_open();
		assert.strictEqual(h.transport.is_ready(), true);
		h.on_close();
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
