/**
 * Shared SSE test doubles for fuz_app's own suites.
 *
 * @module
 */

import type { Context } from 'hono';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_sse_stream, type SseResponseOptions, type SseStream } from '#lib/realtime/sse.ts';
import { SSE_RESPONSE_HEADERS } from '#lib/realtime/sse_constants.ts';

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

/**
 * Open a real SSE stream on `c` (`create_sse_stream`) and answer it at once
 * through the context with `SSE_RESPONSE_HEADERS`, as `apply_route_specs`
 * answers a route's `route_sse` result — so the stream's own behavior is
 * pinned with no route around it.
 */
export const open_sse_response = <T = unknown>(
	c: Context,
	log: Logger,
	options?: SseResponseOptions
): { response: Response; stream: SseStream<T> } => {
	const { stream, body } = create_sse_stream<T>(c, log, options);
	return { response: c.body(body, 200, SSE_RESPONSE_HEADERS), stream };
};
