/**
 * Tests for `WsOutboundWriter` — the outbound queue and write pump of one
 * WebSocket connection: what goes straight to the socket and what waits, the
 * byte budget on what waits, delivery order, the write and close deadlines,
 * what a close does with the backlog, and that a frame handed to the socket is
 * not kept.
 *
 * Drives the writer against `create_fake_ws`, whose fake runtime socket models
 * a client that stopped reading (`socket.stalled`).
 *
 * @module
 */

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { afterEach, describe, assert, test, vi } from 'vitest';
import { WSContext } from 'hono/ws';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	WS_CLOSE_WRITE_TIMEOUT,
	WS_WRITE_HIGH_WATER_BYTES,
	WS_WRITE_STALL_TIMEOUT,
	WsOutboundWriter,
	type WsOutboundStall
} from '#lib/actions/ws_outbound_writer.ts';
import {
	WS_CLOSE_OUTBOUND_OVERFLOW,
	WS_CLOSE_OUTBOUND_OVERFLOW_REASON,
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SESSION_REVOKED_REASON
} from '#lib/actions/transports.ts';
import { DEFAULT_PEER_REQUEST_TIMEOUT } from '#lib/actions/peer_request.ts';
import { OUTBOUND_FRAME_OVERHEAD_BYTES } from '#lib/realtime/outbound_budget.ts';
import { create_fake_ws, type FakeWs } from '#lib/testing/ws_round_trip.ts';

const ACCEPTED = { kind: 'accepted' } as const;
const REFUSED = { kind: 'refused' } as const;

/** Let the pump scheduled by a push run. */
const flush_pump = (): Promise<void> => Promise.resolve();

const create_writer = (
	fake: FakeWs,
	max_bytes: number
): { writer: WsOutboundWriter; stalls: Array<WsOutboundStall> } => {
	const stalls: Array<WsOutboundStall> = [];
	const writer = new WsOutboundWriter({
		ws: fake.ws,
		max_bytes,
		on_stall: (stall) => stalls.push(stall),
		log: null
	});
	return { writer, stalls };
};

afterEach(() => {
	vi.useRealTimers();
});

describe('WsOutboundWriter deadlines', () => {
	test('the write deadline is the peer request timeout, the close deadline one second', () => {
		assert.strictEqual(WS_WRITE_STALL_TIMEOUT, 10_000);
		assert.strictEqual(WS_WRITE_STALL_TIMEOUT, DEFAULT_PEER_REQUEST_TIMEOUT);
		assert.strictEqual(WS_CLOSE_WRITE_TIMEOUT, 1_000);
	});
});

describe('WsOutboundWriter.push', () => {
	test('a frame pushed at an idle connection goes straight to the socket', () => {
		const fake = create_fake_ws();
		const { writer } = create_writer(fake, 1000);
		assert.deepStrictEqual(writer.push('a'), ACCEPTED);
		assert.deepStrictEqual(fake.sends, ['a']);
		assert.strictEqual(writer.queued_frames, 0);
	});

	test('the rest of a synchronous burst waits, and is delivered in order', async () => {
		const fake = create_fake_ws();
		const { writer } = create_writer(fake, 1000);
		assert.deepStrictEqual(writer.push('a'), ACCEPTED);
		assert.deepStrictEqual(writer.push('b'), ACCEPTED);
		assert.deepStrictEqual(writer.push('c'), ACCEPTED);
		assert.deepStrictEqual(fake.sends, ['a']);
		assert.strictEqual(writer.queued_frames, 2);
		assert.strictEqual(writer.queued_bytes, 2);

		await flush_pump();
		assert.deepStrictEqual(fake.sends, ['a', 'b', 'c']);
		assert.strictEqual(writer.queued_frames, 0);
		assert.strictEqual(writer.queued_bytes, 0);

		// idle again: the next frame goes straight through
		assert.deepStrictEqual(writer.push('d'), ACCEPTED);
		assert.deepStrictEqual(fake.sends, ['a', 'b', 'c', 'd']);
	});

	test('a queue that emptied takes waiting frames again, in order', async () => {
		const fake = create_fake_ws();
		const { writer } = create_writer(fake, 1000);
		// each burst: one frame straight through, the rest waiting until the pump
		for (const burst of [
			['a', 'b', 'c'],
			['d', 'e', 'f'],
			['g', 'h']
		]) {
			for (const text of burst) assert.deepStrictEqual(writer.push(text), ACCEPTED);
			assert.strictEqual(writer.queued_frames, burst.length - 1);
			await flush_pump();
			// the pump emptied the queue: nothing waits and nothing is charged
			assert.strictEqual(writer.queued_frames, 0);
			assert.strictEqual(writer.queued_bytes, 0);
		}
		assert.deepStrictEqual(fake.sends, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
	});

	test('the budget is exact at the boundary, charging each waiting frame 64 bytes', () => {
		// room for two waiting frames of 4 and 6 bytes, to the byte
		const max_bytes = 10 + 2 * OUTBOUND_FRAME_OVERHEAD_BYTES;
		const fake = create_fake_ws();
		const { writer } = create_writer(fake, max_bytes);
		writer.push('first goes straight through, uncharged');
		assert.deepStrictEqual(writer.push('aaaa'), ACCEPTED);
		assert.deepStrictEqual(writer.push('bbbbbb'), ACCEPTED);
		assert.deepStrictEqual(writer.push(''), {
			kind: 'overflow',
			overflow: { queued_bytes: 10, queued_frames: 2, frame_bytes: 0 }
		});

		// one byte less of budget and the second waiting frame is the one too many
		const tight = create_fake_ws();
		const { writer: tight_writer } = create_writer(tight, max_bytes - 1);
		tight_writer.push('first');
		assert.deepStrictEqual(tight_writer.push('aaaa'), ACCEPTED);
		assert.strictEqual(tight_writer.push('bbbbbb').kind, 'overflow');
	});

	test('a frame is charged its UTF-8 length, not its UTF-16 length', () => {
		// 'é' is one UTF-16 code unit and two UTF-8 bytes
		const fake = create_fake_ws();
		const { writer } = create_writer(fake, 1000);
		writer.push('first');
		writer.push('éé');
		assert.strictEqual(writer.queued_bytes, 4);
	});

	test('an oversized frame is accepted when nothing is waiting, whatever its size', async () => {
		const max_bytes = 100;
		const big = 'x'.repeat(50 * max_bytes);
		// a backed-up socket, so the frame cannot go straight through
		const fake = create_fake_ws({ stalled: true });
		const { writer } = create_writer(fake, max_bytes);
		writer.push('y'.repeat(WS_WRITE_HIGH_WATER_BYTES));
		await flush_pump();
		assert.strictEqual(fake.sends.length, 1);

		assert.deepStrictEqual(writer.push(big), ACCEPTED, 'nothing was waiting');
		assert.strictEqual(writer.queued_frames, 1);
		// behind it, even an empty frame does not fit
		assert.strictEqual(writer.push('').kind, 'overflow');
		// stop the deadline and the poll of the backed-up socket
		writer.dispose();
	});

	test('nothing counts frames: a burst of thousands within the budget is delivered in order', async () => {
		const frames = 5000;
		const max_bytes = frames * (8 + OUTBOUND_FRAME_OVERHEAD_BYTES);
		const fake = create_fake_ws();
		const { writer } = create_writer(fake, max_bytes);
		const expected: Array<string> = [];
		for (let n = 0; n <= frames; n++) {
			const frame = String(n).padStart(8, '0');
			expected.push(frame);
			assert.deepStrictEqual(writer.push(frame), ACCEPTED, `frame ${n}`);
		}
		// the first went straight through; the budget held exactly the rest
		assert.strictEqual(writer.queued_frames, frames);
		assert.strictEqual(writer.push('00000000').kind, 'overflow');

		await flush_pump();
		assert.deepStrictEqual(fake.sends, expected);
	});

	test('an overflow does not queue the frame and leaves the writer to its owner', async () => {
		const fake = create_fake_ws();
		const { writer } = create_writer(fake, OUTBOUND_FRAME_OVERHEAD_BYTES + 1);
		writer.push('a');
		assert.deepStrictEqual(writer.push('b'), ACCEPTED);
		assert.strictEqual(writer.push('c').kind, 'overflow');
		assert.strictEqual(writer.queued_frames, 1);

		// the owner closes for it, discarding what waited
		writer.close(WS_CLOSE_OUTBOUND_OVERFLOW, WS_CLOSE_OUTBOUND_OVERFLOW_REASON, 'discard');
		await flush_pump();
		assert.deepStrictEqual(fake.sends, ['a']);
		assert.deepStrictEqual(fake.closes, [
			{ code: WS_CLOSE_OUTBOUND_OVERFLOW, reason: WS_CLOSE_OUTBOUND_OVERFLOW_REASON }
		]);
		assert.deepStrictEqual(writer.push('d'), REFUSED);
	});

	test('frames wait while the socket is backed up, and go out as it drains', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws({ stalled: true });
		const { writer, stalls } = create_writer(fake, 1_000_000);
		const big = 'x'.repeat(WS_WRITE_HIGH_WATER_BYTES);
		writer.push(big);
		await flush_pump();
		// the socket holds a high-water mark's worth: the next frames wait
		writer.push('b');
		writer.push('c');
		await flush_pump();
		assert.deepStrictEqual(fake.sends, [big]);
		assert.strictEqual(writer.queued_frames, 2);

		// the client reads: the buffer drains, and the pump's poll hands the rest over
		fake.socket.stalled = false;
		fake.socket.bufferedAmount = 0;
		await vi.advanceTimersByTimeAsync(100);
		assert.deepStrictEqual(fake.sends, [big, 'b', 'c']);
		assert.strictEqual(writer.queued_frames, 0);

		// nothing is unwritten any more: no deadline is left running
		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT * 2);
		assert.deepStrictEqual(stalls, []);
		assert.strictEqual(fake.socket.terminated, false);
		assert.strictEqual(vi.getTimerCount(), 0);
	});

	test('a socket that throws on send is logged, never thrown at the producer', () => {
		const ws = new WSContext({
			send: () => {
				throw new Error('socket is gone');
			},
			close: () => {},
			readyState: 1
		});
		const errors: Array<unknown> = [];
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args[0]);
		};
		const writer = new WsOutboundWriter({ ws, max_bytes: 1000, on_stall: () => {}, log });
		assert.deepStrictEqual(writer.push('a'), REFUSED);
		assert.deepStrictEqual(errors, ['error sending to client:']);
	});
});

describe('WsOutboundWriter memory', () => {
	/**
	 * The heap in bytes after full collections. The collector is reached the
	 * way a leak detector reaches it — exposed for the call — so the suite needs
	 * no `--expose-gc`. Collected twice with a turn of the event loop between,
	 * so what the first pass only finalized is freed by the second.
	 */
	const collected_heap_bytes = async (): Promise<number> => {
		setFlagsFromString('--expose-gc');
		const collect = runInNewContext('gc') as () => void;
		setFlagsFromString('--no-expose-gc');
		collect();
		await new Promise((resolve) => setTimeout(resolve, 0));
		collect();
		const { heapUsed, external } = process.memoryUsage();
		return heapUsed + external;
	};

	test('a queue that never empties does not keep the frames it handed over', async () => {
		// under the size at which Node backs a string with memory outside the heap
		const frame_bytes = 512 * 1024;
		const rounds = 128;
		// a flat string of its own each time, so a kept frame costs its full size
		const fresh_frame = (): string => Buffer.alloc(frame_bytes, 0x78).toString('latin1');
		const fake = create_fake_ws({ stalled: true });
		const { writer, stalls } = create_writer(fake, 4 * frame_bytes);
		// a slow, steady reader: two frames wait behind a backed-up socket, and
		// each round the client takes what was buffered, the pump hands one frame
		// over, and one more is produced — the queue is never empty
		fake.socket.bufferedAmount = WS_WRITE_HIGH_WATER_BYTES;
		assert.deepStrictEqual(writer.push(fresh_frame()), ACCEPTED);
		assert.deepStrictEqual(writer.push(fresh_frame()), ACCEPTED);
		await flush_pump();
		assert.strictEqual(fake.sends.length, 0);

		let kept: number;
		try {
			const before = await collected_heap_bytes();
			for (let i = 0; i < rounds; i++) {
				fake.socket.bufferedAmount = 0;
				assert.deepStrictEqual(writer.push(fresh_frame()), ACCEPTED);
				await flush_pump();
				assert.strictEqual(writer.queued_frames, 2, `round ${i}: one handed over, one queued`);
				// the test's own record of the sends must not be what keeps them
				assert.strictEqual(fake.sends.length, 1);
				fake.sends.length = 0;
			}
			kept = (await collected_heap_bytes()) - before;
		} finally {
			// stops the poll of the backed-up socket, whatever failed
			writer.dispose();
		}

		// the writer holds the two frames that wait, as it did before the rounds;
		// every frame it kept would add its size
		assert.ok(
			kept < (rounds / 4) * frame_bytes,
			`${Math.round(kept / frame_bytes)} of ${rounds} handed frames still held`
		);
		assert.deepStrictEqual(stalls, []);
	});
});

describe('WsOutboundWriter write deadline', () => {
	test('bytes unwritten at the deadline discard the backlog, report, and cut the socket', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws({ stalled: true });
		const { writer, stalls } = create_writer(fake, 1_000_000);
		const big = 'x'.repeat(WS_WRITE_HIGH_WATER_BYTES);
		writer.push(big);
		writer.push('bb');
		writer.push('cc');
		await flush_pump();
		assert.deepStrictEqual(fake.sends, [big]);

		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT - 1);
		assert.deepStrictEqual(stalls, []);
		assert.strictEqual(fake.socket.terminated, false);

		await vi.advanceTimersByTimeAsync(1);
		assert.deepStrictEqual(stalls, [
			{ queued_bytes: 4, queued_frames: 2, buffered_bytes: WS_WRITE_HIGH_WATER_BYTES }
		]);
		// cut with no close frame, and nothing that waited is written
		assert.strictEqual(fake.socket.terminated, true);
		assert.deepStrictEqual(fake.closes, []);
		assert.deepStrictEqual(fake.sends, [big]);
		assert.deepStrictEqual(writer.push('d'), REFUSED);
		assert.strictEqual(vi.getTimerCount(), 0);
	});

	test('a client that takes what was buffered inside the deadline is not dropped', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws({ stalled: true });
		const { writer, stalls } = create_writer(fake, 1_000_000);
		writer.push('x'.repeat(WS_WRITE_HIGH_WATER_BYTES));
		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT - 100);
		fake.socket.bufferedAmount = 0;
		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT);
		assert.deepStrictEqual(stalls, []);
		assert.strictEqual(fake.socket.terminated, false);
	});

	test('the deadline covers the bytes buffered when it started, not later frames', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws({ stalled: true });
		const { writer, stalls } = create_writer(fake, 1_000_000);
		const frame = 'x'.repeat(WS_WRITE_HIGH_WATER_BYTES);
		writer.push(frame);
		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT - 100);
		// the client took the first frame; a second is handed over and stays
		fake.socket.bufferedAmount = 0;
		writer.push(frame);
		// past the first frame's deadline, inside the second's
		await vi.advanceTimersByTimeAsync(200);
		assert.deepStrictEqual(stalls, []);
		// the second frame's own deadline
		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT);
		assert.strictEqual(stalls.length, 1);
		assert.strictEqual(fake.socket.terminated, true);
	});

	test('a busy connection whose client keeps reading is not dropped', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws({ stalled: true });
		const { writer, stalls } = create_writer(fake, 1_000_000);
		const frame = 'x'.repeat(1000);
		writer.push(frame);
		// the buffer never empties: each second one more frame is handed over and
		// the client has taken everything before it, well past one deadline
		const rounds = (WS_WRITE_STALL_TIMEOUT / 1000) * 3;
		for (let round = 0; round < rounds; round++) {
			assert.deepStrictEqual(writer.push(frame), ACCEPTED);
			await flush_pump();
			fake.socket.bufferedAmount = frame.length;
			await vi.advanceTimersByTimeAsync(1000);
		}
		assert.deepStrictEqual(stalls, []);
		assert.strictEqual(fake.socket.terminated, false);
		assert.strictEqual(fake.sends.length, rounds + 1);
		writer.dispose();
	});

	test('a client taking the buffered bytes too slowly is dropped at the deadline', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws({ stalled: true });
		const { writer, stalls } = create_writer(fake, 1_000_000);
		writer.push('x'.repeat(WS_WRITE_HIGH_WATER_BYTES));
		// steady progress that does not finish: the deadline is not reset by it
		const seconds = WS_WRITE_STALL_TIMEOUT / 1000;
		for (let second = 1; second < seconds; second++) {
			await vi.advanceTimersByTimeAsync(1000);
			fake.socket.bufferedAmount = WS_WRITE_HIGH_WATER_BYTES - second * 1000;
		}
		assert.deepStrictEqual(stalls, []);
		assert.strictEqual(fake.socket.terminated, false);
		await vi.advanceTimersByTimeAsync(1000);
		assert.deepStrictEqual(stalls, [
			{
				queued_bytes: 0,
				queued_frames: 0,
				buffered_bytes: WS_WRITE_HIGH_WATER_BYTES - (seconds - 1) * 1000
			}
		]);
		assert.strictEqual(fake.socket.terminated, true);
	});

	test('a socket reporting its buffer through getBufferedAmount is held back and cut', async () => {
		vi.useFakeTimers();
		// Bun's `ServerWebSocket`: a method to read the buffer, and `terminate`
		const sends: Array<string> = [];
		let buffered = 0;
		let terminated = false;
		const ws = new WSContext({
			send: (data) => {
				const text = data as string;
				sends.push(text);
				buffered += text.length;
			},
			close: () => {},
			raw: {
				getBufferedAmount: () => buffered,
				terminate: () => {
					terminated = true;
				}
			},
			readyState: 1
		});
		const stalls: Array<WsOutboundStall> = [];
		const writer = new WsOutboundWriter({
			ws,
			max_bytes: 1_000_000,
			on_stall: (stall) => stalls.push(stall),
			log: null
		});
		const big = 'x'.repeat(WS_WRITE_HIGH_WATER_BYTES);
		writer.push(big);
		await flush_pump();
		// a later run: the socket is at the high-water mark, so the frame waits
		assert.deepStrictEqual(writer.push('bb'), ACCEPTED);
		await flush_pump();
		assert.deepStrictEqual(sends, [big]);
		assert.strictEqual(writer.queued_frames, 1);

		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT);
		assert.deepStrictEqual(stalls, [
			{ queued_bytes: 2, queued_frames: 1, buffered_bytes: WS_WRITE_HIGH_WATER_BYTES }
		]);
		assert.strictEqual(terminated, true);
		assert.deepStrictEqual(sends, [big]);
	});

	test('an on_stall that throws is logged, and the socket is still cut', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws({ stalled: true });
		const errors: Array<unknown> = [];
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args[0]);
		};
		const writer = new WsOutboundWriter({
			ws: fake.ws,
			max_bytes: 1000,
			on_stall: () => {
				throw new Error('owner failed');
			},
			log
		});
		writer.push('x');
		// the deadline runs on a timer: a throw here would be an uncaught exception
		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT);
		assert.deepStrictEqual(errors, ['error reporting a stalled socket:']);
		assert.strictEqual(fake.socket.terminated, true);
		assert.deepStrictEqual(writer.push('y'), REFUSED);
	});

	test('a socket with no way to be cut is closed with the overflow code instead', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws({ stalled: true });
		// Deno's standard WebSocket: a buffer to read, no `terminate`
		(fake.socket as { terminate?: unknown }).terminate = undefined;
		const { writer, stalls } = create_writer(fake, 1_000_000);
		writer.push('x'.repeat(WS_WRITE_HIGH_WATER_BYTES));
		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT);
		assert.strictEqual(stalls.length, 1);
		assert.deepStrictEqual(fake.closes, [
			{ code: WS_CLOSE_OUTBOUND_OVERFLOW, reason: WS_CLOSE_OUTBOUND_OVERFLOW_REASON }
		]);
	});
});

describe('WsOutboundWriter.close', () => {
	test("'flush' hands over what the socket has room for and discards the rest", async () => {
		const fake = create_fake_ws({ stalled: true });
		const { writer } = create_writer(fake, 1_000_000);
		const big = 'x'.repeat(WS_WRITE_HIGH_WATER_BYTES);
		// one frame straight through, then three waiting in the same run
		writer.push('a');
		writer.push(big);
		writer.push('reply');
		writer.push('c');
		assert.strictEqual(writer.queued_frames, 3);

		writer.close(WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON, 'flush');
		// under the high-water mark `big` is handed over; it takes the buffer past
		// the mark, so the frames behind it are not
		assert.deepStrictEqual(fake.sends, ['a', big]);
		assert.deepStrictEqual(fake.closes, [
			{ code: WS_CLOSE_SESSION_REVOKED, reason: WS_CLOSE_SESSION_REVOKED_REASON }
		]);
		// discarded, not held for the socket to drain
		assert.strictEqual(writer.queued_frames, 0);
		assert.strictEqual(writer.queued_bytes, 0);
		fake.socket.bufferedAmount = 0;
		await flush_pump();
		assert.deepStrictEqual(fake.sends, ['a', big]);
		writer.dispose();
	});

	test("'flush' hands nothing to a socket already at the high-water mark", () => {
		const fake = create_fake_ws({ stalled: true });
		const { writer } = create_writer(fake, 1_000_000);
		const big = 'x'.repeat(WS_WRITE_HIGH_WATER_BYTES);
		writer.push(big);
		writer.push('reply');
		writer.close(WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON, 'flush');
		// the reply queued behind a backed-up socket is not delivered
		assert.deepStrictEqual(fake.sends, [big]);
		assert.strictEqual(fake.closes.length, 1);
		assert.strictEqual(writer.queued_frames, 0);
		// what the runtime holds after the close: one frame and the close frame
		assert.ok(fake.socket.bufferedAmount < 2 * WS_WRITE_HIGH_WATER_BYTES);
		writer.dispose();
	});

	test("'flush' stops at a frame the socket throws on", () => {
		const sends: Array<string> = [];
		const closes: Array<number | undefined> = [];
		const ws = new WSContext({
			send: (data) => {
				if (data === 'b') throw new Error('socket is gone');
				if (typeof data === 'string') sends.push(data);
			},
			close: (code) => {
				closes.push(code);
			},
			readyState: 1
		});
		const writer = new WsOutboundWriter({ ws, max_bytes: 1000, on_stall: () => {}, log: null });
		writer.push('a');
		writer.push('b');
		writer.push('c');
		writer.close(WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON, 'flush');
		assert.deepStrictEqual(sends, ['a']);
		assert.deepStrictEqual(closes, [WS_CLOSE_SESSION_REVOKED]);
		assert.strictEqual(writer.queued_frames, 0);
		writer.dispose();
	});

	test("'flush' hands the backlog to the socket ahead of the close frame", () => {
		const fake = create_fake_ws();
		const { writer } = create_writer(fake, 1000);
		writer.push('a');
		writer.push('reply');
		// closed in the same synchronous run as the reply was pushed
		writer.close(WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON, 'flush');
		assert.deepStrictEqual(fake.sends, ['a', 'reply']);
		assert.deepStrictEqual(fake.closes, [
			{ code: WS_CLOSE_SESSION_REVOKED, reason: WS_CLOSE_SESSION_REVOKED_REASON }
		]);
		assert.deepStrictEqual(writer.push('late'), REFUSED);
		// a second close is a no-op
		writer.close(WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON, 'flush');
		assert.strictEqual(fake.closes.length, 1);
		writer.dispose();
	});

	test('nothing is written after the close frame', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws();
		const { writer } = create_writer(fake, 1000);
		writer.push('a');
		writer.push('b');
		writer.close(WS_CLOSE_OUTBOUND_OVERFLOW, WS_CLOSE_OUTBOUND_OVERFLOW_REASON, 'discard');
		// in the same synchronous run as the close, and in a later one
		assert.deepStrictEqual(writer.push('c'), REFUSED);
		await flush_pump();
		assert.deepStrictEqual(writer.push('d'), REFUSED);
		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT);
		assert.deepStrictEqual(fake.sends, ['a']);
		assert.strictEqual(fake.closes.length, 1);
	});

	test('a close frame still unwritten at the close deadline cuts the socket', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws({ stalled: true });
		const { writer, stalls } = create_writer(fake, 1_000_000);
		writer.push('x'.repeat(WS_WRITE_HIGH_WATER_BYTES));
		let settled = 0;
		writer.close(WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON, 'flush', () => {
			settled++;
		});
		await vi.advanceTimersByTimeAsync(WS_CLOSE_WRITE_TIMEOUT - 1);
		assert.strictEqual(fake.socket.terminated, false);
		assert.strictEqual(settled, 0);

		await vi.advanceTimersByTimeAsync(1);
		assert.strictEqual(fake.socket.terminated, true);
		assert.strictEqual(settled, 1);
		// a close is not a stall: the write deadline was dropped with the close
		await vi.advanceTimersByTimeAsync(WS_WRITE_STALL_TIMEOUT);
		assert.deepStrictEqual(stalls, []);
		assert.strictEqual(vi.getTimerCount(), 0);
	});

	test('a close frame that was written leaves the socket to its closing handshake', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws();
		const { writer } = create_writer(fake, 1000);
		writer.push('a');
		let settled = 0;
		writer.close(WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON, 'flush', () => {
			settled++;
		});
		await vi.advanceTimersByTimeAsync(WS_CLOSE_WRITE_TIMEOUT);
		assert.strictEqual(fake.socket.terminated, false);
		assert.strictEqual(settled, 1);
	});

	test('dispose clears the close deadline and every other timer', async () => {
		vi.useFakeTimers();
		const fake = create_fake_ws({ stalled: true });
		const { writer, stalls } = create_writer(fake, 1_000_000);
		writer.push('x'.repeat(WS_WRITE_HIGH_WATER_BYTES));
		writer.push('waiting');
		await flush_pump();
		assert.ok(vi.getTimerCount() > 0, 'the deadline and the poll are running');
		writer.dispose();
		assert.strictEqual(vi.getTimerCount(), 0);
		assert.strictEqual(writer.queued_frames, 0);

		const closing = create_fake_ws({ stalled: true });
		const { writer: closing_writer } = create_writer(closing, 1000);
		closing_writer.push('a');
		let settled = 0;
		closing_writer.close(WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON, 'flush', () => {
			settled++;
		});
		assert.strictEqual(vi.getTimerCount(), 1);
		// the socket's close arrived
		closing_writer.dispose();
		assert.strictEqual(vi.getTimerCount(), 0);
		await vi.advanceTimersByTimeAsync(WS_CLOSE_WRITE_TIMEOUT * 2);
		assert.strictEqual(closing.socket.terminated, false);
		assert.strictEqual(settled, 0);
		assert.deepStrictEqual(stalls, []);
	});
});
