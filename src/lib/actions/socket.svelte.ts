/**
 * Frontend WebSocket client — portable, Svelte-reactive, implements `WebsocketConnection`.
 *
 * Plain class with `$state` runes (no Cell inheritance, no app coupling).
 * Drop into any SvelteKit frontend as the underlying connection for
 * `FrontendWebsocketTransport`. Handles auto-reconnect with exponential
 * backoff, respects `WS_CLOSE_SESSION_REVOKED` (no reconnect loop after the
 * server revokes auth), and exposes reactive status for UI indicators.
 *
 * First cut: no message queue, no heartbeat. Those live in consumer-specific
 * wrappers today (see zzz's `Socket` Cell); extract into fuz_app when two
 * independent consumers motivate the shape.
 *
 * @module
 */

import {BROWSER} from 'esm-env';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import {WS_CLOSE_SESSION_REVOKED} from './transports.js';
import type {WebsocketConnection} from './transports_ws.js';

/** Default WebSocket close code (normal closure). */
export const DEFAULT_CLOSE_CODE = 1000;
/** Base reconnect delay in ms. */
export const DEFAULT_RECONNECT_DELAY = 1000;
/** Max reconnect delay in ms (cap on exponential backoff). */
export const DEFAULT_RECONNECT_DELAY_MAX = 10000;
/** Exponential backoff factor: delay = base * factor^(attempt-1). */
export const DEFAULT_BACKOFF_FACTOR = 1.5;

/**
 * Client-side WebSocket status.
 *
 * - `initial` — never connected; `connect()` has not been called.
 * - `connecting` — WebSocket `readyState === CONNECTING`.
 * - `connected` — WebSocket `readyState === OPEN`.
 * - `reconnecting` — close fired; waiting out backoff before next attempt.
 * - `closed` — permanently closed (explicit `disconnect()` or session revoked).
 */
export type SocketStatus = 'initial' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export type SocketMessageHandler = (event: MessageEvent) => void;
export type SocketErrorHandler = (event: Event) => void;

export interface FrontendWebsocketClientOptions {
	/** Auto-reconnect on abnormal close. Defaults to `true`. */
	auto_reconnect?: boolean;
	/** Base reconnect delay in ms. Defaults to 1000. */
	reconnect_delay?: number;
	/** Max reconnect delay in ms (cap on exponential backoff). Defaults to 10000. */
	reconnect_delay_max?: number;
	/** Exponential backoff factor. Defaults to 1.5. */
	backoff_factor?: number;
	/** Optional logger for diagnostic messages. */
	log?: Logger | null;
}

/**
 * Reactive WebSocket client implementing `WebsocketConnection`.
 *
 * Construct with a URL and optional config; call `connect()` to open the
 * socket and begin auto-reconnect. Register message/error handlers via
 * `add_message_handler` / `add_error_handler` — both return unsubscribe
 * functions. `FrontendWebsocketTransport` consumes this as its connection.
 *
 * Session-revocation close codes (`WS_CLOSE_SESSION_REVOKED`) put the client
 * in a permanently-closed state; reconnecting would just loop on 401.
 */
export class FrontendWebsocketClient implements WebsocketConnection {
	readonly #url: string;
	readonly #auto_reconnect: boolean;
	readonly #reconnect_delay: number;
	readonly #reconnect_delay_max: number;
	readonly #backoff_factor: number;
	readonly #log: Logger | null;

	ws: WebSocket | null = $state.raw(null);
	status: SocketStatus = $state.raw('initial');

	reconnect_count: number = $state.raw(0);
	current_reconnect_delay: number = $state.raw(0);
	last_connect_time: number | null = $state.raw(null);

	#reconnect_timeout: ReturnType<typeof setTimeout> | null = null;
	#revoked: boolean = false;

	#message_handlers: Set<SocketMessageHandler> = new Set();
	#error_handlers: Set<SocketErrorHandler> = new Set();

	readonly connected: boolean = $derived(this.status === 'connected');

	constructor(url: string, options: FrontendWebsocketClientOptions = {}) {
		this.#url = url;
		this.#auto_reconnect = options.auto_reconnect ?? true;
		this.#reconnect_delay = options.reconnect_delay ?? DEFAULT_RECONNECT_DELAY;
		this.#reconnect_delay_max = options.reconnect_delay_max ?? DEFAULT_RECONNECT_DELAY_MAX;
		this.#backoff_factor = options.backoff_factor ?? DEFAULT_BACKOFF_FACTOR;
		this.#log = options.log ?? null;
	}

	get url(): string {
		return this.#url;
	}

	/**
	 * Open the WebSocket. No-op on SSR, or if the session has been revoked.
	 * Tears down any existing connection first; safe to call to force reconnect.
	 */
	connect(): void {
		if (!BROWSER) return;
		if (this.#revoked) return;

		this.#teardown();

		try {
			this.status = 'connecting';
			const ws = new WebSocket(this.#url);
			this.ws = ws;

			ws.addEventListener('open', this.#handle_open);
			ws.addEventListener('close', this.#handle_close);
			ws.addEventListener('error', this.#handle_error);
			ws.addEventListener('message', this.#handle_message);
		} catch (error) {
			this.#log?.error('[socket] failed to create WebSocket:', error);
			this.ws = null;
			this.status = 'closed';
			this.#schedule_reconnect();
		}
	}

	/**
	 * Close the WebSocket and cancel any pending reconnect. Puts the client
	 * in `closed` status; call `connect()` to reopen.
	 */
	disconnect(code: number = DEFAULT_CLOSE_CODE): void {
		this.#cancel_reconnect();
		this.#teardown(code);
		this.status = 'closed';
	}

	send(data: object): boolean {
		if (!this.connected || !this.ws) return false;
		try {
			this.ws.send(JSON.stringify(data));
			return true;
		} catch (error) {
			this.#log?.error('[socket] send failed:', error);
			return false;
		}
	}

	add_message_handler(handler: SocketMessageHandler): () => void {
		this.#message_handlers.add(handler);
		return () => this.#message_handlers.delete(handler);
	}

	add_error_handler(handler: SocketErrorHandler): () => void {
		this.#error_handlers.add(handler);
		return () => this.#error_handlers.delete(handler);
	}

	#teardown(close_code?: number): void {
		if (!this.ws) return;
		this.ws.removeEventListener('open', this.#handle_open);
		this.ws.removeEventListener('close', this.#handle_close);
		this.ws.removeEventListener('error', this.#handle_error);
		this.ws.removeEventListener('message', this.#handle_message);

		if (
			close_code !== undefined &&
			(this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
		) {
			try {
				this.ws.close(close_code);
			} catch (error) {
				this.#log?.error('[socket] close failed:', error);
			}
		}
		this.ws = null;
	}

	#schedule_reconnect(): void {
		if (!this.#auto_reconnect || this.#revoked) return;

		this.#cancel_reconnect();

		this.reconnect_count++;
		this.current_reconnect_delay = Math.round(
			Math.min(
				this.#reconnect_delay_max,
				this.#reconnect_delay * this.#backoff_factor ** (this.reconnect_count - 1),
			),
		);
		this.status = 'reconnecting';

		this.#reconnect_timeout = setTimeout(() => {
			this.#reconnect_timeout = null;
			this.connect();
		}, this.current_reconnect_delay);
	}

	#cancel_reconnect(): void {
		if (this.#reconnect_timeout !== null) {
			clearTimeout(this.#reconnect_timeout);
			this.#reconnect_timeout = null;
		}
	}

	#handle_open = (_event: Event): void => {
		this.status = 'connected';
		this.reconnect_count = 0;
		this.current_reconnect_delay = 0;
		this.last_connect_time = Date.now();
		this.#cancel_reconnect();
	};

	#handle_close = (event: CloseEvent): void => {
		// Session revocation is terminal — reconnecting would 401 in a loop.
		if (event.code === WS_CLOSE_SESSION_REVOKED) {
			this.#revoked = true;
			this.status = 'closed';
			this.#cancel_reconnect();
			return;
		}
		this.status = 'closed';
		this.#schedule_reconnect();
	};

	#handle_error = (event: Event): void => {
		this.#log?.error('[socket] websocket error:', event);
		for (const handler of this.#error_handlers) {
			handler(event);
		}
		// Browsers fire `close` after error; reconnect logic lives there.
	};

	#handle_message = (event: MessageEvent): void => {
		for (const handler of this.#message_handlers) {
			handler(event);
		}
	};
}
