/**
 * Tests for `BackendWebsocketTransport`'s outbound bound — the per-connection
 * byte budget, the `WS_CLOSE_OUTBOUND_OVERFLOW` close a frame that does not fit
 * causes, the write deadline, and what a close does on a backlogged
 * connection.
 *
 * The writer's own rules (what waits, the exact charge, the deadlines) are in
 * `ws_outbound_writer.test.ts`; this file pins what the transport does with
 * them.
 *
 * @module
 */

import { afterEach, describe, assert, test, vi } from 'vitest';
import { WSContext } from 'hono/ws';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';

import {
	BackendWebsocketTransport,
	DEFAULT_WS_OUTBOUND_QUEUE_BYTES
} from '#lib/actions/transports_ws_backend.ts';
import {
	DEFAULT_WS_MAX_MESSAGE_BYTES,
	WS_CLOSE_CONNECTION_LIMIT,
	WS_CLOSE_GOING_AWAY,
	WS_CLOSE_INTERNAL_ERROR,
	WS_CLOSE_OUTBOUND_OVERFLOW,
	WS_CLOSE_OUTBOUND_OVERFLOW_REASON,
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SESSION_REVOKED_REASON
} from '#lib/actions/transports.ts';
import {
	WS_CLOSE_WRITE_TIMEOUT,
	WS_WRITE_HIGH_WATER_BYTES,
	WS_WRITE_STALL_TIMEOUT
} from '#lib/actions/ws_outbound_writer.ts';
import { OUTBOUND_FRAME_OVERHEAD_BYTES } from '#lib/realtime/outbound_budget.ts';
import type { JsonrpcNotification } from '#lib/http/jsonrpc.ts';
import { create_fake_ws } from '#lib/testing/ws_round_trip.ts';

const ACCOUNT_A = create_uuid();
const ACCOUNT_B = create_uuid();

/** Let the pump scheduled by a send run. */
const flush_pump = (): Promise<void> => Promise.resolve();

/** A logger that records its `warn` calls. */
const create_warn_log = (): { log: Logger; warns: Array<Array<unknown>> } => {
	const warns: Array<Array<unknown>> = [];
	const log = new Logger('test', { level: 'off' });
	log.warn = (...args: Array<unknown>) => {
		warns.push(args);
	};
	return { log, warns };
};

const notification = (payload: string): JsonrpcNotification => ({
	jsonrpc: '2.0',
	method: 'thing_changed',
	params: { payload }
});

afterEach(() => {
	vi.useRealTimers();
});

describe('BackendWebsocketTransport outbound_queue_bytes', () => {
	test('the default is 4 MiB, a constant of its own', () => {
		assert.strictEqual(DEFAULT_WS_OUTBOUND_QUEUE_BYTES, 4 * 1024 * 1024);
		// four default-size messages as it stands, but not derived from that cap
		assert.strictEqual(DEFAULT_WS_OUTBOUND_QUEUE_BYTES, 4 * DEFAULT_WS_MAX_MESSAGE_BYTES);
	});

	test('the default budget holds a burst the override refuses', () => {
		const frame = 'x'.repeat(1000);
		const burst = (t: BackendWebsocketTransport): boolean => {
			const id = t.add_connection(create_fake_ws().ws, null, ACCOUNT_A);
			let accepted = true;
			for (let i = 0; i < 100; i++) accepted = t.send_to(id, frame) && accepted;
			return accepted;
		};
		assert.strictEqual(burst(new BackendWebsocketTransport({ log: null })), true);
		assert.strictEqual(
			burst(new BackendWebsocketTransport({ outbound_queue_bytes: 50_000, log: null })),
			false
		);
	});

	test('a budget that is not a positive integer is refused at construction', () => {
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(
				() => new BackendWebsocketTransport({ outbound_queue_bytes: bad }),
				/outbound_queue_bytes must be a positive integer/,
				String(bad)
			);
		}
	});
});

describe('BackendWebsocketTransport outbound overflow', () => {
	test('a frame that does not fit closes the connection with 4005 and removes it at once', async () => {
		const { log, warns } = create_warn_log();
		// room for exactly one waiting 10-byte frame
		const t = new BackendWebsocketTransport({
			outbound_queue_bytes: 10 + OUTBOUND_FRAME_OVERHEAD_BYTES,
			log
		});
		const fake = create_fake_ws();
		const controller = new AbortController();
		const id = t.add_connection(fake.ws, 'hash', ACCOUNT_A, null, controller);

		assert.strictEqual(t.send_to(id, 'first'), true, 'straight to the idle socket');
		assert.strictEqual(t.send_to(id, 'x'.repeat(10)), true, 'waits, exactly the budget');
		assert.strictEqual(t.is_registered(id), true);

		assert.strictEqual(t.send_to(id, ''), false, 'an empty frame still costs its overhead');
		// removed in the same synchronous step
		assert.strictEqual(t.is_registered(id), false);
		assert.strictEqual(t.get_connection_count(), 0);
		assert.strictEqual(controller.signal.aborted, true);
		assert.deepStrictEqual(fake.closes, [
			{ code: WS_CLOSE_OUTBOUND_OVERFLOW, reason: WS_CLOSE_OUTBOUND_OVERFLOW_REASON }
		]);
		assert.strictEqual(WS_CLOSE_OUTBOUND_OVERFLOW, 4005);
		assert.strictEqual(WS_CLOSE_OUTBOUND_OVERFLOW_REASON, 'outbound queue overflow');

		// later sends miss it, on every path
		assert.strictEqual(t.send_to(id, 'later'), false);
		assert.strictEqual(t.send_to_account(ACCOUNT_A, notification('later')), 0);
		assert.strictEqual(
			t.broadcast_filtered(notification('later'), () => true),
			0
		);
		assert.strictEqual(t.broadcast(notification('later')), 0);
		assert.deepStrictEqual(await t.request_connection(id, 'peer/ping', {}), {
			ok: false,
			error: { kind: 'connection_gone' }
		});

		// what waited is discarded, and nothing follows the close frame
		await flush_pump();
		assert.deepStrictEqual(fake.sends, ['first']);

		// one warning, naming the connection, its account, and what was waiting
		assert.deepStrictEqual(warns, [
			[
				'ws: outbound queue overflow, closing the connection',
				{
					connection_id: id,
					account_id: ACCOUNT_A,
					queued_bytes: 10,
					queued_frames: 1,
					frame_bytes: 0
				}
			]
		]);
	});

	test('the overflowing fan-out does not count the connection it closed', () => {
		const t = new BackendWebsocketTransport({
			outbound_queue_bytes: OUTBOUND_FRAME_OVERHEAD_BYTES,
			log: null
		});
		const full = create_fake_ws();
		const roomy = create_fake_ws();
		const full_id = t.add_connection(full.ws, null, ACCOUNT_A);
		t.add_connection(roomy.ws, null, ACCOUNT_A);
		// `full` now has a frame gone through and an empty one waiting: at its budget
		t.send_to(full_id, 'first');
		t.send_to(full_id, '');

		assert.strictEqual(t.send_to_account(ACCOUNT_A, notification('x')), 1);
		assert.strictEqual(full.closes[0]?.code, WS_CLOSE_OUTBOUND_OVERFLOW);
		assert.deepStrictEqual(roomy.closes, []);
		assert.strictEqual(t.get_connection_count(), 1);
	});

	test('one stalled recipient overflows while a healthy one gets every broadcast', async () => {
		const { log, warns } = create_warn_log();
		const frame_bytes = 20_000;
		const t = new BackendWebsocketTransport({ outbound_queue_bytes: 100_000, log });
		const stalled = create_fake_ws({ stalled: true });
		const healthy = create_fake_ws();
		const stalled_controller = new AbortController();
		const stalled_id = t.add_connection(stalled.ws, null, ACCOUNT_A, null, stalled_controller);
		const healthy_id = t.add_connection(healthy.ws, null, ACCOUNT_B);

		const rounds = 40;
		const sent: Array<string> = [];
		const counts: Array<number> = [];
		for (let i = 0; i < rounds; i++) {
			const message = notification(String(i).padStart(frame_bytes, '0'));
			sent.push(JSON.stringify(message));
			// never throws, never waits on the recipient that stopped reading
			counts.push(t.broadcast_filtered(message, () => true));
			// a producer that yields between broadcasts, as one driven by events does
			await flush_pump();
		}

		// the healthy recipient got everything, in order, and is still connected
		assert.deepStrictEqual(healthy.sends, sent);
		assert.deepStrictEqual(healthy.closes, []);
		assert.strictEqual(t.is_registered(healthy_id), true);

		// the stalled one was closed once its backlog passed the budget
		assert.strictEqual(t.is_registered(stalled_id), false);
		assert.strictEqual(stalled_controller.signal.aborted, true);
		assert.deepStrictEqual(stalled.closes, [
			{ code: WS_CLOSE_OUTBOUND_OVERFLOW, reason: WS_CLOSE_OUTBOUND_OVERFLOW_REASON }
		]);
		// it got a prefix of the stream — what its socket took before backing up
		assert.ok(stalled.sends.length > 0 && stalled.sends.length < rounds);
		assert.deepStrictEqual(stalled.sends, sent.slice(0, stalled.sends.length));
		// counted while it accepted frames, not from the overflowing broadcast on
		const overflowed_at = counts.indexOf(1);
		assert.ok(overflowed_at > 0, 'the stalled recipient accepted the first broadcasts');
		assert.deepStrictEqual(
			counts,
			counts.map((_, i) => (i < overflowed_at ? 2 : 1))
		);
		assert.strictEqual(warns.length, 1, 'one warning for the one overflow');
		t.close_all_connections();
		t.remove_connection(stalled_id);
		t.remove_connection(healthy_id);
	});

	test('a fan-out charges each recipient the frame at its UTF-8 length', () => {
		// 'é' is one UTF-16 code unit and two UTF-8 bytes
		const message = notification('é'.repeat(100));
		const text_bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
		assert.ok(text_bytes > JSON.stringify(message).length);
		for (const fan_out of [
			(t: BackendWebsocketTransport) => t.broadcast_filtered(message, () => true),
			(t: BackendWebsocketTransport) => t.send_to_account(ACCOUNT_A, message),
			(t: BackendWebsocketTransport) => t.broadcast(message)
		]) {
			// room for exactly one waiting copy of the message, to the byte
			const fits = new BackendWebsocketTransport({
				outbound_queue_bytes: text_bytes + OUTBOUND_FRAME_OVERHEAD_BYTES,
				log: null
			});
			const fits_ws = create_fake_ws();
			const fits_id = fits.add_connection(fits_ws.ws, null, ACCOUNT_A);
			fits.send_to(fits_id, 'first');
			fan_out(fits);
			assert.strictEqual(fits.is_registered(fits_id), true);

			// one byte less and the same message is the frame that does not fit
			const tight = new BackendWebsocketTransport({
				outbound_queue_bytes: text_bytes + OUTBOUND_FRAME_OVERHEAD_BYTES - 1,
				log: null
			});
			const tight_ws = create_fake_ws();
			const tight_id = tight.add_connection(tight_ws.ws, null, ACCOUNT_A);
			tight.send_to(tight_id, 'first');
			tight.send_to(tight_id, '');
			fan_out(tight);
			assert.strictEqual(tight.is_registered(tight_id), false);
			assert.strictEqual(tight_ws.closes[0]?.code, WS_CLOSE_OUTBOUND_OVERFLOW);
			tight.remove_connection(tight_id);
		}
	});

	test('a server-initiated request that overflows its connection settles connection_gone', async () => {
		const t = new BackendWebsocketTransport({
			outbound_queue_bytes: OUTBOUND_FRAME_OVERHEAD_BYTES,
			log: null
		});
		const fake = create_fake_ws();
		const id = t.add_connection(fake.ws, null, ACCOUNT_A);
		// in flight when the overflow lands
		const in_flight = t.request_connection(id, 'peer/ping', {});
		t.send_to(id, '');
		const overflowing = t.request_connection(id, 'peer/ping', {});
		const gone = { ok: false, error: { kind: 'connection_gone' } } as const;
		assert.deepStrictEqual(await overflowing, gone);
		assert.deepStrictEqual(await in_flight, gone);
		assert.strictEqual(fake.closes[0]?.code, WS_CLOSE_OUTBOUND_OVERFLOW);
	});

	test('a server-initiated request the socket refuses settles connection_gone at once', async () => {
		const t = new BackendWebsocketTransport({ log: null });
		const ws = new WSContext({
			send: () => {
				throw new Error('socket is gone');
			},
			close: () => {},
			readyState: 1
		});
		const id = t.add_connection(ws, null, ACCOUNT_A);
		// settled by the failed send, not left to the request's deadline
		const outcome = await Promise.race([
			t.request_connection(id, 'peer/ping', {}, { timeout_ms: 60_000 }),
			new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50))
		]);
		assert.deepStrictEqual(outcome, { ok: false, error: { kind: 'connection_gone' } });
		t.remove_connection(id);
	});

	test('a throwing close does not fail the producer that overflowed the connection', () => {
		const errors: Array<unknown> = [];
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args[0]);
		};
		const t = new BackendWebsocketTransport({
			outbound_queue_bytes: OUTBOUND_FRAME_OVERHEAD_BYTES,
			log
		});
		const ws = new WSContext({
			send: () => {},
			close: () => {
				throw new Error('close failed');
			},
			readyState: 1
		});
		const id = t.add_connection(ws, null, ACCOUNT_A);
		t.send_to(id, 'first');
		t.send_to(id, '');
		assert.strictEqual(t.send_to(id, ''), false);
		assert.strictEqual(t.is_registered(id), false);
		assert.deepStrictEqual(errors, ['error closing overflowed client:']);
		t.remove_connection(id);
	});
});

describe('BackendWebsocketTransport write deadline', () => {
	test('a connection whose socket takes nothing for the deadline is dropped with no close frame', async () => {
		vi.useFakeTimers();
		const { log, warns } = create_warn_log();
		const t = new BackendWebsocketTransport({ log });
		const fake = create_fake_ws({ stalled: true });
		const controller = new AbortController();
		const id = t.add_connection(fake.ws, null, ACCOUNT_A, null, controller);
		const in_flight = t.request_connection(id, 'peer/ping', {}, { timeout_ms: 60_000 });
		t.send_to(id, 'waiting');
		await flush_pump();

		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT - 1);
		assert.strictEqual(t.is_registered(id), true);
		assert.strictEqual(fake.socket.terminated, false);

		await vi.advanceTimersByTimeAsync(1);
		assert.strictEqual(t.is_registered(id), false);
		assert.strictEqual(t.get_connection_count(), 0);
		assert.strictEqual(controller.signal.aborted, true);
		// the abnormal end: cut, no close frame (the client sees 1006)
		assert.strictEqual(fake.socket.terminated, true);
		assert.deepStrictEqual(fake.closes, []);
		assert.deepStrictEqual(await in_flight, { ok: false, error: { kind: 'connection_gone' } });
		assert.strictEqual(t.send_to(id, 'later'), false);

		assert.strictEqual(warns.length, 1);
		assert.strictEqual(warns[0]![0], 'ws: write stalled, dropping the connection');
		const detail = warns[0]![1] as Record<string, unknown>;
		assert.strictEqual(detail.connection_id, id);
		assert.strictEqual(detail.account_id, ACCOUNT_A);
		assert.strictEqual(typeof detail.queued_bytes, 'number');
		assert.ok((detail.buffered_bytes as number) > 0);
		assert.strictEqual(vi.getTimerCount(), 0);
	});

	test('remove_connection clears the deadlines of a connection whose socket went away', async () => {
		vi.useFakeTimers();
		const t = new BackendWebsocketTransport({ log: null });
		const fake = create_fake_ws({ stalled: true });
		const id = t.add_connection(fake.ws, null, ACCOUNT_A);
		t.send_to(id, 'x'.repeat(WS_WRITE_HIGH_WATER_BYTES));
		t.send_to(id, 'waiting');
		await flush_pump();
		assert.ok(vi.getTimerCount() > 0);
		t.remove_connection(id);
		assert.strictEqual(vi.getTimerCount(), 0);
		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT);
		assert.strictEqual(fake.socket.terminated, false);
	});
});

describe('BackendWebsocketTransport.send_to', () => {
	test('a connection pending admission is sent nothing until it is admitted', async () => {
		const t = new BackendWebsocketTransport({ log: null });
		const fake = create_fake_ws();
		const id = t.register_pending(fake.ws, 'hash', ACCOUNT_A);
		assert.strictEqual(t.send_to(id, 'early'), false);
		await flush_pump();
		assert.deepStrictEqual(fake.sends, [], 'not written, and not queued for later');

		assert.strictEqual(t.admit(id), true);
		await flush_pump();
		assert.deepStrictEqual(fake.sends, []);
		assert.strictEqual(t.send_to(id, 'admitted'), true);
		assert.deepStrictEqual(fake.sends, ['admitted']);
		// an id that names nothing is refused the same way
		assert.strictEqual(t.send_to(create_uuid(), 'nobody'), false);
		t.remove_connection(id);
	});
});

describe('BackendWebsocketTransport closes on a backlogged connection', () => {
	test('a revocation hands the backlog over ahead of the 4001, then nothing more', async () => {
		const t = new BackendWebsocketTransport({ log: null });
		const fake = create_fake_ws();
		const id = t.add_connection(fake.ws, 'hash', ACCOUNT_A);
		// a reply queued in the same synchronous run as the revocation's close
		t.send_to(id, 'first');
		t.send_to(id, 'reply');
		assert.strictEqual(t.close_connections({ kind: 'session', session_hash: 'hash' }), 1);
		assert.deepStrictEqual(fake.sends, ['first', 'reply']);
		assert.deepStrictEqual(fake.closes, [
			{ code: WS_CLOSE_SESSION_REVOKED, reason: WS_CLOSE_SESSION_REVOKED_REASON }
		]);
		assert.strictEqual(t.is_registered(id), false);
		assert.strictEqual(t.send_to(id, 'after'), false);
		await flush_pump();
		assert.deepStrictEqual(fake.sends, ['first', 'reply']);
		t.remove_connection(id);
	});

	test('a revoked connection whose client stopped reading is cut at the close deadline', async () => {
		vi.useFakeTimers();
		const t = new BackendWebsocketTransport({ log: null });
		const fake = create_fake_ws({ stalled: true });
		const controller = new AbortController();
		const id = t.add_connection(fake.ws, null, ACCOUNT_A, null, controller);
		t.send_to(id, 'x'.repeat(WS_WRITE_HIGH_WATER_BYTES));
		t.send_to(id, 'waiting');
		await flush_pump();

		assert.strictEqual(t.close_connections({ kind: 'account', account_id: ACCOUNT_A }), 1);
		// removed and aborted at the close, not at the deadline
		assert.strictEqual(t.is_registered(id), false);
		assert.strictEqual(controller.signal.aborted, true);
		assert.strictEqual(fake.closes[0]?.code, WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(fake.socket.terminated, false);
		// the frame waiting behind the backed-up socket is discarded, not handed
		// to a socket that is taking nothing
		assert.strictEqual(fake.sends.length, 1);

		await vi.advanceTimersByTimeAsync(WS_CLOSE_WRITE_TIMEOUT);
		assert.strictEqual(fake.socket.terminated, true);
		assert.strictEqual(vi.getTimerCount(), 0);
	});

	test('every close that is not an overflow hands over what the socket has room for, no more', async () => {
		const big = 'x'.repeat(WS_WRITE_HIGH_WATER_BYTES);
		const closes: Array<[string, (t: BackendWebsocketTransport, id: Uuid) => void, number]> = [
			[
				'revocation',
				(t) => t.close_connections({ kind: 'account', account_id: ACCOUNT_A }),
				WS_CLOSE_SESSION_REVOKED
			],
			[
				'connection cap',
				(t) => t.add_connection(create_fake_ws().ws, null, ACCOUNT_A),
				WS_CLOSE_CONNECTION_LIMIT
			],
			['shutdown', (t) => t.close_all_connections(), WS_CLOSE_GOING_AWAY],
			[
				'close_connection',
				(t, id) => t.close_connection(id, WS_CLOSE_INTERNAL_ERROR, 'why'),
				WS_CLOSE_INTERNAL_ERROR
			]
		];
		for (const [name, close, code] of closes) {
			const t = new BackendWebsocketTransport({ max_connections_per_account: 1, log: null });
			const fake = create_fake_ws({ stalled: true });
			const id = t.add_connection(fake.ws, null, ACCOUNT_A);
			// one frame straight through, then three waiting in the same run
			t.send_to(id, 'first');
			t.send_to(id, big);
			t.send_to(id, 'reply');
			t.send_to(id, 'last');
			close(t, id);
			// `big` fits under the high-water mark and takes the buffer past it
			assert.deepStrictEqual(fake.sends, ['first', big], name);
			assert.strictEqual(fake.closes[0]?.code, code, name);
			fake.socket.bufferedAmount = 0;
			await flush_pump();
			assert.deepStrictEqual(fake.sends, ['first', big], `${name}: nothing follows the close`);
			t.close_all_connections();
			t.remove_connection(id);
		}
	});

	test("the socket's close arriving clears the close deadline", async () => {
		vi.useFakeTimers();
		const t = new BackendWebsocketTransport({ log: null });
		const fake = create_fake_ws({ stalled: true });
		const id = t.add_connection(fake.ws, null, ACCOUNT_A);
		t.send_to(id, 'frame');
		t.close_connections({ kind: 'account', account_id: ACCOUNT_A });
		assert.strictEqual(vi.getTimerCount(), 1);
		// what `register_action_ws` calls from the adapter's `onClose`
		t.remove_connection(id);
		assert.strictEqual(vi.getTimerCount(), 0);
		await vi.advanceTimersByTimeAsync(WS_CLOSE_WRITE_TIMEOUT);
		assert.strictEqual(fake.socket.terminated, false);
	});
});

describe('BackendWebsocketTransport.close_connection', () => {
	test('closes one connection, pending or admitted, removing and aborting it', () => {
		const t = new BackendWebsocketTransport({ log: null });
		const admitted = create_fake_ws();
		const pending = create_fake_ws();
		const controller = new AbortController();
		const admitted_id = t.add_connection(admitted.ws, null, ACCOUNT_A, null, controller);
		const pending_id = t.register_pending(pending.ws, null, ACCOUNT_A);

		assert.strictEqual(t.close_connection(admitted_id, WS_CLOSE_INTERNAL_ERROR, 'why'), true);
		assert.deepStrictEqual(admitted.closes, [{ code: WS_CLOSE_INTERNAL_ERROR, reason: 'why' }]);
		assert.strictEqual(controller.signal.aborted, true);
		assert.strictEqual(t.is_registered(admitted_id), false);

		assert.strictEqual(t.close_connection(pending_id, WS_CLOSE_INTERNAL_ERROR, 'why'), true);
		assert.strictEqual(pending.closes.length, 1);
		assert.strictEqual(t.get_pending_connection_count(), 0);

		// nothing to close a second time, or for an id that names nothing
		assert.strictEqual(t.close_connection(admitted_id, WS_CLOSE_INTERNAL_ERROR, 'why'), false);
		assert.strictEqual(t.close_connection(create_uuid(), WS_CLOSE_INTERNAL_ERROR, 'why'), false);
		assert.strictEqual(admitted.closes.length, 1);
		t.remove_connection(admitted_id);
		t.remove_connection(pending_id);
	});

	test('a socket whose close throws is logged, never thrown at the caller', () => {
		const errors: Array<Array<unknown>> = [];
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args);
		};
		const t = new BackendWebsocketTransport({ log });
		const close_error = new Error('socket is gone');
		const ws = new WSContext({
			send: () => {},
			close: () => {
				throw close_error;
			},
			readyState: 1
		});
		const controller = new AbortController();
		const connection_id = t.add_connection(ws, null, ACCOUNT_A, null, controller);

		// called from a heartbeat timer, where a throw would be uncaught
		assert.strictEqual(t.close_connection(connection_id, WS_CLOSE_INTERNAL_ERROR, 'why'), true);
		assert.strictEqual(t.is_registered(connection_id), false);
		assert.strictEqual(t.get_connection_count(), 0);
		assert.strictEqual(controller.signal.aborted, true);
		assert.deepStrictEqual(errors, [
			[`error closing client with ${WS_CLOSE_INTERNAL_ERROR}:`, close_error]
		]);
		t.remove_connection(connection_id);
	});
});
