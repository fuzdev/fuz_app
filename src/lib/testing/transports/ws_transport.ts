import '../assert_dev_env.ts';

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

import type { ClientRequest, IncomingMessage } from 'node:http';
import { WebSocket, type RawData } from 'ws';

import {
	create_ws_waiters,
	deliver_inbound,
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type JsonrpcSuccessResponseFrame,
	type WsClient,
	type WsRequestResponder
} from './ws_client.ts';
import { create_jsonrpc_request } from '../../http/jsonrpc_helpers.ts';
import { heartbeat_action_spec } from '../../actions/heartbeat.ts';

/**
 * A cross-process `WsClient` with one addition: `send_text` writes a frame
 * verbatim, for the cases a JSON-serializing `send` cannot express (a frame
 * that is not JSON at all).
 */
export interface WsTransportClient extends WsClient {
	/**
	 * Send `text` as one text frame, unserialized.
	 *
	 * @throws Error if called after the socket closed
	 */
	send_text: (text: string) => Promise<void>;
}

/**
 * How long a refused upgrade's body may take to arrive before the transport
 * closes the connection and rejects with what came — a refusal whose body
 * never ends would otherwise leave the open pending forever.
 */
export const WS_REFUSAL_BODY_TIMEOUT_MS = 1000;

/**
 * A WebSocket upgrade the server answered with an HTTP response instead of
 * `101` — the refusal's status and body, so a test can tell an origin refusal
 * (403) from a missing credential (401) instead of accepting any failure.
 */
export class WsUpgradeRefusedError extends Error {
	/** The refusal's HTTP status. */
	readonly status: number;
	/** The refusal's body as text (empty when it had none). */
	readonly body: string;

	constructor(url: string, status: number, body: string) {
		super(`ws upgrade to ${url} refused: Unexpected server response: ${status}`);
		this.name = 'WsUpgradeRefusedError';
		this.status = status;
		this.body = body;
	}
}

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
	 * always run against `localhost`. `null` sends no `Origin` at all, which a
	 * daemon-token upgrade needs: both spines discard a daemon token (and a
	 * bearer token) presented in a browser context.
	 */
	readonly origin?: string | null;
	/**
	 * Optional per-call default for `wait_for` timeouts. Falls back to
	 * `WS_CLIENT_DEFAULT_TIMEOUT_MS` if omitted.
	 */
	readonly default_timeout_ms?: number;
	/**
	 * Optional responder for **server-initiated** requests (the
	 * server→client direction ActionPeer adds). Attached before the
	 * upgrade so a connect-time or on-demand `peer/ping` is answered as
	 * soon as it arrives. Omit for the default observe-only client — a
	 * server-initiated request is then surfaced as a normal message (today's
	 * behavior).
	 */
	readonly on_request?: WsRequestResponder;
	/**
	 * Extra headers for the upgrade request — e.g. an `X-Forwarded-For` that a
	 * backend trusting the loopback proxy resolves as the connection's client
	 * IP, which keys the per-IP action rate limiter for every message on the
	 * socket. `cookies` and `origin` set their own headers.
	 */
	readonly headers?: Readonly<Record<string, string>>;
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
 * An open socket is not yet an **admitted** connection: both spines answer
 * the handshake first and admit the connection a credential re-check later,
 * and deliver no server-initiated message to it until then. Requests sent
 * meanwhile are queued and answered, so a suite that only round-trips can
 * use this directly; one that waits for a push (a broadcast, a targeted
 * notification) opens with `create_admitted_ws_transport` instead.
 *
 * @throws WsUpgradeRefusedError if the server answers the upgrade with an
 *   HTTP response, carrying its status and body
 * @throws Error if the upgrade fails otherwise (network) — the rejection
 *   message carries the underlying error so the test surfaces the real
 *   cause rather than hanging.
 */
export const create_ws_transport = async (
	options: WsTransportOptions
): Promise<WsTransportClient> => {
	const { base_url, ws_path, cookies, origin, default_timeout_ms, on_request } = options;

	const ws_url = `${base_url.replace(/^http/i, 'ws')}${ws_path}`;
	const headers: Record<string, string> = { ...options.headers };
	if (cookies.length > 0) headers.Cookie = cookies.join('; ');

	const socket = new WebSocket(ws_url, {
		headers,
		// `ws` sends no `Origin` header when the option is undefined
		origin: origin === null ? undefined : (origin ?? base_url)
	});

	const { received, waiters, wait_for, wait_for_close, next_close, resolve_close } =
		create_ws_waiters(() => socket.readyState === WebSocket.CLOSED, default_timeout_ms);
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
		deliver_inbound(parsed, received, waiters, on_request, (message) => {
			if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
		});
	});

	let close_code: number | null = null;
	let close_reason: string | null = null;
	socket.on('close', (code: number, reason: Buffer) => {
		close_code = code;
		close_reason = reason.toString('utf-8');
		resolve_close();
	});

	// Wait for the upgrade to complete (or fail) before resolving the
	// factory promise. Suite bodies expect a connected client back.
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const on_open = (): void => {
			settled = true;
			socket.on('error', (err) => {
				// Post-open errors stash for diagnostics; close handler
				// resolves the close() awaiters whether or not error fired.
				close_error = err;
			});
			resolve();
		};
		const on_error = (err: Error): void => {
			if (settled) return;
			settled = true;
			reject(new Error(`ws upgrade to ${ws_url} failed: ${err.message}`));
		};
		// A listener here takes the refused response over from `ws`, which would
		// otherwise abort with only the status in an error message; read the
		// body, then close the connection. The socket is captured on entry: a
		// finished response drops its `socket`, so `req.destroy()` alone would
		// leave the connection open. A body that never ends is cut off after
		// `WS_REFUSAL_BODY_TIMEOUT_MS`, rejecting with what arrived.
		const on_unexpected_response = (req: ClientRequest, res: IncomingMessage): void => {
			const tcp = res.socket;
			const chunks: Array<Buffer> = [];
			const finish = (): void => {
				clearTimeout(body_timer);
				req.destroy();
				tcp?.destroy();
				if (settled) return;
				settled = true;
				const body = Buffer.concat(chunks).toString('utf-8');
				reject(new WsUpgradeRefusedError(ws_url, res.statusCode ?? 0, body));
			};
			const body_timer = setTimeout(finish, WS_REFUSAL_BODY_TIMEOUT_MS);
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.once('end', finish);
			res.once('close', finish);
			res.once('error', finish);
		};
		socket.once('open', on_open);
		socket.on('error', on_error);
		socket.once('unexpected-response', on_unexpected_response);
	});

	const is_closed = (): boolean =>
		socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED;

	const send_text_impl = async (text: string): Promise<void> => {
		if (is_closed() || socket.readyState !== WebSocket.OPEN) throw new Error('send after close');
		socket.send(text);
	};
	const send_impl = (message: unknown): Promise<void> => send_text_impl(JSON.stringify(message));

	return {
		get messages() {
			return received;
		},
		get close_code() {
			return close_code;
		},
		get close_reason() {
			return close_reason;
		},
		send: send_impl,
		send_text: send_text_impl,
		async request<R = unknown>(
			id: number | string,
			method: string,
			params: unknown,
			timeout_ms?: number
		): Promise<R> {
			await send_impl(create_jsonrpc_request(method, params as never, id));
			const msg = await wait_for<JsonrpcSuccessResponseFrame<R> | JsonrpcErrorResponseFrame>(
				is_response_for(id),
				timeout_ms
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
				await next_close();
			}
			if (close_error) throw close_error;
		},
		wait_for,
		wait_for_close
	};
};

/** The request id `create_admitted_ws_transport` round-trips `heartbeat` under. */
export const WS_ADMISSION_PROBE_ID = 'admitted';

/**
 * Open a real-upgrade WS client and round-trip `heartbeat` on it, so the
 * backend has **admitted** the connection by the time this resolves.
 *
 * Both spines answer the upgrade handshake before the connection is
 * registered and admitted (the credential is re-read in between), and deliver
 * no broadcast or targeted notification to a connection still pending
 * admission. A request is answered only once the connection is admitted, so
 * the round trip is the one signal a client has. Suites that open a socket and
 * then wait for a server-initiated message, or that need connections
 * registered in a known order, open through this.
 *
 * `heartbeat` is a protocol action, present on every WS endpoint. Its response
 * frame (id `WS_ADMISSION_PROBE_ID`) stays in the client's `messages`.
 *
 * @throws Error if the upgrade fails, or the heartbeat is refused or times out
 *   — the socket is closed first
 */
export const create_admitted_ws_transport = async (
	options: WsTransportOptions
): Promise<WsTransportClient> => {
	const client = await create_ws_transport(options);
	try {
		await client.request(WS_ADMISSION_PROBE_ID, heartbeat_action_spec.method, {});
	} catch (error) {
		await client.close().catch(() => {});
		throw error;
	}
	return client;
};
