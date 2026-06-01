import '../assert_dev_env.js';

/**
 * Cross-process Server-Sent Events transport.
 *
 * Opens a real streaming `fetch` against a spawned test binary's SSE
 * endpoint, threading the session cookie captured by the sibling
 * `FetchTransport` so the stream authenticates as the same account, then
 * delegates frame parsing to the shared `create_sse_frame_reader`. Uses only
 * built-in streaming `fetch` + `TextDecoder` — no extra dep.
 *
 * Mirrors how `testing/transports/ws_transport.ts` is the cross-process counterpart to the
 * in-process WS harness; the in-process SSE route suite
 * (`testing/sse_round_trip.ts`) shares the same `create_sse_frame_reader` over a
 * Hono `Response.body`.
 *
 * @module
 */

import {create_sse_frame_reader} from './sse_frame_reader.js';

/** Construction options for `create_sse_transport`. */
export interface SseTransportOptions {
	/** Base URL the binary is reachable at — e.g. `http://localhost:1178`. */
	readonly base_url: string;
	/** SSE endpoint path on the binary (e.g. `/api/admin/audit/stream`). */
	readonly sse_path: string;
	/**
	 * Session cookie values (full `Set-Cookie` strings as
	 * `FetchTransport.cookies()` returns them) threaded onto the request
	 * `Cookie` header. Without these the stream is anonymous and the
	 * connect is refused (the audit stream requires an admin session).
	 */
	readonly cookies: ReadonlyArray<string>;
	/**
	 * `Origin` header for the request. Backends running with
	 * `ALLOWED_ORIGINS=http://localhost:*` accept `http://localhost:<port>`.
	 * Defaults to `base_url` — acceptable because cross-process tests always
	 * run against `localhost`.
	 */
	readonly origin?: string;
	/** Default per-read / wait-for-close timeout. Falls back to 2000ms. */
	readonly default_timeout_ms?: number;
}

/** A cross-process SSE client: read frames, await server close, cancel. */
export interface SseTransport {
	/**
	 * Read one complete SSE frame (up to the next `\n\n`), without the
	 * trailing terminator. Throws if the per-read timeout elapses or the
	 * stream ends before a frame arrives.
	 */
	read_frame: (timeout_ms?: number) => Promise<string>;
	/**
	 * Drain until the server closes the stream. Resolves `true` if the
	 * stream closes within `timeout_ms`, `false` on timeout. The signal for
	 * an auth-guard revocation dropping a live stream — mirrors
	 * `WsClient.wait_for_close`.
	 */
	wait_for_close: (timeout_ms?: number) => Promise<boolean>;
	/** Cancel the reader (client-initiated close). Safe to call when already closed. */
	close: () => Promise<void>;
}

/**
 * Open a real-HTTP SSE stream pinned to `options.base_url` + `sse_path`.
 *
 * Resolves once the response headers arrive and the body is a
 * `text/event-stream`; rejects if the connect is refused (non-2xx status,
 * wrong content type, missing body) so the test surfaces the real cause
 * rather than hanging.
 *
 * @throws Error if the connect fails (status, content type, or no body).
 */
export const create_sse_transport = async (options: SseTransportOptions): Promise<SseTransport> => {
	const {base_url, sse_path, cookies, origin, default_timeout_ms} = options;

	const url = `${base_url}${sse_path}`;
	const headers: Record<string, string> = {
		Accept: 'text/event-stream',
		Origin: origin ?? base_url,
	};
	if (cookies.length > 0) headers.Cookie = cookies.join('; ');

	const res = await fetch(url, {method: 'GET', headers});
	if (!res.ok) {
		throw new Error(`SSE connect to ${url} failed: status ${res.status}`);
	}
	const content_type = res.headers.get('Content-Type');
	if (!content_type?.includes('text/event-stream')) {
		throw new Error(`SSE connect to ${url}: unexpected Content-Type ${content_type}`);
	}
	if (!res.body) {
		throw new Error(`SSE connect to ${url}: response has no body`);
	}

	const {read_frame, wait_for_close, cancel} = create_sse_frame_reader(
		res.body.getReader(),
		default_timeout_ms,
	);
	return {read_frame, wait_for_close, close: cancel};
};
