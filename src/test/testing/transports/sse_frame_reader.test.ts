/**
 * Tests for `create_sse_frame_reader`: its per-read timer, a timed-out read
 * kept in flight so the stream stays usable, and `cancel`.
 *
 * @module
 */

import { describe, test, assert, vi } from 'vitest';

import { create_sse_frame_reader } from '#lib/testing/transports/sse_frame_reader.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A stream the test feeds, with whether it was cancelled. */
const create_fed_stream = (): {
	stream: ReadableStream<Uint8Array>;
	controller: ReadableStreamDefaultController<Uint8Array>;
	cancelled: () => boolean;
} => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start: (c) => {
			controller = c;
		},
		cancel: () => {
			cancelled = true;
		}
	});
	return { stream, controller, cancelled: () => cancelled };
};

describe('create_sse_frame_reader', () => {
	test('a quick read leaves no timer behind', async () => {
		vi.useFakeTimers();
		try {
			const { stream, controller } = create_fed_stream();
			controller.enqueue(encode('first\n\nsecond\n\n'));
			const sse = create_sse_frame_reader(stream.getReader(), 1000);
			const read = sse.read_frame();
			await vi.advanceTimersByTimeAsync(0);
			assert.strictEqual(await read, 'first');
			assert.strictEqual(vi.getTimerCount(), 0);
			// the second frame is buffered, so no read and no timer
			assert.strictEqual(await sse.read_frame(), 'second');
			assert.strictEqual(vi.getTimerCount(), 0);
		} finally {
			vi.useRealTimers();
		}
	});

	test('a timed-out read leaves the stream open, and its chunk reaches the next read', async () => {
		const { stream, controller, cancelled } = create_fed_stream();
		const sse = create_sse_frame_reader(stream.getReader(), 20);
		const first = await sse.read_frame().then(
			() => 'resolved',
			(e: unknown) => (e instanceof Error ? e.message : String(e))
		);
		assert.strictEqual(first, 'SSE read timed out after 20ms');
		assert.isFalse(cancelled());
		// the timed-out read is still pending; the chunk lands on it, and is
		// kept for the next read across the gap before it
		controller.enqueue(encode('late\n\n'));
		await pause(5);
		assert.strictEqual(await sse.read_frame(), 'late');
		await sse.cancel();
	});

	test('wait_for_close answers false on a timeout and leaves the stream usable', async () => {
		const { stream, controller, cancelled } = create_fed_stream();
		const sse = create_sse_frame_reader(stream.getReader(), 20);
		assert.isFalse(await sse.wait_for_close(20));
		assert.isFalse(cancelled());
		controller.enqueue(encode('after\n\n'));
		// the read settles in the gap, with no pump awaiting it
		await pause(5);
		assert.strictEqual(await sse.read_frame(), 'after');
		controller.close();
		assert.isTrue(await sse.wait_for_close(500));
	});

	test('concurrent read_frame and wait_for_close consume a chunk once', async () => {
		const { stream, controller } = create_fed_stream();
		const sse = create_sse_frame_reader(stream.getReader(), 100);
		// both pumps await the one read in flight
		const frame = sse.read_frame();
		const waited = sse.wait_for_close(60);
		controller.enqueue(encode('a\n\n'));
		assert.strictEqual(await frame, 'a');
		assert.isFalse(await waited);
		controller.enqueue(encode('c\n\n'));
		// a duplicated `a` would come back here
		assert.strictEqual(await sse.read_frame(), 'c');
		await sse.cancel();
	});

	test('a pending read that errors after its timeout raises no unhandled rejection', async () => {
		const unhandled: Array<unknown> = [];
		const on_unhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on('unhandledRejection', on_unhandled);
		try {
			const { stream, controller } = create_fed_stream();
			const sse = create_sse_frame_reader(stream.getReader(), 20);
			assert.isFalse(await sse.wait_for_close(20));
			controller.error(new Error('stream broke'));
			// let the rejection settle and any unhandled-rejection event fire
			await pause(20);
			assert.deepEqual(unhandled, []);
		} finally {
			process.off('unhandledRejection', on_unhandled);
		}
	});

	test('cancel cancels the stream, releases the lock, and is idempotent', async () => {
		const { stream, cancelled } = create_fed_stream();
		const sse = create_sse_frame_reader(stream.getReader(), 20);
		// with a read in flight, as after a timed-out wait
		assert.isFalse(await sse.wait_for_close(20));
		await sse.cancel();
		assert.isTrue(cancelled());
		assert.isFalse(stream.locked);
		await sse.cancel();
		assert.isFalse(stream.locked);
	});
});
