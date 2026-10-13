/**
 * SSE (Server-Sent Events) streaming utilities for Hono.
 *
 * Provides generic helpers for creating SSE response streams
 * and a notification type aligned with JSON-RPC 2.0.
 *
 * ## Outbound bound
 *
 * `SseStream.send` never waits on its client: each frame is written to the
 * response stream, which holds it until the client reads. What a stream holds
 * unread is kept within `SSE_OUTBOUND_QUEUE_BYTES` — each frame charged its
 * bytes as written (`data: ` prefix and terminator included) plus
 * `OUTBOUND_FRAME_OVERHEAD_BYTES`, and a frame always accepted when nothing is
 * unread, so a single frame larger than the budget is still deliverable. A
 * frame that does not fit **ends the stream**: it is not written, what was
 * unread is dropped, the body ends with no final frame, and the stream's
 * `on_close` listeners run. One `warn` line names the stream's account (when
 * the caller passed it) and what was unread; no audit row is written, since each would itself be fanned to every
 * stream. A client that is reading reconnects and misses the frames in
 * between. The twin of the Rust spine's `fuz_realtime` SSE bound — the same
 * budget and charge.
 *
 * @module
 */

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { DEV } from 'esm-env';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { utf8_length } from '../actions/transports.ts';
import { OutboundBudget } from './outbound_budget.ts';
import { SSE_CONNECTED_COMMENT, SSE_OUTBOUND_QUEUE_BYTES } from './sse_constants.ts';

/**
 * Generic SSE stream controller interface.
 *
 * Transport-agnostic — works with any serializable type.
 */
export interface SseStream<T = unknown> {
	/**
	 * Send data to the client as a JSON SSE event. Never waits: a frame the
	 * stream's outbound budget does not fit ends the stream instead (module doc,
	 * "Outbound bound").
	 */
	send: (data: T) => void;
	/** Send a comment (for keep-alive pings). */
	comment: (text: string) => void;
	/** Close the stream. */
	close: () => void;
	/**
	 * Register a listener called when the stream closes (client disconnect or
	 * explicit close). Called at once when the stream has already closed — a
	 * client can leave before the caller registers — so a cleanup registered
	 * through it always runs.
	 */
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

/** Options for `create_sse_response`. */
export interface SseResponseOptions {
	/**
	 * The account the stream belongs to, named in the warning logged when the
	 * stream ends on its outbound budget.
	 */
	account_id?: string | null;
}

/**
 * The part of a Node stream read here: whether it is destroyed, and its `close`
 * event.
 */
interface NodeConnectionStream {
	readonly destroyed: boolean;
	once: (event: 'close', listener: () => void) => unknown;
}

const is_node_connection_stream = (value: unknown): value is NodeConnectionStream => {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<Record<keyof NodeConnectionStream, unknown>>;
	return typeof candidate.destroyed === 'boolean' && typeof candidate.once === 'function';
};

/**
 * The Node stream that ends with the client's connection, from the
 * `c.env.outgoing` that `@hono/node-server` passes a handler: over HTTP/1 the
 * `ServerResponse` itself, over HTTP/2 the `Http2ServerResponse`'s `stream` —
 * the response is no stream there and has no `destroyed`.
 */
const to_node_connection_stream = (env: unknown): NodeConnectionStream | null => {
	if (typeof env !== 'object' || env === null) return null;
	const outgoing = (env as { outgoing?: unknown }).outgoing;
	if (typeof outgoing !== 'object' || outgoing === null) return null;
	if (is_node_connection_stream(outgoing)) return outgoing;
	const { stream } = outgoing as { stream?: unknown };
	return is_node_connection_stream(stream) ? stream : null;
};

/**
 * Call `on_gone` once the client of `c` has disconnected — at once if it
 * already has.
 *
 * A stream closes on its own only when the runtime cancels the response body,
 * and a runtime cancels only a body it has started to send. A client that
 * leaves before the handler returns — one awaiting a credential re-read, say —
 * is never sent the body, so nothing would close the stream.
 *
 * On `@hono/node-server` the request's `signal` cannot be trusted for this:
 * the adapter creates it on first read and aborts it only if it existed when
 * the connection closed, so a handler that reads it after an `await` can hold
 * a signal that never fires. The Node stream behind the response says whether
 * the connection is gone and emits `close` when it goes, so that is what is
 * watched there — the response object (`c.env.outgoing`) over HTTP/1, its
 * `Http2Stream` over HTTP/2. Elsewhere the request's `signal` is the
 * disconnect — the Fetch-standard runtimes abort it when the client leaves.
 */
const watch_client_disconnect = (c: Context, on_gone: () => void): void => {
	const connection = to_node_connection_stream(c.env);
	if (connection) {
		if (connection.destroyed) on_gone();
		else connection.once('close', on_gone);
		return;
	}
	const { signal } = c.req.raw;
	if (signal.aborted) on_gone();
	else signal.addEventListener('abort', on_gone, { once: true });
};

/**
 * Create an SSE response for a Hono context.
 *
 * Wraps Hono's `streamSSE` to provide a `{response, stream}` API
 * compatible with `SubscriberRegistry` push-based broadcasting.
 * The callback suspends via a promise that resolves on client disconnect
 * or explicit `close()`, keeping the stream alive for external sends.
 *
 * The stream closes when its client disconnects, whenever that happens — also
 * before the handler returns the response, which no runtime reports by
 * cancelling the body. A client already gone when this is called yields a
 * stream that is already closed, so register cleanup with `on_close` (which
 * runs a late listener at once) before handing the stream anywhere that would
 * count it — `SubscriberRegistry.admit` after `on_close(pending.unsubscribe)`
 * refuses it.
 *
 * Uses `hono_stream.write()` directly (not `writeSSE`) to avoid
 * Hono's HTML callback resolution — keeps the same `data: JSON\n\n` format.
 *
 * What the stream holds unread is bounded by `SSE_OUTBOUND_QUEUE_BYTES`; a
 * frame past it ends the stream (module doc, "Outbound bound").
 *
 * @param log - logger for serialization and `on_close` listener errors, and
 *   for the warning when the stream ends on its outbound budget
 * @param options - what the overflow warning names
 * @returns object with the streaming `Response` and an `SseStream` controller
 */
export const create_sse_response = <T = unknown>(
	c: Context,
	log: Logger,
	options?: SseResponseOptions
): { response: Response; stream: SseStream<T> } => {
	const { promise, resolve } = Promise.withResolvers<void>();
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

	// charges the frames written to the stream and not yet read from it
	const budget = new OutboundBudget(SSE_OUTBOUND_QUEUE_BYTES);

	const response = streamSSE(c, async (hono_stream) => {
		// Write one frame within the budget, or end the stream. The write
		// settles once the response body has taken the frame, which frees its
		// charge.
		const write = (frame: string): void => {
			const bytes = utf8_length(frame);
			if (!budget.admit(bytes)) {
				// same line as the Rust spine's registry, so one grep finds either
				log.warn('sse: outbound queue overflow, ending the stream', {
					account_id: options?.account_id ?? null,
					...budget.to_overflow(bytes)
				});
				budget.clear();
				// drops what the stream still holds and ends the body; `do_close`
				// runs as its abort listener
				hono_stream.abort();
				do_close();
				return;
			}
			void hono_stream.write(frame).then(() => {
				// a stream that ended has had its charges cleared
				if (!resolved && !hono_stream.aborted) budget.release(bytes);
			});
		};
		sse_stream = {
			send(data: T) {
				if (resolved || hono_stream.aborted) return;
				let frame: string;
				try {
					// JSON.stringify (no space arg) never produces literal newlines,
					// so single-line `data:` framing is safe per the SSE spec.
					frame = `data: ${JSON.stringify(data)}\n\n`;
				} catch (e) {
					log.error('send failed to serialize data:', e);
					return;
				}
				write(frame);
			},
			comment(text: string) {
				if (resolved || hono_stream.aborted) return;
				write(`: ${text}\n`);
			},
			close: do_close,
			on_close(fn: () => void) {
				if (!resolved) {
					close_listeners.push(fn);
					return;
				}
				try {
					fn();
				} catch (e) {
					log.error('on_close listener threw:', e);
				}
			}
		};
		hono_stream.onAbort(do_close);
		// flush an SSE comment to push headers through proxies (Vite, nginx),
		// ensuring EventSource fires onopen without waiting for the first data event
		write(SSE_CONNECTED_COMMENT);
		await promise;
	});
	// after the callback above has built `sse_stream`, which runs synchronously
	// up to its first `await`
	watch_client_disconnect(c, do_close);

	return { response, stream: sse_stream };
};

/** Spec for a push event — declares params schema, description, and channel. */
export interface EventSpec {
	/** Event method name, used as the JSON-RPC notification `method`. */
	method: string;
	/** Zod schema for the notification `params` payload. */
	params: z.ZodType;
	/** Human-readable description for surface output and docs. */
	description: string;
	/** Channel this event broadcasts on. Omit for cross-channel events. */
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
 * @param log - logger used to emit DEV warnings on unknown methods or param mismatches
 * @returns validated broadcaster wrapper (passthrough in production)
 */
export const create_validated_broadcaster = <T extends SseNotification>(
	broadcaster: { broadcast: (channel: string, data: T) => void },
	event_specs: Array<EventSpec>,
	log: Logger
): { broadcast: (channel: string, data: T) => void } => {
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
		}
	};
};
