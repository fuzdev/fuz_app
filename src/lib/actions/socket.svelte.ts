/**
 * Frontend WebSocket client — portable, Svelte-reactive, implements `WebsocketConnection`.
 *
 * Plain class with `$state` runes (no Cell inheritance, no app coupling).
 * Drop into any SvelteKit frontend as the underlying connection for
 * `FrontendWebsocketTransport`. Handles auto-reconnect with exponential
 * backoff, respects `WS_CLOSE_SESSION_REVOKED` (no reconnect loop after the
 * server revokes auth), exposes reactive status for UI indicators, and ships
 * three correctness primitives default-on:
 *
 * - {@link FrontendWebsocketClient.request} — promise-based JSON-RPC with
 *   auto-assigned ids and a pending-id map. Intercepts responses on the
 *   message path so request/response correlation is transport-level rather
 *   than re-invented per consumer.
 * - **Durable queue** — `request()` calls made while disconnected buffer up
 *   to {@link DEFAULT_QUEUE_MAX_SIZE} requests and flush on reopen. Overflow
 *   rejects with `queue_overflow`. Raw {@link FrontendWebsocketClient.send}
 *   is drop-on-disconnect (fire-and-forget notifications want that).
 * - **Activity-aware heartbeat** — idles fire a shared `heartbeat` request;
 *   receive-silence past {@link DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT} closes
 *   with {@link WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT} and lets auto-reconnect
 *   pick back up.
 *
 * @module
 */

import {BROWSER} from 'esm-env';
import type {Logger} from '@fuzdev/fuz_util/log.js';
import type {AsyncStatus} from '@fuzdev/fuz_util/async.js';

import {JSONRPC_VERSION, type JsonrpcRequestId} from '../http/jsonrpc.js';
import {WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT, WS_CLOSE_SESSION_REVOKED} from './transports.js';
import {CANCEL_METHOD} from './cancel.js';
import {HEARTBEAT_METHOD} from './heartbeat.js';
import type {WebsocketConnection} from './transports_ws.js';

/** Default WebSocket close code (normal closure). */
export const DEFAULT_CLOSE_CODE = 1000;
/** Base reconnect delay in ms. */
export const DEFAULT_RECONNECT_DELAY = 1000;
/** Max reconnect delay in ms (cap on exponential backoff). */
export const DEFAULT_RECONNECT_DELAY_MAX = 10000;
/** Exponential backoff factor: delay = base * factor^(attempt-1). */
export const DEFAULT_BACKOFF_FACTOR = 1.5;
/** Idle interval before sending a heartbeat (ms). */
export const DEFAULT_HEARTBEAT_INTERVAL = 30_000;
/** Max receive silence before closing with {@link WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT} (ms). */
export const DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT = 60_000;
/** Default bound on buffered requests while disconnected. Overflow rejects. */
export const DEFAULT_QUEUE_MAX_SIZE = 100;

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

export interface FrontendWebsocketHeartbeatOptions {
	/**
	 * Idle duration (ms) after which a heartbeat is sent. Reset by any send or
	 * receive — chatty clients never emit extras. Defaults to
	 * {@link DEFAULT_HEARTBEAT_INTERVAL}.
	 */
	interval?: number;
	/**
	 * Receive-silence (ms) after which the client closes the socket with
	 * {@link WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT}, letting auto-reconnect kick
	 * in. Should be a comfortable multiple of {@link interval}. Defaults to
	 * {@link DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT}.
	 */
	receive_timeout?: number;
}

export interface FrontendWebsocketQueueOptions {
	/**
	 * Maximum number of requests held while the socket is disconnected.
	 * Enqueue past this rejects the new call with a `queue_overflow` error.
	 * Defaults to {@link DEFAULT_QUEUE_MAX_SIZE}.
	 */
	max_size?: number;
}

export interface FrontendWebsocketClientOptions {
	/**
	 * Auto-reconnect policy. `false` disables reconnect entirely; `true` or
	 * omit for default timing; pass an object to customize.
	 */
	reconnect?: boolean | FrontendWebsocketReconnectOptions | null;
	/**
	 * Activity-aware heartbeat. `true`/`null`/omit for defaults; `false` disables
	 * the timer entirely (only do this if the server side is also running
	 * without heartbeat); pass an object to tune `interval` / `receive_timeout`.
	 */
	heartbeat?: boolean | FrontendWebsocketHeartbeatOptions | null;
	/**
	 * Durable queue for {@link FrontendWebsocketClient.request}. `true` or omit
	 * for defaults; `false` disables buffering (requests while disconnected
	 * reject immediately). Raw {@link FrontendWebsocketClient.send} is never
	 * queued — use `request()` for RPC semantics.
	 */
	queue?: boolean | FrontendWebsocketQueueOptions;
	/** Optional logger for diagnostic messages. */
	log?: Logger | null;
}

/** Internal — tracks a request whose promise is still unsettled. */
interface PendingRequest {
	method: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	signal: AbortSignal | null;
	signal_handler: (() => void) | null;
}

/** Internal — tracks a request whose frame hasn't been written to the socket yet. */
interface QueuedRequest extends PendingRequest {
	id: JsonrpcRequestId;
	frame: {jsonrpc: string; id: JsonrpcRequestId; method: string; params: unknown};
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
	#auto_reconnect: boolean;
	#reconnect_delay: number;
	#reconnect_delay_max: number;
	#backoff_factor: number;

	#heartbeat_enabled: boolean;
	#heartbeat_interval: number;
	#heartbeat_receive_timeout: number;

	#queue_enabled: boolean;
	#queue_max_size: number;

	readonly #log: Logger | null;

	#next_request_id: number = 0;
	#pending: Map<JsonrpcRequestId, PendingRequest> = new Map();
	#queue: Array<QueuedRequest> = [];

	#heartbeat_timer: ReturnType<typeof setInterval> | null = null;
	/** Epoch ms of the last outgoing send — used by the heartbeat activity check. */
	#last_send_time: number | null = null;
	/** Epoch ms of the last incoming message — used by the heartbeat activity check. */
	#last_receive_time: number | null = null;

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
	/**
	 * The error thrown by the most recent attempted `send()`, or `null` if the
	 * most recent attempt succeeded or none has been attempted yet. Populated
	 * when the underlying `ws.send` throws (e.g., buffer full, serialization
	 * error); reset to `null` on the next successful send. Not touched when
	 * `send()` short-circuits because the socket is not connected — consult
	 * {@link connected} for that case. Wrappers surfacing per-message failure
	 * reasons can read this after a `false` return from `send()`.
	 */
	last_send_error: Error | null = $state.raw(null);

	#reconnect_timeout: ReturnType<typeof setTimeout> | null = null;
	#reconnect_scheduled_at: number | null = null;
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

		const heartbeat = options.heartbeat;
		this.#heartbeat_enabled = heartbeat !== false;
		const heartbeat_config = typeof heartbeat === 'object' && heartbeat !== null ? heartbeat : {};
		this.#heartbeat_interval = heartbeat_config.interval ?? DEFAULT_HEARTBEAT_INTERVAL;
		this.#heartbeat_receive_timeout =
			heartbeat_config.receive_timeout ?? DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT;

		const queue = options.queue;
		this.#queue_enabled = queue !== false;
		const queue_config = typeof queue === 'object' ? queue : {};
		this.#queue_max_size = queue_config.max_size ?? DEFAULT_QUEUE_MAX_SIZE;

		this.#log = options.log ?? null;
	}

	/**
	 * Swap the auto-reconnect policy in place. Accepts the same shape as the
	 * constructor's `reconnect` option: `false` disables reconnect, `true` or
	 * `null`/omitted restores the defaults, or a config object customizes
	 * specific fields (missing fields fall back to defaults, not "keep
	 * current" — each call defines the whole policy atomically, same as the
	 * constructor).
	 *
	 * In-flight reconnect schedules are **monotonically shortened**: the
	 * effective total wait from arm-time never exceeds what the new policy
	 * prescribes. If the new target is already past the time already
	 * elapsed, the reconnect fires immediately (on the next tick). The wait
	 * is never extended.
	 *
	 * Turning reconnect off while a reconnect timer is pending cancels that
	 * timer and transitions status to `closed` (since the lie of
	 * `'reconnecting'` would be visible to UI indicators). Turning it back on
	 * does not synthesize a reconnect — wait for the next close.
	 */
	set_reconnect(reconnect: boolean | FrontendWebsocketReconnectOptions | null = null): void {
		const next_auto = reconnect !== false;
		const config = typeof reconnect === 'object' && reconnect !== null ? reconnect : {};
		this.#auto_reconnect = next_auto;
		this.#reconnect_delay = config.delay ?? DEFAULT_RECONNECT_DELAY;
		this.#reconnect_delay_max = config.delay_max ?? DEFAULT_RECONNECT_DELAY_MAX;
		this.#backoff_factor = config.factor ?? DEFAULT_BACKOFF_FACTOR;

		if (this.#reconnect_timeout === null) return;

		if (!next_auto) {
			this.#cancel_reconnect();
			this.status = 'closed';
			this.#reset_reconnect_counters();
			return;
		}

		// Auto-reconnect still on: monotonically shorten the pending wait if
		// the new policy would produce a shorter total wait from arm-time.
		// Never extends.
		const scheduled_at = this.#reconnect_scheduled_at ?? Date.now();
		const elapsed = Math.max(0, Date.now() - scheduled_at);
		const remaining = Math.max(0, this.current_reconnect_delay - elapsed);
		const new_target = Math.round(
			Math.min(
				this.#reconnect_delay_max,
				this.#reconnect_delay * this.#backoff_factor ** Math.max(0, this.reconnect_count - 1),
			),
		);
		const new_remaining = Math.max(0, new_target - elapsed);
		if (new_remaining >= remaining) return;

		clearTimeout(this.#reconnect_timeout);
		this.current_reconnect_delay = new_target;
		// Keep #reconnect_scheduled_at at the original arm time so subsequent
		// set_reconnect calls compute elapsed against a stable origin.
		this.#reconnect_timeout = setTimeout(() => {
			this.#reconnect_timeout = null;
			this.#reconnect_scheduled_at = null;
			this.connect();
		}, new_remaining);
	}

	/**
	 * Swap the heartbeat policy in place. Accepts the same shape as the
	 * constructor's `heartbeat` option: `false` disables the timer, `true` or
	 * `null`/omitted restores the defaults, or a config object customizes
	 * specific fields (missing fields fall back to defaults, not "keep
	 * current" — each call defines the whole policy atomically, same as the
	 * constructor and {@link set_reconnect}).
	 *
	 * When connected, the live timer is restarted immediately so the new
	 * `interval` / `receive_timeout` take effect without a reconnect; when
	 * disconnected, just stashes the policy for the next open.
	 */
	set_heartbeat(heartbeat: boolean | FrontendWebsocketHeartbeatOptions | null = null): void {
		this.#heartbeat_enabled = heartbeat !== false;
		const config = typeof heartbeat === 'object' && heartbeat !== null ? heartbeat : {};
		this.#heartbeat_interval = config.interval ?? DEFAULT_HEARTBEAT_INTERVAL;
		this.#heartbeat_receive_timeout = config.receive_timeout ?? DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT;

		if (this.connected) {
			this.#start_heartbeat();
		} else {
			this.#cancel_heartbeat();
		}
	}

	/**
	 * Cancel a scheduled reconnect without closing the client or disabling
	 * auto-reconnect. Transitions status from `reconnecting` → `closed` and
	 * resets the backoff counters — the next close still triggers a fresh
	 * reconnect cycle under the current policy. No-op when no reconnect is
	 * pending.
	 *
	 * Use this when UI state asks "stop trying for now" without the finality
	 * of {@link disconnect} (which also rejects pending/queued requests and
	 * clears heartbeat) or the policy change of `set_reconnect(false)`
	 * (which disables future reconnects). The queue stays intact so that
	 * calling {@link connect} later flushes buffered work.
	 */
	cancel_reconnect(): void {
		if (this.#reconnect_timeout === null) return;
		this.#cancel_reconnect();
		this.status = 'closed';
		this.#reset_reconnect_counters();
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
		this.#cancel_heartbeat();
		this.#teardown(code);
		this.status = 'closed';
		this.#reset_reconnect_counters();
		this.#reject_all('client disconnected');
	}

	/** Explicit-resource-management hook — supports `using client = new FrontendWebsocketClient(url)`. */
	[Symbol.dispose](): void {
		this.disconnect();
	}

	send(data: object): boolean {
		if (!this.connected || !this.ws) return false;
		try {
			this.ws.send(JSON.stringify(data));
			this.last_send_error = null;
			this.#last_send_time = Date.now();
			return true;
		} catch (error) {
			this.#log?.error('[socket] send failed:', error);
			this.last_send_error = error instanceof Error ? error : new Error(String(error));
			return false;
		}
	}

	/**
	 * Promise-based JSON-RPC over the socket. Auto-assigns a monotonic request
	 * id (or uses an explicit one supplied via `options.id` — used by
	 * `FrontendWebsocketTransport` which delegates to this method and has its
	 * own peer-minted UUID), tracks the pending promise, and resolves when the
	 * server sends a matching response (or rejects on error frame, socket
	 * close, or aborted signal).
	 *
	 * Callers supplying an explicit `options.id` are responsible for
	 * uniqueness — the pending map is keyed by id, and a duplicate silently
	 * overwrites the prior entry. Auto-minted ids are monotonic and never
	 * collide with themselves or with peer-minted UUIDs (the types differ:
	 * integer vs string).
	 *
	 * While the socket is disconnected, the request is buffered in a bounded
	 * queue (default-on, `DEFAULT_QUEUE_MAX_SIZE`) and flushed on reopen. Pass
	 * `{queue: false}` to reject immediately when disconnected — used
	 * internally by the heartbeat, which must not fight the queue for the
	 * disconnect-detection slot.
	 *
	 * On `AbortSignal` fire: rejects the local promise *and* sends the shared
	 * `cancel` notification (`CANCEL_METHOD`) so the server-side dispatcher
	 * can abort the matching handler's `ctx.signal`. Suppressed for
	 * queued-but-never-sent (server doesn't know about it) and
	 * response-beat-cancel races.
	 */
	request<R = unknown>(
		method: string,
		params: unknown = {},
		options: {signal?: AbortSignal; queue?: boolean; id?: JsonrpcRequestId} = {},
	): Promise<R> {
		return new Promise<R>((resolve, reject) => {
			const resolve_typed = resolve as (result: unknown) => void;
			const reject_typed = reject as (error: Error) => void;

			if (this.#revoked) {
				reject_typed(new Error('[socket] session revoked'));
				return;
			}

			const {signal = null} = options;
			if (signal?.aborted) {
				reject_typed(this.#build_abort_error(method));
				return;
			}

			const id = options.id ?? ++this.#next_request_id;
			const frame = {jsonrpc: JSONRPC_VERSION, id, method, params};

			// Bind the signal listener up-front so `#detach_signal` can find it by
			// reference regardless of which settlement path runs (inline send,
			// queued flush, close-time reject).
			let pending: PendingRequest | null = null;
			const signal_handler = signal
				? () => {
						if (!pending) return;
						// `Map.delete` returns true iff the entry existed — which
						// is our signal that the frame was actually written to
						// the socket (pending-only tracks in-flight). If it was
						// only queued (never sent), the server doesn't know
						// about it and doesn't need a cancel. If the response
						// beat the abort, `#handle_message` already deleted the
						// entry and detached this listener, so this closure
						// never runs in that race.
						const was_in_flight = this.#pending.delete(id);
						this.#drop_queued(id);
						this.#detach_signal(pending);
						pending = null;
						reject_typed(this.#build_abort_error(method));
						if (was_in_flight) this.#send_cancel(id);
					}
				: null;
			if (signal && signal_handler) signal.addEventListener('abort', signal_handler);

			pending = {method, resolve: resolve_typed, reject: reject_typed, signal, signal_handler};

			const should_queue = options.queue !== false && this.#queue_enabled;

			if (this.connected && this.ws) {
				const sent = this.send(frame);
				if (sent) {
					this.#pending.set(id, pending);
					return;
				}
				// Send failed mid-connected (serialization, buffer full). Requeue if
				// the queue is on, otherwise reject — this socket is in an odd
				// state but the caller asked for non-durable semantics.
				if (should_queue) {
					this.#enqueue({...pending, id, frame});
					return;
				}
				this.#detach_signal(pending);
				reject_typed(new Error(`[socket] send failed for ${method}`));
				return;
			}

			if (should_queue) {
				this.#enqueue({...pending, id, frame});
				return;
			}
			this.#detach_signal(pending);
			reject_typed(new Error(`[socket] not connected (method=${method})`));
		});
	}

	add_message_handler(handler: SocketMessageHandler): () => void {
		this.#message_handlers.add(handler);
		return () => this.#message_handlers.delete(handler);
	}

	add_error_handler(handler: SocketErrorHandler): () => void {
		this.#error_handlers.add(handler);
		return () => this.#error_handlers.delete(handler);
	}

	#build_abort_error(method: string): Error {
		return new Error(`[socket] request aborted (method=${method})`);
	}

	/**
	 * Fire-and-forget cancel notification to the server. The dispatcher
	 * looks up the matching pending handler's per-request `AbortController`
	 * and aborts it; unknown ids no-op. Drops silently when disconnected —
	 * the server's own socket-close path will abort any in-flight handlers.
	 */
	#send_cancel(request_id: JsonrpcRequestId): void {
		this.send({
			jsonrpc: JSONRPC_VERSION,
			method: CANCEL_METHOD,
			params: {request_id},
		});
	}

	#detach_signal(pending: PendingRequest): void {
		if (pending.signal && pending.signal_handler) {
			pending.signal.removeEventListener('abort', pending.signal_handler);
		}
	}

	#enqueue(queued: QueuedRequest): void {
		if (this.#queue.length >= this.#queue_max_size) {
			this.#detach_signal(queued);
			queued.reject(
				new Error(
					`[socket] request queue overflow (method=${queued.method}, max=${this.#queue_max_size})`,
				),
			);
			return;
		}
		this.#queue.push(queued);
	}

	#drop_queued(id: JsonrpcRequestId): void {
		const index = this.#queue.findIndex((q) => q.id === id);
		if (index !== -1) this.#queue.splice(index, 1);
	}

	#flush_queue(): void {
		if (!this.connected || !this.ws) return;
		const queued = this.#queue;
		this.#queue = [];
		for (const q of queued) {
			if (q.signal?.aborted) {
				this.#detach_signal(q);
				q.reject(this.#build_abort_error(q.method));
				continue;
			}
			const sent = this.send(q.frame);
			if (sent) {
				this.#pending.set(q.id, {
					method: q.method,
					resolve: q.resolve,
					reject: q.reject,
					signal: q.signal,
					signal_handler: q.signal_handler,
				});
			} else {
				this.#detach_signal(q);
				q.reject(new Error(`[socket] queued request send failed (method=${q.method})`));
			}
		}
	}

	#reject_all(reason: string): void {
		const pending = this.#pending;
		this.#pending = new Map();
		for (const [id, p] of pending) {
			this.#detach_signal(p);
			p.reject(new Error(`[socket] ${reason} (method=${p.method}, id=${id})`));
		}
		const queued = this.#queue;
		this.#queue = [];
		for (const q of queued) {
			this.#detach_signal(q);
			q.reject(new Error(`[socket] ${reason} (method=${q.method})`));
		}
	}

	#reject_pending_only(reason: string): void {
		// Socket closed but auto-reconnect will try again — pending requests were
		// in flight on the old socket so we can't correlate them after reopen;
		// queued requests haven't been sent yet and stay buffered for the flush.
		const pending = this.#pending;
		this.#pending = new Map();
		for (const [id, p] of pending) {
			this.#detach_signal(p);
			p.reject(new Error(`[socket] ${reason} (method=${p.method}, id=${id})`));
		}
	}

	#start_heartbeat(): void {
		this.#cancel_heartbeat();
		if (!this.#heartbeat_enabled) return;
		const now = Date.now();
		this.#last_send_time = now;
		this.#last_receive_time = now;
		// Run the check at half the interval so any event-loop blockage pauses
		// the timer itself; a dead-because-blocked socket is close enough to
		// dead-because-unresponsive that closing is arguably correct.
		const tick = Math.max(100, Math.floor(this.#heartbeat_interval / 2));
		this.#heartbeat_timer = setInterval(() => this.#heartbeat_tick(), tick);
	}

	#cancel_heartbeat(): void {
		if (this.#heartbeat_timer !== null) {
			clearInterval(this.#heartbeat_timer);
			this.#heartbeat_timer = null;
		}
	}

	#heartbeat_tick(): void {
		if (!this.connected || !this.ws) return;
		const now = Date.now();
		const last_receive = this.#last_receive_time ?? now;
		if (now - last_receive >= this.#heartbeat_receive_timeout) {
			this.#log?.info(
				`[socket] receive timeout (${now - last_receive}ms) — closing ${WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT}`,
			);
			try {
				this.ws.close(WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT, 'client heartbeat timeout');
			} catch (error) {
				this.#log?.error('[socket] heartbeat timeout close failed:', error);
			}
			return;
		}
		const last_activity = Math.max(this.#last_send_time ?? 0, last_receive);
		if (now - last_activity >= this.#heartbeat_interval) {
			// Fire-and-forget the heartbeat. If it fails (network, serialization),
			// receive-silence detection above will close the socket on the next
			// tick. No queue — the heartbeat is the thing that tells us the
			// queue needs flushing, it must not fight the queue for the slot.
			void this.request(HEARTBEAT_METHOD, {}, {queue: false}).catch((error) => {
				this.#log?.debug('[socket] heartbeat request failed:', error);
			});
		}
	}

	#teardown(close_code: number): void {
		if (!this.ws) return;
		this.ws.removeEventListener('open', this.#handle_open);
		this.ws.removeEventListener('close', this.#handle_close);
		this.ws.removeEventListener('error', this.#handle_error);
		this.ws.removeEventListener('message', this.#handle_message);

		this.#cancel_heartbeat();

		if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
			try {
				this.ws.close(close_code);
			} catch (error) {
				this.#log?.error('[socket] close failed:', error);
			}
			// Listeners are gone, so `#handle_close` won't fire for this close —
			// record it here so the client-initiated close is still observable,
			// and reject any pending requests that can never resolve now.
			this.#record_close(close_code, '');
			this.#reject_pending_only(`socket torn down (code ${close_code})`);
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

		this.#reconnect_scheduled_at = Date.now();
		this.#reconnect_timeout = setTimeout(() => {
			this.#reconnect_timeout = null;
			this.#reconnect_scheduled_at = null;
			this.connect();
		}, this.current_reconnect_delay);
	}

	#cancel_reconnect(): void {
		if (this.#reconnect_timeout !== null) {
			clearTimeout(this.#reconnect_timeout);
			this.#reconnect_timeout = null;
		}
		this.#reconnect_scheduled_at = null;
	}

	/** Reset the reactive reconnect counters — the pair always travels together. */
	#reset_reconnect_counters(): void {
		this.reconnect_count = 0;
		this.current_reconnect_delay = 0;
	}

	#handle_open = (_event: Event): void => {
		this.status = 'connected';
		this.#reset_reconnect_counters();
		this.last_connect_time = Date.now();
		this.#cancel_reconnect();
		this.#start_heartbeat();
		// Flush buffered requests before anyone else can observe the open state.
		this.#flush_queue();
	};

	#handle_close = (event: CloseEvent): void => {
		// Drop the dead-socket reference so consumers reading `client.ws` never
		// see a CLOSED WebSocket during the reconnect window.
		this.ws = null;
		this.#record_close(event.code, event.reason);
		this.#cancel_heartbeat();
		// Session revocation is terminal — reconnecting would 401 in a loop.
		if (event.code === WS_CLOSE_SESSION_REVOKED) {
			this.#revoked = true;
			this.status = 'closed';
			this.#cancel_reconnect();
			this.#reset_reconnect_counters();
			this.#reject_all('session revoked');
			return;
		}
		// Pending in-flight requests can't be correlated post-reconnect; reject
		// them. Queue stays so the flush on reopen replays unsent work.
		this.#reject_pending_only(`connection closed (code ${event.code})`);
		// Let `#schedule_reconnect` set `status: 'reconnecting'` directly to avoid
		// a transient `'closed'` flicker; only set `'closed'` when reconnect is off.
		if (this.#auto_reconnect) {
			this.#schedule_reconnect();
		} else {
			this.status = 'closed';
			this.#reject_all('connection closed, auto-reconnect disabled');
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
		this.#last_receive_time = Date.now();

		// Intercept JSON-RPC responses for pending `request()` calls. Parse
		// defensively — if the frame isn't valid JSON or isn't a response, fall
		// through to the registered message handlers (which still see every
		// notification, plus any stray response we don't own).
		let json: unknown;
		try {
			json = JSON.parse(String(event.data));
		} catch {
			json = undefined;
		}
		if (
			typeof json === 'object' &&
			json !== null &&
			'id' in json &&
			('result' in json || 'error' in json)
		) {
			const id = (json as {id: JsonrpcRequestId | null}).id;
			if (id !== null) {
				const pending = this.#pending.get(id);
				if (pending) {
					this.#pending.delete(id);
					this.#detach_signal(pending);
					if ('error' in json && (json as {error: unknown}).error) {
						const err = (json as {error: {code?: number; message?: string; data?: unknown}}).error;
						pending.reject(
							new Error(
								`[rpc ${pending.method} #${id}] ${err.code ?? '?'} ${err.message ?? 'unknown error'}`,
							),
						);
					} else {
						pending.resolve((json as {result: unknown}).result);
					}
					return;
				}
			}
		}

		for (const handler of this.#message_handlers) {
			try {
				handler(event);
			} catch (error) {
				this.#log?.error('[socket] message handler threw:', error);
			}
		}
	};
}

/**
 * Project {@link SocketStatus} onto fuz_util's {@link AsyncStatus} — the
 * 5-way → 4-way mapping every consumer re-derives to surface connection state
 * to UI (loading indicators, retry banners). Collapses `reconnecting` into
 * `failure` (UI shows "lost, retrying") and splits `closed` by `revoked` so
 * a terminal session-revocation read as `failure` while a clean client-
 * initiated close reads as `initial` (the "not connected, not trying" state).
 *
 * @param status - the socket's current {@link SocketStatus}
 * @param revoked - whether the session has been permanently revoked
 *   (typically `FrontendWebsocketClient.revoked`)
 */
export const socket_status_to_async_status = (
	status: SocketStatus,
	revoked: boolean,
): AsyncStatus => {
	switch (status) {
		case 'initial':
			return 'initial';
		case 'connecting':
			return 'pending';
		case 'connected':
			return 'success';
		case 'reconnecting':
			return 'failure';
		case 'closed':
			return revoked ? 'failure' : 'initial';
	}
};
