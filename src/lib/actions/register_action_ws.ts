/**
 * WebSocket JSON-RPC dispatch — the low-level WS transport binding.
 *
 * Most consumers should mount WS endpoints via `register_ws_endpoint`
 * (`actions/register_ws_endpoint.ts`), which wraps this function with the
 * standard upgrade stack (origin check + auth + optional role). This
 * module stays exported as the lower-level entry point for tests that
 * drive the dispatcher directly via `create_ws_test_harness`.
 *
 * Symmetric to `create_rpc_endpoint` (from `actions/action_rpc.ts`):
 * both transports parse their wire envelope, then call the shared
 * `perform_action` core (`actions/perform_action.ts`) for the post-parse
 * pipeline. WS-specific concerns — connection lifecycle, heartbeat,
 * cancel-notification interception, socket-scoped notify — stay in this
 * module; everything else (auth gates, input validation, authorization
 * phase, rate limiting, transactional dispatch, DEV output validation,
 * thrown-error normalization) is shared.
 *
 * ## Auth expectations
 *
 * The consumer is responsible for rejecting unauthenticated upgrades
 * *before* routing to this handler (fuz_app's `require_auth` middleware,
 * or `register_ws_endpoint` which wires it for you). Per-action auth
 * runs inside `perform_action` on every message via the same gates HTTP
 * RPC uses.
 *
 * @module
 */

import type {Hono} from 'hono';
import type {UpgradeWebSocket, WSContext} from 'hono/ws';
import {wait} from '@fuzdev/fuz_util/async.ts';
import {Logger, type Logger as LoggerType} from '@fuzdev/fuz_util/log.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';

import {
	get_request_context,
	require_request_context,
	type RequestContext,
} from '../auth/request_context.ts';
import {hash_session_token} from '../auth/session_queries.ts';
import {get_client_ip} from '../http/client_ip.ts';
import {flush_pending_effects, flush_post_commit_effects} from '../http/pending_effects.ts';
import type {RateLimiter} from '../rate_limiter.ts';
import type {JsonrpcRequestId} from '../http/jsonrpc.ts';
import {jsonrpc_error_messages} from '../http/jsonrpc_errors.ts';
import {
	create_jsonrpc_error_response,
	create_jsonrpc_notification,
	to_jsonrpc_message_id,
	to_jsonrpc_params,
	is_jsonrpc_request,
} from '../http/jsonrpc_helpers.ts';
import {
	CREDENTIAL_TYPE_KEY,
	AUTH_API_TOKEN_ID_KEY,
	TEST_CONTEXT_PRESET_KEY,
	type CredentialType,
} from '../hono_context.ts';
import type {Db} from '../db/db.ts';
import {type Action} from './action_types.ts';
import {compile_action_registry} from './compile_action_registry.ts';
import {cancel_action_spec, CancelNotificationParams} from './cancel.ts';
import {WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT} from './transports.ts';
import {BackendWebsocketTransport, type ConnectionIdentity} from './transports_ws_backend.ts';
import {perform_action, perform_action_result_to_envelope} from './perform_action.ts';

export type {Action};

/** Default inactivity window before the server closes a silent socket. */
export const DEFAULT_SERVER_HEARTBEAT_TIMEOUT = 60_000;

/**
 * Context passed to the `on_socket_open` hook.
 *
 * Fires after the transport has registered the new connection (so
 * `connection_id` is valid) but before any client message can dispatch.
 * Consumers use this to bootstrap per-socket domain state — e.g.
 * spawning a per-account unit and pushing an initial state snapshot.
 */
export interface SocketOpenContext {
	/** The raw WebSocket context — exposed for edge cases; prefer `notify` for sends. */
	ws: WSContext;
	/** Connection id assigned by `BackendWebsocketTransport.add_connection`. */
	connection_id: Uuid;
	/** Auth identity registered for this connection. */
	identity: ConnectionIdentity;
	/**
	 * Send a JSON-RPC notification to just this socket. Mirrors `ctx.notify`
	 * on per-message handler contexts — same socket-scoped semantics.
	 */
	notify: (method: string, params: unknown) => void;
	/** Fires when this socket closes — threaded through to every handler's `ctx.signal`. */
	signal: AbortSignal;
}

/**
 * Context passed to the `on_socket_close` hook.
 *
 * Fires before `transport.remove_connection` runs, so consumer cleanup can
 * still read identity before it's torn down. Fires for both client-initiated
 * closes (Hono onClose) and server-initiated closes via audit revocation
 * (the audit guard calls `ws.close()`, which triggers Hono's onClose).
 */
export interface SocketCloseContext {
	/** The raw WebSocket context at close time. */
	ws: WSContext;
	/** Connection id captured at open time. */
	connection_id: Uuid;
	/** Auth identity captured at open time — still valid even if the transport already cleaned up. */
	identity: ConnectionIdentity;
}

export interface ServerHeartbeatOptions {
	/**
	 * Receive-silence (ms) past which the server closes the socket with
	 * `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT`. Any incoming message resets
	 * the counter — chatty clients never trip it. First `timeout`
	 * window after socket open is exempt (cold-start grace).
	 */
	timeout?: number;
}

/** Options for `register_action_ws`. */
export interface RegisterActionWsOptions {
	/** Mount path (e.g., `/api/ws`). */
	path: string;
	/** The Hono app to mount on. */
	app: Hono;
	/** Hono's `upgradeWebSocket` helper from the runtime adapter. */
	upgradeWebSocket: UpgradeWebSocket;
	/**
	 * The actions registered on this endpoint — each carries a spec (drives
	 * method lookup, per-action auth, input/output validation) and an
	 * optional handler (omit for client-only specs like inbound
	 * notifications). Spread `protocol_actions` from `actions/protocol.ts`
	 * here to complete the disconnect-detection + per-request cancel
	 * pairing with the frontend client.
	 */
	actions: ReadonlyArray<Action>;
	/**
	 * Pool-level DB. The dispatcher wraps in `db.transaction` for
	 * `side_effects: true` actions, the same way HTTP RPC does. Per-message
	 * authorization phase reads through this pool.
	 *
	 * Audit writes and other rollback-resilient fire-and-forget calls run
	 * through `AppDeps.audit.emit` from the action factory's closure —
	 * the dispatcher never holds an audit-side pool reference; the bound
	 * emitter owns the pool.
	 */
	db: Db;
	/**
	 * Existing transport to register connections with. When omitted, a fresh
	 * one is created and returned in the result. Pass your own to keep a
	 * handle for `create_ws_auth_guard` and `send_to`/`broadcast`.
	 */
	transport?: BackendWebsocketTransport;
	/**
	 * Server-side heartbeat policy. Default-on (receive-silence detection,
	 * 60s timeout). `false` disables the timer entirely — only do this if
	 * the upstream stack (TCP keepalive, Cloudflare idle timeout, etc.)
	 * already owns disconnect detection. Pass an object to tune the timeout.
	 */
	heartbeat?: boolean | ServerHeartbeatOptions;
	/** Optional per-message delay for testing loading states. Ignored when `0`. */
	artificial_delay?: number;
	/** Optional logger; defaults to `[ws]` namespace. */
	log?: LoggerType;
	/**
	 * Called once per socket, after the transport registers the connection.
	 * Awaited before any message is dispatched. Throwing logs an error and
	 * closes the socket with an `internal_error` frame — a failing bootstrap
	 * should not leave a partially-initialized socket alive.
	 */
	on_socket_open?: (ctx: SocketOpenContext) => void | Promise<void>;
	/**
	 * Called once per socket on close, *before* the transport removes the
	 * connection. Receives `connection_id` and `identity` captured at open
	 * time, so it is safe to read even when the audit guard has already torn
	 * down the transport's internal state. Errors are logged and swallowed.
	 */
	on_socket_close?: (ctx: SocketCloseContext) => void | Promise<void>;
	/**
	 * Per-IP rate limiter consulted for actions whose spec declares
	 * `rate_limit: 'ip'` or `'both'`. `null` (or omitted) disables the
	 * IP check. Same limiter is shared with the HTTP RPC dispatcher so
	 * one budget covers both transports per action. Resolved at upgrade
	 * time and reused for every message on the socket.
	 */
	action_ip_rate_limiter?: RateLimiter | null;
	/**
	 * Per-account rate limiter consulted for actions whose spec declares
	 * `rate_limit: 'account'` or `'both'`. Keyed on
	 * `request_context.account.id`. `null` (or omitted) disables the
	 * account check. Same limiter is shared with the HTTP RPC dispatcher.
	 */
	action_account_rate_limiter?: RateLimiter | null;
}

/** Result of `register_action_ws`. */
export interface RegisterActionWsResult {
	/** The transport bound to the endpoint — supplied or freshly created. */
	transport: BackendWebsocketTransport;
}

/**
 * Mount a JSON-RPC WebSocket endpoint that dispatches via the shared
 * `perform_action` core.
 *
 * Wire behavior:
 * - Batch JSON-RPC is rejected (single-message only).
 * - Notifications (method + no id) are silently dropped per JSON-RPC spec.
 *   Exception: `cancel` notifications abort the matching pending request's
 *   `ctx.signal` before bubbling out.
 * - Per-message dispatch goes through `perform_action`: pre-validation
 *   auth (401) → input validation (400) → authorization phase →
 *   post-authorization auth (403) → rate limit (429) → handler (with
 *   transaction wrap iff `spec.side_effects: true`) → DEV output validation.
 * - Authorization phase runs **per message** — role_grant changes during a
 *   connection lifetime are picked up on the next message without any
 *   in-place refresh. Authentication invalidation closes the socket via
 *   `create_ws_auth_guard`.
 *
 * @returns the transport (supplied or freshly created) — retain it to wire
 *   `create_ws_auth_guard` or broadcast on audit events.
 * @mutates options.app - registers a `GET path` route via `upgradeWebSocket`
 * @mutates options.transport - on every message, adds/removes connections
 *   in the transport's internal maps via `add_connection` / `remove_connection`
 */
export const register_action_ws = (options: RegisterActionWsOptions): RegisterActionWsResult => {
	const {
		path,
		app,
		upgradeWebSocket,
		actions,
		db,
		transport = new BackendWebsocketTransport(),
		heartbeat = true,
		artificial_delay = 0,
		log = new Logger('[ws]'),
		on_socket_open,
		on_socket_close,
		action_ip_rate_limiter = null,
		action_account_rate_limiter = null,
	} = options;

	// Build the dispatcher's per-method lookup. Only request_response
	// specs with a handler reach `action_map` — perform_action is the
	// only site that calls handlers, and it requires an `RpcAction`.
	// Other kinds (`remote_notification` like `cancel`, `local_call`)
	// are registry-only on WS; the cancel handler reads
	// `cancel_action_spec.method` directly.
	const {action_map} = compile_action_registry(actions, 'WS action');

	const heartbeat_enabled = heartbeat !== false;
	const heartbeat_config = typeof heartbeat === 'object' ? heartbeat : {};
	const heartbeat_timeout = heartbeat_config.timeout ?? DEFAULT_SERVER_HEARTBEAT_TIMEOUT;
	// Run the checker on timeout/2 so event-loop blockage pauses the timer
	// itself — a dead-because-blocked socket is close enough to
	// dead-because-unresponsive that closing is arguably correct.
	const heartbeat_tick_interval = Math.max(100, Math.floor(heartbeat_timeout / 2));

	app.get(
		path,
		upgradeWebSocket((c) => {
			// Upgrade-time identity capture. `require_auth` middleware has
			// already rejected unauthenticated upgrades, so request_context is
			// non-null here. Per-message dispatch reads `account_id` +
			// `credential_type` from this closure; the live request_context is
			// only used by the test-preset escape hatch (perform_action runs
			// the authorization phase fresh on every message in production).
			//
			// Per-message dispatch reloads role_grants via the authorization
			// phase but does NOT re-query session / token validity — those
			// are checked once at upgrade. Revocation enforcement therefore
			// lives outside this dispatcher, in the audit-driven WS auth
			// guard (`transports_ws_auth_guard.ts`). Without that guard wired
			// into the audit chain, `session_revoke` / `token_revoke` are
			// no-ops for existing WS connections.
			const upgrade_context = require_request_context(c);
			const account_id: Uuid = upgrade_context.account.id;
			const client_ip = get_client_ip(c);
			const credential_type: CredentialType = c.get(CREDENTIAL_TYPE_KEY)!;
			// Session-based connections have a token hash for targeted revocation.
			// Bearer/daemon connections pass null — still reachable via
			// `close_sockets_for_account` / `close_sockets_for_token`.
			const token_hash =
				credential_type === 'session' ? hash_session_token(c.get('auth_session_id')!) : null;
			// `api_token.id` — set only for bearer connections; enables
			// `close_sockets_for_token` to tear down just this socket on
			// `token_revoke` without affecting the account's other sockets.
			const api_token_id = c.get(AUTH_API_TOKEN_ID_KEY);

			// Test escape hatch — captured once at upgrade. perform_action
			// honors it per-message so harnesses with pre-baked
			// `RequestContext` skip the live authorization phase.
			const upgrade_preset: {request_context: RequestContext | null} | undefined = c.get(
				TEST_CONTEXT_PRESET_KEY,
			)
				? {request_context: get_request_context(c)}
				: undefined;

			// Per-socket abort controller — fires on socket close, chained into
			// every in-flight handler's per-request controller via
			// `AbortSignal.any`. Keeping both signals lets the client
			// cancel-one-request-by-id (via the `cancel` notification) without
			// tearing down the whole socket.
			const socket_abort_controller = new AbortController();
			// Per-request controllers keyed by JSON-RPC request id — lets an
			// incoming `cancel` notification abort just the matching handler.
			// Populated on request dispatch, cleared in the handler's `finally`
			// so a late-arriving cancel for a completed id (or a reused id)
			// can't null-abort a freshly-arrived request. Idempotent: cancel
			// for unknown ids no-ops.
			const pending_controllers: Map<JsonrpcRequestId, AbortController> = new Map();

			// Identity is assembled at upgrade time so `on_socket_close` can
			// still read it after the audit guard tears the transport record
			// down; `BackendWebsocketTransport.#revoke_connection` clears the
			// identity map before Hono fires onClose.
			const identity: ConnectionIdentity = {token_hash, account_id, api_token_id};
			// Captured on open, consumed on close. Undefined before onOpen
			// fires or when a consumer never opens (e.g. immediate disconnect).
			let captured_connection_id: Uuid | undefined;

			// Receive-silence watchdog. Seeded to open-time so the first window is
			// exempt (cold-start grace — avoid killing mid-handshake sockets).
			// Bumped by onMessage. Any incoming activity counts, not just
			// heartbeats — chatty clients don't need to send extras.
			let last_receive_time: number = 0;
			let heartbeat_timer: ReturnType<typeof setInterval> | null = null;
			const stop_heartbeat_timer = () => {
				if (heartbeat_timer !== null) {
					clearInterval(heartbeat_timer);
					heartbeat_timer = null;
				}
			};

			// Socket-scoped notification helper — routes to this socket only,
			// matches the `ctx.notify` semantics exposed to per-message handlers.
			const notify_socket =
				(ws: WSContext) =>
				(notify_method: string, notify_params: unknown): void => {
					try {
						const notification = create_jsonrpc_notification(
							notify_method,
							to_jsonrpc_params(notify_params),
						);
						ws.send(JSON.stringify(notification));
					} catch (error) {
						log.error('notify send failed:', notify_method, error);
					}
				};

			return {
				onOpen: async (_event, ws) => {
					const connection_id = transport.add_connection(ws, token_hash, account_id, api_token_id);
					captured_connection_id = connection_id;
					log.debug('ws opened', connection_id);
					if (heartbeat_enabled) {
						last_receive_time = Date.now();
						heartbeat_timer = setInterval(() => {
							const now = Date.now();
							const silence = now - last_receive_time;
							if (silence >= heartbeat_timeout) {
								log.info(
									`heartbeat timeout (${silence}ms) — closing ${WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT}`,
									connection_id,
									identity.account_id,
								);
								stop_heartbeat_timer();
								try {
									ws.close(WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT, 'server heartbeat timeout');
								} catch (error) {
									log.error('heartbeat timeout close failed:', error);
								}
							}
						}, heartbeat_tick_interval);
					}
					if (on_socket_open) {
						try {
							await on_socket_open({
								ws,
								connection_id,
								identity,
								notify: notify_socket(ws),
								signal: socket_abort_controller.signal,
							});
						} catch (error) {
							log.error('on_socket_open failed — closing socket:', error);
							try {
								ws.send(
									JSON.stringify(
										create_jsonrpc_error_response(null, jsonrpc_error_messages.internal_error()),
									),
								);
							} catch {
								// ignore — socket may already be dead
							}
							ws.close(1011, 'socket bootstrap failed');
						}
					}
				},
				onMessage: async (event, ws) => {
					last_receive_time = Date.now();
					let json;
					try {
						json = JSON.parse(String(event.data)); // eslint-disable-line @typescript-eslint/no-base-to-string
					} catch (error) {
						log.error('JSON parse error:', error);
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_response(null, jsonrpc_error_messages.parse_error()),
							),
						);
						return;
					}

					// Batch JSON-RPC is not supported on the WebSocket path.
					if (Array.isArray(json)) {
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_response(
									null,
									jsonrpc_error_messages.invalid_request(
										'batch JSON-RPC requests are not supported on WebSocket',
									),
								),
							),
						);
						return;
					}

					// Notifications (method + no id) — `cancel` is intercepted
					// for request-scoped cancellation; other notifications are
					// silenced per JSON-RPC spec (consumer notification handlers
					// are not a feature yet).
					if (!is_jsonrpc_request(json)) {
						if (typeof json === 'object' && json !== null && 'method' in json && !('id' in json)) {
							if ((json as {method: string}).method === cancel_action_spec.method) {
								const parsed = CancelNotificationParams.safeParse(
									(json as {params?: unknown}).params,
								);
								if (!parsed.success) {
									log.debug('cancel: invalid params, ignoring', parsed.error.issues);
									return;
								}
								const controller = pending_controllers.get(parsed.data.request_id);
								if (controller) {
									controller.abort();
								} else {
									log.debug('cancel: no pending request for id', parsed.data.request_id);
								}
							}
							return;
						}
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_response(
									to_jsonrpc_message_id(json),
									jsonrpc_error_messages.invalid_request(),
								),
							),
						);
						return;
					}

					const {method, id, params} = json;

					// Per-action method lookup — return method_not_found before
					// we engage the dispatch machinery. Specs without a handler
					// (client-only / dispatcher-handled) miss action_map and
					// surface as method_not_found just like unknown methods.
					const action = action_map.get(method);
					if (!action) {
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_response(id, jsonrpc_error_messages.method_not_found(method)),
							),
						);
						return;
					}

					if (artificial_delay > 0) {
						log.debug(`throttling ${artificial_delay}ms`);
						await wait(artificial_delay);
					}

					// Per-request controller — fires on explicit `cancel` or on
					// socket close (via the socket_abort_controller chain below).
					// Registered before dispatch so a cancel arriving mid-handler
					// finds it; cleared in `finally` so late cancels for a
					// completed id (or a future request that reuses the id) can't
					// null-abort the wrong handler.
					const request_controller = new AbortController();
					pending_controllers.set(id, request_controller);

					// Per-message side-effect queues. `pending_effects` collects
					// eager fire-and-forget pool writes (audit emits, etc.);
					// `post_commit_effects` collects deferred thunks pushed
					// via `emit_after_commit` (WS notifications). Both flush
					// in the `finally` so the next message sees a clean slate.
					//
					// Ordering invariant — reply-before-flush is load-bearing.
					// Handlers that revoke their own credential
					// (`session_revoke_all`, `token_revoke` of the calling
					// bearer) audit-emit events whose listener chain — wired
					// by the WS auth guard in `transports_ws_auth_guard.ts` —
					// closes this socket when the audit row writes. The
					// synchronous `ws.send` on the success path returns
					// before any close can fire (the DB write that triggers
					// the chain is async — even in production with
					// `await_pending_effects: false`, the listener chain only
					// runs after the row lands). Inverting the order —
					// flushing the queues before the send — would silently
					// strand the caller without a reply.
					const pending_effects: Array<Promise<void>> = [];
					const post_commit_effects: Array<() => void | Promise<void>> = [];

					const notify = notify_socket(ws);
					const signal = AbortSignal.any([
						socket_abort_controller.signal,
						request_controller.signal,
					]);

					try {
						const result = await perform_action(
							{
								action,
								raw_params: params,
								request_id: id,
								account_id,
								credential_type,
								client_ip,
								signal,
								notify,
								connection_id: captured_connection_id,
								preset: upgrade_preset,
							},
							{
								db,
								pending_effects,
								post_commit_effects,
								log,
								action_ip_rate_limiter,
								action_account_rate_limiter,
							},
						);
						ws.send(JSON.stringify(perform_action_result_to_envelope(id, result)));
					} finally {
						pending_controllers.delete(id);
						await flush_pending_effects(pending_effects, log);
						await flush_post_commit_effects(post_commit_effects, log);
					}
				},
				onClose: async (event, ws) => {
					stop_heartbeat_timer();
					socket_abort_controller.abort();
					if (on_socket_close && captured_connection_id) {
						try {
							await on_socket_close({
								ws,
								connection_id: captured_connection_id,
								identity,
							});
						} catch (error) {
							log.error('on_socket_close failed:', error);
						}
					}
					transport.remove_connection(ws);
					log.debug('ws closed', captured_connection_id, {code: event.code, reason: event.reason});
				},
			};
		}),
	);

	return {transport};
};
