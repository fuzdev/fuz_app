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
 * - `closed` — socket is not open. Terminal only when `revoked` is `true`
 *   or auto-reconnect is disabled; otherwise `connect()` reopens.
 */
export type SocketStatus = 'initial' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export type SocketMessageHandler = (event: MessageEvent) => void;
export type SocketErrorHandler = (event: Event) => void;

export interface FrontendWebsocketReconnectOptions {
	/** Base reconnect delay in ms. Defaults to 1000. */
	delay?: number;
	/** Max reconnect delay in ms (cap on exponential backoff). Defaults to 10000. */
	delay_max?: number;
	/** Exponential backoff factor. Defaults to 1.5. */
	factor?: number;
}

export interface FrontendWebsocketClientOptions {
	/**
	 * Auto-reconnect policy. `false` disables reconnect entirely; `true` or
	 * omit for default timing; pass an object to customize.
	 */
	reconnect?: boolean | FrontendWebsocketReconnectOptions;
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
export class FrontendWebsocketClient implements WebsocketConnection, Disposable {
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
	/** Epoch ms of the most recent successful open. Never cleared on close. */
	last_connect_time: number | null = $state.raw(null);
	/** Epoch ms of the most recent close event or client-initiated close. */
	last_close_time: number | null = $state.raw(null);
	/** Close code from the most recent close. Initial `null` means "never closed." */
	last_close_code: number | null = $state.raw(null);
	/** Reason string from the most recent close event (may be empty). */
	last_close_reason: string | null = $state.raw(null);

	#reconnect_timeout: ReturnType<typeof setTimeout> | null = null;
	#revoked: boolean = $state.raw(false);

	#message_handlers: Set<SocketMessageHandler> = new Set();
	#error_handlers: Set<SocketErrorHandler> = new Set();

	readonly connected: boolean = $derived(this.status === 'connected');

	constructor(url: string, options: FrontendWebsocketClientOptions = {}) {
		this.#url = url;
		const reconnect = options.reconnect;
		this.#auto_reconnect = reconnect !== false;
		const config = typeof reconnect === 'object' && reconnect !== null ? reconnect : {};
		this.#reconnect_delay = config.delay ?? DEFAULT_RECONNECT_DELAY;
		this.#reconnect_delay_max = config.delay_max ?? DEFAULT_RECONNECT_DELAY_MAX;
		this.#backoff_factor = config.factor ?? DEFAULT_BACKOFF_FACTOR;
		this.#log = options.log ?? null;
	}

	get url(): string {
		return this.#url;
	}

	/**
	 * Whether the server has permanently closed the session. Once `true`, all
	 * `connect()` calls are no-ops. Distinct from `status:'closed'`, which
	 * reflects any closed state (incl. user-initiated `disconnect()`).
	 */
	get revoked(): boolean {
		return this.#revoked;
	}

	/**
	 * Open the WebSocket. No-op on SSR, or if the session has been revoked.
	 * Cancels any pending reconnect and tears down any existing connection first;
	 * an open prior socket is closed with a normal-closure code.
	 */
	connect(): void {
		if (!BROWSER) return;
		if (this.#revoked) return;

		this.#cancel_reconnect();
		this.#teardown(DEFAULT_CLOSE_CODE);

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
			if (this.#auto_reconnect) {
				this.#schedule_reconnect();
			} else {
				this.status = 'closed';
			}
		}
	}

	/**
	 * Close the WebSocket, cancel any pending reconnect, and reset the reconnect
	 * backoff counters. Puts the client in `closed` status; call `connect()` to
	 * reopen. Safe to call more than once.
	 */
	disconnect(code: number = DEFAULT_CLOSE_CODE): void {
		this.#cancel_reconnect();
		this.#teardown(code);
		this.status = 'closed';
		this.reconnect_count = 0;
		this.current_reconnect_delay = 0;
	}

	/** Explicit-resource-management hook — supports `using client = new FrontendWebsocketClient(url)`. */
	[Symbol.dispose](): void {
		this.disconnect();
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

	#teardown(close_code: number): void {
		if (!this.ws) return;
		this.ws.removeEventListener('open', this.#handle_open);
		this.ws.removeEventListener('close', this.#handle_close);
		this.ws.removeEventListener('error', this.#handle_error);
		this.ws.removeEventListener('message', this.#handle_message);

		if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
			try {
				this.ws.close(close_code);
			} catch (error) {
				this.#log?.error('[socket] close failed:', error);
			}
			// Listeners are gone, so `#handle_close` won't fire for this close —
			// record it here so the client-initiated close is still observable.
			this.#record_close(close_code, '');
		}
		this.ws = null;
	}

	#record_close(code: number, reason: string): void {
		this.last_close_time = Date.now();
		this.last_close_code = code;
		this.last_close_reason = reason;
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
		// Drop the dead-socket reference so consumers reading `client.ws` never
		// see a CLOSED WebSocket during the reconnect window.
		this.ws = null;
		this.#record_close(event.code, event.reason);
		// Session revocation is terminal — reconnecting would 401 in a loop.
		if (event.code === WS_CLOSE_SESSION_REVOKED) {
			this.#revoked = true;
			this.status = 'closed';
			this.#cancel_reconnect();
			this.reconnect_count = 0;
			this.current_reconnect_delay = 0;
			return;
		}
		// Let `#schedule_reconnect` set `status: 'reconnecting'` directly to avoid
		// a transient `'closed'` flicker; only set `'closed'` when reconnect is off.
		if (this.#auto_reconnect) {
			this.#schedule_reconnect();
		} else {
			this.status = 'closed';
		}
	};

	#handle_error = (event: Event): void => {
		this.#log?.error('[socket] websocket error:', event);
		for (const handler of this.#error_handlers) {
			try {
				handler(event);
			} catch (error) {
				this.#log?.error('[socket] error handler threw:', error);
			}
		}
		// Browsers fire `close` after error; reconnect logic lives there.
	};

	#handle_message = (event: MessageEvent): void => {
		for (const handler of this.#message_handlers) {
			try {
				handler(event);
			} catch (error) {
				this.#log?.error('[socket] message handler threw:', error);
			}
		}
	};
}
