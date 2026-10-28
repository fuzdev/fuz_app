/**
 * Tests for `register_action_ws`'s outbound bound — every frame the dispatcher
 * sends goes through the transport's outbound queue, so a handler that sends
 * past its connection's budget closes it with `WS_CLOSE_OUTBOUND_OVERFLOW` and
 * gets no response written — plus the `outbound_queue_bytes` endpoint option
 * and the `_testing_flood_notifications` action that drives an overflow from
 * outside.
 *
 * @module
 */

import { afterEach, describe, assert, test, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';

import { register_action_ws } from '#lib/actions/register_action_ws.ts';
import type { ActionContext } from '#lib/actions/action_types.ts';
import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import { heartbeat_action } from '#lib/actions/heartbeat.ts';
import {
	BackendWebsocketTransport,
	DEFAULT_WS_OUTBOUND_QUEUE_BYTES
} from '#lib/actions/transports_ws_backend.ts';
import {
	WS_CLOSE_OUTBOUND_OVERFLOW,
	WS_CLOSE_OUTBOUND_OVERFLOW_REASON,
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SESSION_REVOKED_REASON
} from '#lib/actions/transports.ts';
import {
	WS_CLOSE_WRITE_TIMEOUT,
	WS_WRITE_HIGH_WATER_BYTES
} from '#lib/actions/ws_outbound_writer.ts';
import { Db } from '#lib/db/db.ts';
import { ACCOUNT_ID_KEY, TEST_CONTEXT_PRESET_KEY } from '#lib/hono_context.ts';
import { JSONRPC_ERROR_CODES, ThrownJsonrpcError } from '#lib/http/jsonrpc_errors.ts';
import { OUTBOUND_FRAME_OVERHEAD_BYTES } from '#lib/realtime/outbound_budget.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import {
	create_testing_flood_notifications_action,
	ERROR_TESTING_FLOOD_NO_CONNECTION,
	TESTING_FLOOD_MAX_COUNT,
	TESTING_FLOOD_MAX_SIZE,
	TESTING_FLOOD_MAX_TOTAL_BYTES,
	TESTING_FLOOD_NOTIFICATION_METHOD,
	testing_flood_notifications_action_spec
} from '#lib/testing/cross_backend/testing_reset_actions.ts';
import {
	is_notification,
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type JsonrpcNotificationFrame
} from '#lib/testing/transports/ws_client.ts';
import {
	create_fake_hono_context,
	create_fake_ws,
	create_stub_upgrade,
	create_ws_test_harness,
	dispatch_ws_message
} from '#lib/testing/ws_round_trip.ts';

const log = new Logger('test', { level: 'off' });

const FLOOD = testing_flood_notifications_action_spec.method;

const echo_spec = {
	method: 'echo',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: z.strictObject({ value: z.string() }),
	output: z.strictObject({ value: z.string() }),
	async: true,
	description: 'echo'
} satisfies RequestResponseActionSpec;

/** Let the write pump and a dispatch's `finally` run. */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

const flood_indices = (messages: ReadonlyArray<unknown>): Array<number> =>
	messages
		.filter(is_notification(TESTING_FLOOD_NOTIFICATION_METHOD))
		.map((msg) => (msg as JsonrpcNotificationFrame<{ index: number }>).params.index);

describe('register_action_ws outbound overflow', () => {
	test('a burst within the budget arrives in order, ahead of its response', async () => {
		const harness = create_ws_test_harness({
			actions: [create_testing_flood_notifications_action()],
			transport: new BackendWebsocketTransport({ log: null })
		});
		const client = await harness.connect({ credential_type: 'daemon_token' });
		const result = await client.request('flood', FLOOD, { count: 3, size: 8 });
		assert.deepStrictEqual(result, { queued: 3 });
		const frames = client.messages as ReadonlyArray<JsonrpcNotificationFrame<{ payload: string }>>;
		assert.deepStrictEqual(flood_indices(client.messages), [0, 1, 2]);
		assert.strictEqual(frames[0]!.params.payload, 'x'.repeat(8));
		// the response is the last frame, after the whole burst
		assert.ok(is_response_for('flood')(client.messages[3]));
		assert.strictEqual(client.close_code, null);
	});

	test('a burst past the budget closes with 4005, and its response is never sent', async () => {
		const size = 1000;
		const harness = create_ws_test_harness({
			actions: [create_testing_flood_notifications_action(), heartbeat_action],
			// room for a few waiting frames of the burst, not all of it
			transport: new BackendWebsocketTransport({ outbound_queue_bytes: 5 * size, log: null })
		});
		const account_id = create_uuid();
		const client = await harness.connect({ account_id, credential_type: 'daemon_token' });
		const other = await harness.connect({ account_id });

		await client.send({
			jsonrpc: '2.0',
			id: 'flood',
			method: FLOOD,
			params: { count: 32, size }
		});
		await settle();

		assert.strictEqual(client.close_code, WS_CLOSE_OUTBOUND_OVERFLOW);
		assert.strictEqual(client.close_reason, WS_CLOSE_OUTBOUND_OVERFLOW_REASON);
		// the response of the request whose handler overflowed is not sent
		assert.strictEqual(client.messages.some(is_response_for('flood')), false);
		// what arrived is a strict prefix of the burst
		const indices = flood_indices(client.messages);
		assert.ok(indices.length < 32);
		assert.deepStrictEqual(
			indices,
			indices.map((_, i) => i)
		);
		assert.strictEqual(client.messages.length, indices.length, 'nothing but flood frames');

		// the account's other connection is untouched and keeps dispatching
		assert.strictEqual(other.close_code, null);
		assert.deepStrictEqual(await other.request('hb', 'heartbeat', {}), {});
		assert.strictEqual(harness.transport.get_connection_count(), 1);
	});

	test('no frame follows the close frame on the socket, the response included', async () => {
		// Drives the dispatcher against a bare fake socket, which records every
		// send — the harness client stops listening once its socket closes.
		const stub = create_stub_upgrade();
		const size = 1000;
		register_action_ws({
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null,
			path: '/ws',
			connection_closer: null,
			app: new Hono(),
			upgradeWebSocket: stub.upgradeWebSocket,
			allowed_origins: [],
			actions: [create_testing_flood_notifications_action()],
			db: create_stub_db(),
			outbound_queue_bytes: 5 * size,
			heartbeat: false,
			log
		});
		const events = await stub.get_create_events()(
			create_fake_hono_context({ credential_type: 'daemon_token' })
		);
		const fake = create_fake_ws();
		await (events.onOpen?.(new Event('open'), fake.ws) as Promise<void> | void);
		await dispatch_ws_message(
			events.onMessage!,
			new MessageEvent('message', {
				data: JSON.stringify({
					jsonrpc: '2.0',
					id: 'flood',
					method: FLOOD,
					params: { count: 32, size }
				})
			}),
			fake.ws
		);
		await settle();

		assert.deepStrictEqual(fake.closes, [
			{ code: WS_CLOSE_OUTBOUND_OVERFLOW, reason: WS_CLOSE_OUTBOUND_OVERFLOW_REASON }
		]);
		// the one frame written before the burst backed up; nothing after the
		// close — not the rest of the burst, not the request's response
		const frames = fake.sends.map((text) => JSON.parse(text) as unknown);
		assert.deepStrictEqual(flood_indices(frames), [0]);
		assert.strictEqual(frames.length, 1);
		assert.strictEqual(frames.some(is_response_for('flood')), false);
	});

	test('an error response goes through the budget like any other frame', async () => {
		const harness = create_ws_test_harness({
			actions: [{ spec: echo_spec, handler: (input: unknown) => input }],
			// one waiting frame of overhead alone
			transport: new BackendWebsocketTransport({
				outbound_queue_bytes: OUTBOUND_FRAME_OVERHEAD_BYTES,
				log: null
			})
		});
		const client = await harness.connect();
		// three refusals answered in one synchronous run: the first error frame
		// goes through, the second waits, the third does not fit
		const sent = [1, 2, 3].map((n) => client.send({ jsonrpc: '2.0', id: n, method: 'nope' }));
		await Promise.all(sent);
		await settle();
		assert.strictEqual(client.close_code, WS_CLOSE_OUTBOUND_OVERFLOW);
		assert.strictEqual(client.messages.some(is_response_for(1)), true);
		assert.strictEqual(client.messages.some(is_response_for(3)), false);
	});

	test('a reply sent just before a self-revoking close still reaches the client first', async () => {
		const transport = new BackendWebsocketTransport({ log: null });
		const revoke_spec = { ...echo_spec, method: 'revoke_self' } satisfies RequestResponseActionSpec;
		const harness = create_ws_test_harness({
			actions: [
				{
					spec: revoke_spec,
					handler: (input: unknown, ctx: ActionContext) => {
						// a notification, then the reply, then the close — one run
						ctx.notify('before_reply', {});
						ctx.post_commit_effects.push(() => {
							transport.close_connections({ kind: 'account', account_id: ctx.auth!.account.id });
						});
						return input;
					}
				}
			],
			transport
		});
		const client = await harness.connect();
		await client.send({
			jsonrpc: '2.0',
			id: 'r',
			method: 'revoke_self',
			params: { value: 'v' }
		});
		await settle();
		assert.strictEqual(client.close_code, WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(client.messages.some(is_notification('before_reply')), true);
		assert.strictEqual(client.messages.some(is_response_for('r')), true);
	});
});

describe('register_action_ws closes', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test('a reply queued behind a backed-up socket is not delivered ahead of a revoking close', async () => {
		const transport = new BackendWebsocketTransport({ log: null });
		const big = 'x'.repeat(WS_WRITE_HIGH_WATER_BYTES);
		const revoke_spec = { ...echo_spec, method: 'revoke_self' } satisfies RequestResponseActionSpec;
		const stub = create_stub_upgrade();
		register_action_ws({
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null,
			path: '/ws',
			connection_closer: null,
			app: new Hono(),
			upgradeWebSocket: stub.upgradeWebSocket,
			allowed_origins: [],
			actions: [
				{
					spec: revoke_spec,
					handler: (input: unknown, ctx: ActionContext) => {
						// more than the high-water mark, then the reply, then the close
						ctx.notify('bulk', { big });
						ctx.notify('bulk', { big });
						ctx.post_commit_effects.push(() => {
							transport.close_connections({ kind: 'account', account_id: ctx.auth!.account.id });
						});
						return input;
					}
				}
			],
			db: create_stub_db(),
			transport,
			heartbeat: false,
			log
		});
		const events = await stub.get_create_events()(
			create_fake_hono_context({ credential_type: 'session' })
		);
		// a client that is not reading
		const fake = create_fake_ws({ stalled: true });
		await (events.onOpen?.(new Event('open'), fake.ws) as Promise<void> | void);
		await dispatch_ws_message(
			events.onMessage!,
			new MessageEvent('message', {
				data: JSON.stringify({
					jsonrpc: '2.0',
					id: 'r',
					method: 'revoke_self',
					params: { value: 'v' }
				})
			}),
			fake.ws
		);
		await settle();

		assert.deepStrictEqual(fake.closes, [
			{ code: WS_CLOSE_SESSION_REVOKED, reason: WS_CLOSE_SESSION_REVOKED_REASON }
		]);
		// the first notification went straight through and backed the socket up;
		// the second and the reply waited behind it and are discarded at the close
		const frames = fake.sends.map((text) => JSON.parse(text) as unknown);
		assert.strictEqual(frames.filter(is_notification('bulk')).length, 1);
		assert.strictEqual(frames.some(is_response_for('r')), false);
		await settle();
		assert.strictEqual(fake.sends.length, 1, 'nothing follows the close frame');
	});

	test('a pending socket a revocation closed keeps its close deadline through the refusal', async () => {
		vi.useFakeTimers();
		const transport = new BackendWebsocketTransport({ log: null });
		// the admission re-read, held until the test releases it
		const re_read = Promise.withResolvers<{ rows: Array<never> }>();
		const db: Db = new Db({
			client: { query: () => re_read.promise },
			transaction: (fn) => fn(db)
		});
		const stub = create_stub_upgrade();
		register_action_ws({
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null,
			path: '/ws',
			connection_closer: null,
			app: new Hono(),
			upgradeWebSocket: stub.upgradeWebSocket,
			allowed_origins: [],
			actions: [],
			db,
			transport,
			heartbeat: false,
			log
		});
		// a real upgrade context: no test preset, so admission re-reads the credential
		const preset = create_fake_hono_context({ credential_type: 'daemon_token' });
		const read = preset.get as (key: string) => unknown;
		const account_id = read(ACCOUNT_ID_KEY) as Uuid;
		const c = {
			get: (key: string) => (key === TEST_CONTEXT_PRESET_KEY ? undefined : read(key))
		} as unknown as Context;
		const events = await stub.get_create_events()(c);
		// a client that is not reading: its close frame stays unwritten
		const fake = create_fake_ws({ stalled: true });
		const opened = Promise.resolve(events.onOpen?.(new Event('open'), fake.ws));
		assert.strictEqual(transport.get_pending_connection_count(), 1);

		// the revocation lands while the re-read is in flight
		assert.strictEqual(transport.close_connections({ kind: 'account', account_id }), 1);
		assert.strictEqual(fake.closes[0]?.code, WS_CLOSE_SESSION_REVOKED);
		// the re-read answers: the upgrade is refused, on a socket already closed
		re_read.resolve({ rows: [] });
		await opened;
		assert.strictEqual(fake.closes.length, 1, 'no second close frame');
		assert.strictEqual(fake.socket.terminated, false);

		// the socket has not closed, so its close deadline still stands
		await vi.advanceTimersByTimeAsync(WS_CLOSE_WRITE_TIMEOUT);
		assert.strictEqual(fake.socket.terminated, true);
		assert.strictEqual(vi.getTimerCount(), 0);
	});
});

describe('register_action_ws outbound_queue_bytes', () => {
	const mount = (
		options: Partial<Parameters<typeof register_action_ws>[0]>
	): ReturnType<typeof register_action_ws> & { stub: ReturnType<typeof create_stub_upgrade> } => {
		const stub = create_stub_upgrade();
		const result = register_action_ws({
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null,
			path: '/ws',
			connection_closer: null,
			app: new Hono(),
			upgradeWebSocket: stub.upgradeWebSocket,
			allowed_origins: [],
			actions: [{ spec: echo_spec, handler: () => ({ value: 'x' }) }],
			db: create_stub_db(),
			heartbeat: false,
			log,
			...options
		});
		return { ...result, stub };
	};

	test('the created transport applies the default budget', async () => {
		const opened: Array<Parameters<BackendWebsocketTransport['send_to']>[0]> = [];
		const mounted = mount({ on_socket_open: (ctx) => void opened.push(ctx.connection_id) });
		const events = await mounted.stub.get_create_events()(
			create_fake_hono_context({ credential_type: 'session' })
		);
		const fake = create_fake_ws();
		await (events.onOpen?.(new Event('open'), fake.ws) as Promise<void> | void);
		const frame = 'x'.repeat(1024 * 1024 - OUTBOUND_FRAME_OVERHEAD_BYTES);
		const id = opened[0]!;
		// one frame through, then exactly the default budget of waiting frames
		assert.strictEqual(mounted.transport.send_to(id, 'first'), true);
		for (let i = 0; i < DEFAULT_WS_OUTBOUND_QUEUE_BYTES / (1024 * 1024); i++) {
			assert.strictEqual(mounted.transport.send_to(id, frame), true, `frame ${i}`);
		}
		assert.strictEqual(mounted.transport.send_to(id, ''), false, 'one more does not fit');
		assert.strictEqual(fake.closes[0]?.code, WS_CLOSE_OUTBOUND_OVERFLOW);
	});

	test('an override configures the created transport', async () => {
		const opened: Array<Parameters<BackendWebsocketTransport['send_to']>[0]> = [];
		const mounted = mount({
			outbound_queue_bytes: 10 + OUTBOUND_FRAME_OVERHEAD_BYTES,
			on_socket_open: (ctx) => void opened.push(ctx.connection_id)
		});
		const events = await mounted.stub.get_create_events()(
			create_fake_hono_context({ credential_type: 'session' })
		);
		const fake = create_fake_ws();
		await (events.onOpen?.(new Event('open'), fake.ws) as Promise<void> | void);
		const id = opened[0]!;
		assert.strictEqual(mounted.transport.send_to(id, 'first'), true);
		assert.strictEqual(mounted.transport.send_to(id, 'x'.repeat(10)), true);
		assert.strictEqual(mounted.transport.send_to(id, ''), false);
		assert.deepStrictEqual(fake.closes, [
			{ code: WS_CLOSE_OUTBOUND_OVERFLOW, reason: WS_CLOSE_OUTBOUND_OVERFLOW_REASON }
		]);
	});

	test('zero or a non-positive budget is refused when the endpoint is mounted', () => {
		for (const bad of [0, -1, 0.5]) {
			assert.throws(
				() => mount({ outbound_queue_bytes: bad }),
				/outbound_queue_bytes must be a positive integer/,
				String(bad)
			);
		}
	});

	test('a budget passed alongside a supplied transport is refused', () => {
		assert.throws(
			() => mount({ transport: new BackendWebsocketTransport(), outbound_queue_bytes: 1024 }),
			/outbound_queue_bytes configures the transport created for \/ws/
		);
	});
});

describe('_testing_flood_notifications', () => {
	const input = testing_flood_notifications_action_spec.input;

	test('the limits are the wire contract', () => {
		assert.strictEqual(TESTING_FLOOD_NOTIFICATION_METHOD, '_testing_flood');
		assert.strictEqual(TESTING_FLOOD_MAX_COUNT, 65_536);
		assert.strictEqual(TESTING_FLOOD_MAX_SIZE, 16 * 1024 * 1024);
		assert.strictEqual(TESTING_FLOOD_MAX_TOTAL_BYTES, 64 * 1024 * 1024);
		assert.strictEqual(ERROR_TESTING_FLOOD_NO_CONNECTION, 'no_connection');
	});

	test('the input is a strict object of two bounded integers', () => {
		assert.ok(input.safeParse({ count: 0, size: 0 }).success);
		assert.ok(
			input.safeParse({ count: TESTING_FLOOD_MAX_COUNT, size: TESTING_FLOOD_MAX_SIZE }).success
		);
		for (const bad of [
			{ count: TESTING_FLOOD_MAX_COUNT + 1, size: 0 },
			{ count: 0, size: TESTING_FLOOD_MAX_SIZE + 1 },
			{ count: -1, size: 0 },
			{ count: 0, size: -1 },
			{ count: 1.5, size: 0 },
			{ count: '1', size: 0 },
			{ count: 1 },
			{ size: 1 },
			{ count: 1, size: 1, extra: true }
		]) {
			assert.strictEqual(input.safeParse(bad).success, false, JSON.stringify(bad));
		}
	});

	const request_error = async (
		params: unknown
	): Promise<{ frame: JsonrpcErrorResponseFrame<{ reason?: string }>; flooded: number }> => {
		const harness = create_ws_test_harness({
			actions: [create_testing_flood_notifications_action()],
			transport: new BackendWebsocketTransport({ log: null })
		});
		const client = await harness.connect({ credential_type: 'daemon_token' });
		await client.send({ jsonrpc: '2.0', id: 'flood', method: FLOOD, params });
		const frame = await client.wait_for<JsonrpcErrorResponseFrame<{ reason?: string }>>(
			is_response_for('flood')
		);
		assert.strictEqual(client.close_code, null, 'a refusal leaves the socket open');
		return { frame, flooded: flood_indices(client.messages).length };
	};

	test('a call past a limit is refused with invalid_params and queues nothing', async () => {
		for (const params of [
			{ count: TESTING_FLOOD_MAX_COUNT + 1, size: 0 },
			{ count: 0, size: TESTING_FLOOD_MAX_SIZE + 1 },
			// each within its own limit, the product past the total
			{ count: 65, size: 1024 * 1024 }
		]) {
			const { frame, flooded } = await request_error(params);
			assert.strictEqual(
				frame.error.code,
				JSONRPC_ERROR_CODES.invalid_params,
				JSON.stringify(params)
			);
			assert.strictEqual(flooded, 0);
		}
		const { frame } = await request_error({ count: 65, size: 1024 * 1024 });
		assert.strictEqual(
			frame.error.message,
			`count * size must be at most ${TESTING_FLOOD_MAX_TOTAL_BYTES}`
		);
	});

	test('the product limit is inclusive', async () => {
		const harness = create_ws_test_harness({
			actions: [create_testing_flood_notifications_action()],
			// the whole burst fits: the limit under test is the action's, not the budget
			transport: new BackendWebsocketTransport({
				outbound_queue_bytes: 2 * TESTING_FLOOD_MAX_TOTAL_BYTES,
				log: null
			})
		});
		const client = await harness.connect({ credential_type: 'daemon_token' });
		const result = await client.request('flood', FLOOD, { count: 64, size: 1024 * 1024 });
		assert.deepStrictEqual(result, { queued: 64 });
	});

	test('a session credential is refused before the handler runs', async () => {
		const harness = create_ws_test_harness({
			actions: [create_testing_flood_notifications_action()]
		});
		const client = await harness.connect({ credential_type: 'session' });
		await client.send({
			jsonrpc: '2.0',
			id: 'flood',
			method: FLOOD,
			params: { count: 3, size: 8 }
		});
		const frame = await client.wait_for<JsonrpcErrorResponseFrame>(is_response_for('flood'));
		assert.strictEqual(frame.error.code, JSONRPC_ERROR_CODES.forbidden);
		assert.strictEqual(flood_indices(client.messages).length, 0);
	});

	test('with no connection to queue onto (HTTP) it refuses with reason no_connection', () => {
		const action = create_testing_flood_notifications_action();
		const notified: Array<unknown> = [];
		// the context an HTTP RPC dispatch builds: no `connection_id`
		const ctx = {
			connection_id: undefined,
			notify: (...args: Array<unknown>) => void notified.push(args)
		} as unknown as ActionContext;
		let thrown: unknown;
		try {
			void action.handler({ count: 3, size: 8 }, ctx);
		} catch (error) {
			thrown = error;
		}
		assert.ok(thrown instanceof ThrownJsonrpcError);
		assert.strictEqual(thrown.code, JSONRPC_ERROR_CODES.invalid_params);
		assert.strictEqual(thrown.message, '_testing_flood_notifications needs a WebSocket connection');
		assert.deepStrictEqual(thrown.data, { reason: ERROR_TESTING_FLOOD_NO_CONNECTION });
		assert.deepStrictEqual(notified, []);
	});
});
