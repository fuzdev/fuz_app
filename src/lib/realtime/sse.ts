/**
 * SSE (Server-Sent Events) streaming utilities for Hono.
 *
 * Provides generic helpers for creating SSE response streams
 * and a notification type aligned with JSON-RPC 2.0.
 *
 * @module
 */

import type {Context} from 'hono';
import {streamSSE} from 'hono/streaming';
import {z} from 'zod';
import {DEV} from 'esm-env';
import type {Logger} from '@fuzdev/fuz_util/log.js';

/**
 * Generic SSE stream controller interface.
 *
 * Transport-agnostic — works with any serializable type.
 */
export interface SseStream<T = unknown> {
	/** Send data to the client as a JSON SSE event. */
	send: (data: T) => void;
	/** Send a comment (for keep-alive pings). */
	comment: (text: string) => void;
	/** Close the stream. */
	close: () => void;
	/** Register a listener called when the stream closes (client disconnect or explicit close). */
	on_close: (fn: () => void) => void;
}

/**
 * Notification shape aligned with JSON-RPC 2.0.
 *
 * Uses `{method, params}` to match the JSON-RPC notification format.
 */
export interface SseNotification {
	/** Notification method name (e.g. 'run_created', 'host_updated'). */
	method: string;
	/** Method-specific payload. */
	params: unknown;
}

/**
 * Create an SSE response for a Hono context.
 *
 * Wraps Hono's `streamSSE` to provide a `{response, stream}` API
 * compatible with `SubscriberRegistry` push-based broadcasting.
 * The callback suspends via a promise that resolves on client disconnect
 * or explicit `close()`, keeping the stream alive for external sends.
 *
 * Uses `hono_stream.write()` directly (not `writeSSE`) to avoid
 * Hono's HTML callback resolution — keeps the same `data: JSON\n\n` format.
 *
 * @param c - Hono context
 * @returns object with response and stream controller
 */
export const create_sse_response = <T = unknown>(
	c: Context,
	log: Logger,
): {response: Response; stream: SseStream<T>} => {
	const {promise, resolve} = Promise.withResolvers<void>();
	const close_listeners: Array<() => void> = [];
	let resolved = false;

	const do_close = (): void => {
		if (resolved) return;
		resolved = true;
		resolve();
		for (const fn of close_listeners) {
			try {
				fn();
			} catch (e) {
				log.error('on_close listener threw:', e);
			}
		}
	};

	let sse_stream!: SseStream<T>;

	const response = streamSSE(c, async (hono_stream) => {
		sse_stream = {
			send(data: T) {
				if (resolved || hono_stream.aborted) return;
				try {
					// JSON.stringify (no space arg) never produces literal newlines,
					// so single-line `data:` framing is safe per the SSE spec.
					void hono_stream.write(`data: ${JSON.stringify(data)}\n\n`);
				} catch (e) {
					log.error('send failed to serialize data:', e);
				}
			},
			comment(text: string) {
				if (resolved || hono_stream.aborted) return;
				void hono_stream.write(`: ${text}\n`);
			},
			close: do_close,
			on_close(fn: () => void) {
				close_listeners.push(fn);
			},
		};
		hono_stream.onAbort(do_close);
		// flush an SSE comment to push headers through proxies (Vite, nginx),
		// ensuring EventSource fires onopen without waiting for the first data event
		void hono_stream.write(SSE_CONNECTED_COMMENT);
		await promise;
	});

	return {response, stream: sse_stream};
};

/** SSE comment sent on connect to flush headers through proxies. Exported for test assertions. */
export const SSE_CONNECTED_COMMENT = `: connected\n\n`;

/** Spec for an SSE event — declares params schema, description, and channel. */
export interface SseEventSpec {
	method: string;
	params: z.ZodType;
	description: string;
	channel?: string;
}

/**
 * Create a broadcaster that validates events in DEV mode.
 *
 * In DEV: warns on unknown methods and invalid params.
 * In production: passes through with zero overhead.
 *
 * @param broadcaster - duck-typed broadcaster (e.g. `SubscriberRegistry`)
 * @param event_specs - event specs to validate against
 * @returns validated broadcaster wrapper (passthrough in production)
 */
export const create_validated_broadcaster = <T extends SseNotification>(
	broadcaster: {broadcast: (channel: string, data: T) => void},
	event_specs: Array<SseEventSpec>,
	log: Logger,
): {broadcast: (channel: string, data: T) => void} => {
	if (!DEV) {
		return broadcaster;
	}
	const spec_map = new Map(event_specs.map((s) => [s.method, s]));
	return {
		broadcast: (channel: string, data: T) => {
			const spec = spec_map.get(data.method);
			if (!spec) {
				log.warn(`Unknown event method: '${data.method}'`);
			} else {
				const result = spec.params.safeParse(data.params);
				if (!result.success) {
					log.warn(`Params mismatch for '${data.method}':`, result.error.issues);
				}
			}
			broadcaster.broadcast(channel, data);
		},
	};
};
