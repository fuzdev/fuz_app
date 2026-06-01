import '../assert_dev_env.js';

/**
 * Cross-process WebSocket transport.
 *
 * Implements the shared `WsClient` interface (see `testing/transports/ws_client.ts`) over a
 * real `WebSocket` upgrade against a spawned test binary. The cookie
 * captured by the sibling `FetchTransport` on bootstrap is threaded onto
 * the upgrade request so the WS session authenticates as the same
 * account.
 *
 * Uses the `ws` npm package — Node's native `WebSocket` (from undici)
 * follows the WHATWG spec strictly and doesn't accept custom request
 * headers on construction, so cookie-on-upgrade requires the `ws`
 * package's `headers` option. fuz_app declares `ws` as an optional
 * peerDependency — consumers wiring cross-process tests install it
 * themselves (`npm install --save-dev ws`).
 *
 * @module
 */

import {WebSocket, type RawData} from 'ws';

import {
	WS_CLIENT_DEFAULT_TIMEOUT_MS,
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type JsonrpcSuccessResponseFrame,
	type WsClient,
} from './ws_client.js';
import {create_jsonrpc_request} from '../../http/jsonrpc_helpers.js';

/** Construction options for `create_ws_transport`. */
export interface WsTransportOptions {
	/** Base URL the binary is reachable at — e.g. `http://localhost:8788`. Converted to `ws://` for the upgrade. */
	readonly base_url: string;
	/** WebSocket endpoint path on the binary (e.g. `/api/ws`). */
	readonly ws_path: string;
	/**
	 * Session cookie values (full `Set-Cookie` strings as
	 * `FetchTransport.cookies()` returns them) threaded onto the upgrade
	 * `Cookie` header. Without these the upgrade is anonymous and
	 * per-action auth fails on the first message.
	 */
	readonly cookies: ReadonlyArray<string>;
	/**
	 * Origin header for the upgrade. Backends running with
	 * `ALLOWED_ORIGINS=http://localhost:*` accept `http://localhost:<port>`.
	 * Defaults to `base_url` — acceptable because cross-process tests
	 * always run against `localhost`.
	 */
	readonly origin?: string;
	/**
	 * Optional per-call default for `wait_for` timeouts. Falls back to
	 * `WS_CLIENT_DEFAULT_TIMEOUT_MS` if omitted.
	 */
	readonly default_timeout_ms?: number;
}

/**
 * Build a real-upgrade WS client pinned to `options.base_url` + `ws_path`.
 *
 * Resolves once the upgrade succeeds and the socket is in `OPEN` state;
 * rejects if the upgrade is refused (401, allowlist rejection, network
 * failure). Incoming messages are JSON-parsed and pushed onto the
 * `messages` array; `wait_for` checks already-received messages first
 * before waiting for new arrivals.
 *
 * @throws Error if the upgrade fails (status, network) — the rejection
 *   message carries the underlying error so the test surfaces the real
 *   cause rather than hanging.
 */
export const create_ws_transport = async (options: WsTransportOptions): Promise<WsClient> => {
	const {base_url, ws_path, cookies, origin, default_timeout_ms} = options;
	const default_timeout = default_timeout_ms ?? WS_CLIENT_DEFAULT_TIMEOUT_MS;

	const ws_url = `${base_url.replace(/^http/i, 'ws')}${ws_path}`;
	const headers: Record<string, string> = {};
	if (cookies.length > 0) headers.Cookie = cookies.join('; ');

	const socket = new WebSocket(ws_url, {
		headers,
		origin: origin ?? base_url,
	});

	const received: Array<unknown> = [];
	const waiters: Array<{
		predicate: (msg: unknown) => boolean;
		resolve: (msg: unknown) => void;
	}> = [];
	let close_resolvers: Array<() => void> = [];
	let close_error: Error | null = null;

	socket.on('message', (data: RawData) => {
		// `ws` may deliver Buffer / ArrayBuffer / Buffer[]; normalize to string.
		const text = Array.isArray(data)
			? Buffer.concat(data).toString('utf-8')
			: data instanceof ArrayBuffer
				? Buffer.from(data).toString('utf-8')
				: data.toString('utf-8');
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			// Non-JSON frame — store the raw string so tests that inspect
			// it still see the payload.
			parsed = text;
		}
		received.push(parsed);
		for (let i = waiters.length - 1; i >= 0; i--) {
			const waiter = waiters[i]!;
			if (waiter.predicate(parsed)) {
				waiter.resolve(parsed);
				waiters.splice(i, 1);
			}
		}
	});

	socket.on('close', () => {
		for (const resolve of close_resolvers) resolve();
		close_resolvers = [];
	});

	// Wait for the upgrade to complete (or fail) before resolving the
	// factory promise. Suite bodies expect a connected client back.
	await new Promise<void>((resolve, reject) => {
		const on_open = (): void => {
			socket.on('error', (err) => {
				// Post-open errors stash for diagnostics; close handler
				// resolves the close() awaiters whether or not error fired.
				close_error = err;
			});
			resolve();
		};
		const on_error = (err: Error): void => {
			reject(new Error(`ws upgrade to ${ws_url} failed: ${err.message}`));
		};
		socket.once('open', on_open);
		socket.once('error', on_error);
	});

	const is_closed = (): boolean =>
		socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED;

	const wait_for_close = (timeout_ms = default_timeout): Promise<boolean> => {
		if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const on_close = (): void => {
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(() => {
				const i = close_resolvers.indexOf(on_close);
				if (i >= 0) close_resolvers.splice(i, 1);
				resolve(false);
			}, timeout_ms);
			close_resolvers.push(on_close);
		});
	};

	const wait_for_impl = <T>(
		predicate: (msg: unknown) => boolean,
		timeout_ms = default_timeout,
	): Promise<T> => {
		for (const msg of received) {
			if (predicate(msg)) return Promise.resolve(msg as T);
		}
		return new Promise<T>((resolve, reject) => {
			const waiter = {
				predicate,
				resolve: (msg: unknown) => {
					clearTimeout(timer);
					resolve(msg as T);
				},
			};
			const timer = setTimeout(() => {
				const i = waiters.indexOf(waiter);
				if (i >= 0) waiters.splice(i, 1);
				reject(new Error(`wait_for timed out after ${timeout_ms}ms`));
			}, timeout_ms);
			waiters.push(waiter);
		});
	};

	const send_impl = async (message: unknown): Promise<void> => {
		if (is_closed() || socket.readyState !== WebSocket.OPEN) throw new Error('send after close');
		socket.send(JSON.stringify(message));
	};

	return {
		get messages() {
			return received;
		},
		send: send_impl,
		async request<R = unknown>(
			id: number | string,
			method: string,
			params: unknown,
			timeout_ms?: number,
		): Promise<R> {
			await send_impl(create_jsonrpc_request(method, params as never, id));
			const msg = await wait_for_impl<JsonrpcSuccessResponseFrame<R> | JsonrpcErrorResponseFrame>(
				is_response_for(id),
				timeout_ms,
			);
			if ('error' in msg) {
				const detail =
					msg.error.data === undefined ? '' : ` data=${JSON.stringify(msg.error.data)}`;
				throw new Error(`rpc #${id} failed: [${msg.error.code}] ${msg.error.message}${detail}`);
			}
			return msg.result;
		},
		async close(code, reason) {
			if (!is_closed()) socket.close(code, reason);
			if (socket.readyState !== WebSocket.CLOSED) {
				await new Promise<void>((resolve) => close_resolvers.push(resolve));
			}
			if (close_error) throw close_error;
		},
		wait_for: wait_for_impl,
		wait_for_close,
	};
};
