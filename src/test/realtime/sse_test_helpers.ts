/**
 * Shared SSE test doubles for fuz_app's own suites.
 *
 * @module
 */

import type { SseStream } from '#lib/realtime/sse.ts';

/** A mock `SseStream` that records what was sent and whether it was closed. */
export type MockSseStream<T = unknown> = SseStream<T> & {
	readonly sent: Array<T>;
	readonly closed: boolean;
};

/**
 * Create a mock `SseStream`: `send` records into `sent`, `close` sets
 * `closed`, and `on_close` registers nothing.
 */
export const create_mock_stream = <T = unknown>(): MockSseStream<T> => {
	const sent: Array<T> = [];
	let closed = false;
	return {
		sent,
		get closed() {
			return closed;
		},
		send(data: T) {
			sent.push(data);
		},
		close() {
			closed = true;
		},
		on_close() {}
	};
};
