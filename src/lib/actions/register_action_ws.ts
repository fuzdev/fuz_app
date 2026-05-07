/**
 * WebSocket JSON-RPC dispatch — the low-level WS transport binding.
 *
 * Most consumers should mount WS endpoints via `register_ws_endpoint`
 * (`actions/register_ws_endpoint.ts`), which wraps this function with the standard
 * upgrade stack (origin check + auth + optional role). This module stays
 * exported as the lower-level entry point for tests that drive the
 * dispatcher directly via `create_ws_test_harness`.
 *
 * Symmetric to `create_rpc_endpoint` (from `actions/action_rpc.ts`):
 * consumer supplies action specs + a handler map, the dispatcher parses the
 * envelope, checks per-action auth, validates input, invokes the handler with
 * a per-request context, and writes the response.
 *
 * Extracted from zzz's `register_websocket_actions` to converge pattern drift
 * across consumers (zzz, tx, undying). Broadcast-style notifications remain
 * domain-shaped today — this module only covers per-request dispatch + the
 * socket-scoped `ctx.notify` + per-socket `ctx.signal`. See
 * `BackendWebsocketTransport.send` for broadcast.
 *
 * ## Auth expectations
 *
 * The consumer is responsible for rejecting unauthenticated upgrades *before*
 * routing to this handler (fuz_app's `require_auth` middleware, or
 * `register_ws_endpoint` which wires it for you). Inside the dispatcher,
 * `require_request_context(c)` enforces the dispatcher invariant and
 * per-action auth is enforced on each message.
 *
 * @module
 */

import {DEV} from 'esm-env';
import type {Context, Hono} from 'hono';
import type {UpgradeWebSocket, WSContext} from 'hono/ws';
import {wait} from '@fuzdev/fuz_util/async.js';
import {Logger, type Logger as LoggerType} from '@fuzdev/fuz_util/log.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {has_role, require_request_context} from '../auth/request_context.js';
import {hash_session_token} from '../auth/session_queries.js';
import {ROLE_KEEPER} from '../auth/role_schema.js';
import {get_client_ip} from '../http/proxy.js';
import type {RateLimiter} from '../rate_limiter.js';
import {JSONRPC_VERSION, type JsonrpcRequestId} from '../http/jsonrpc.js';
import {jsonrpc_error_messages, ThrownJsonrpcError} from '../http/jsonrpc_errors.js';
import {
	create_jsonrpc_error_response,
	create_jsonrpc_error_response_from_thrown,
	create_jsonrpc_notification,
	to_jsonrpc_message_id,
	to_jsonrpc_params,
	is_jsonrpc_request,
} from '../http/jsonrpc_helpers.js';
import {CREDENTIAL_TYPE_KEY, AUTH_API_TOKEN_ID_KEY, type CredentialType} from '../hono_context.js';
import type {ActionSpecUnion} from './action_spec.js';
import {type Action, type BaseHandlerContext, type WsActionHandler} from './action_types.js';
import {cancel_action_spec, CancelNotificationParams} from './cancel.js';
import {WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT} from './transports.js';
import {BackendWebsocketTransport, type ConnectionIdentity} from './transports_ws_backend.js';

export type {Action, BaseHandlerContext, WsActionHandler};

/** Default inactivity window before the server closes a silent socket. */
export const DEFAULT_SERVER_HEARTBEAT_TIMEOUT = 60_000;

/**
 * Context passed to the `on_socket_open` hook.
 *
 * Fires after the transport has registered the new connection (so
 * `connection_id` is valid) but before any client message can dispatch.
 * Consumers use this to bootstrap per-socket domain state — e.g. undying
 * spawns the per-account spirit unit and pushes an initial state snapshot.
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
export interface RegisterActionWsOptions<TCtx extends BaseHandlerContext> {
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
	actions: ReadonlyArray<Action<TCtx>>;
	/**
	 * Build the per-request context from the base and the upgrade-time Hono
	 * context. Called once per incoming message. Consumers use this to attach
	 * domain singletons (`backend`) or per-socket auth (`auth`,
	 * `credential_type`) without re-reading them from `c` inside every handler.
	 */
	extend_context: (base: BaseHandlerContext, c: Context) => TCtx;
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
 * Mount a JSON-RPC WebSocket endpoint that dispatches to the supplied handler
 * map. Per-request context is built from the base + consumer-provided
 * `RegisterActionWsOptions.extend_context`.
 *
 * Wire behavior:
 * - Batch JSON-RPC is rejected (single-message only).
 * - Notifications (method + no id) are silently dropped per JSON-RPC spec.
 * - Per-action auth: `public` / `authenticated` pass through (upgrade auth
 *   already verified identity); `keeper` requires `daemon_token` credential
 *   type *and* the keeper role; role-based `{role}` requires the named role
 *   via `has_role`, matching the HTTP path in `actions/action_rpc.ts`.
 * - DEV mode validates handler output against the spec's `output` schema and
 *   warns on mismatches.
 *
 * @returns the transport (supplied or freshly created) — retain it to wire
 *   `create_ws_auth_guard` or broadcast on audit events.
 * @mutates options.app - registers a `GET path` route via `upgradeWebSocket`
 * @mutates options.transport - on every message, adds/removes connections
 *   in the transport's internal maps via `add_connection` / `remove_connection`
 */
export const register_action_ws = <TCtx extends BaseHandlerContext>(
	options: RegisterActionWsOptions<TCtx>,
): RegisterActionWsResult => {
	const {
		path,
		app,
		upgradeWebSocket,
		actions,
		extend_context,
		transport = new BackendWebsocketTransport(),
		heartbeat = true,
		artificial_delay = 0,
		log = new Logger('[ws]'),
		on_socket_open,
		on_socket_close,
		action_ip_rate_limiter = null,
		action_account_rate_limiter = null,
	} = options;

	// Fan the unified actions array into the two lookups the dispatcher
	// consults at message time. Keeping them internal means the composable
	// `{spec, handler}` tuple remains the only shape consumers name.
	const spec_by_method: Map<string, ActionSpecUnion> = new Map();
	const handlers: Record<string, WsActionHandler<TCtx>> = {};
	for (const action of actions) {
		spec_by_method.set(action.spec.method, action.spec);
		if (action.handler) handlers[action.spec.method] = action.handler;
		// Reject account-keyed rate limiting on public actions — the dispatcher
		// has no actor to key on. Mirrors the HTTP RPC registration check.
		if (
			(action.spec.rate_limit === 'account' || action.spec.rate_limit === 'both') &&
			action.spec.auth === 'public'
		) {
			throw new Error(
				`WS action "${action.spec.method}" declares rate_limit: '${action.spec.rate_limit}' but auth: 'public' — no actor available for account-keyed limiting. Use 'ip' or change auth.`,
			);
		}
	}

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
			// Upgrade-time auth extraction — `require_auth` middleware has already
			// rejected unauthenticated requests, so request_context is guaranteed
			// non-null by the time we get here.
			const request_context = require_request_context(c);
			const account_id: Uuid = request_context.account.id;
			// Resolved at upgrade — every message on this socket shares the
			// same client IP, so we capture once and reuse for rate-limit
			// keying. `'unknown'` if the proxy middleware wasn't in the stack.
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
			// Captured on open, consumed on close. Null before onOpen fires or
			// when a consumer never opens (e.g. immediate disconnect).
			let captured_connection_id: Uuid | null = null;

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

					// Per-action auth check — enforce auth level from spec.
					const spec = spec_by_method.get(method);
					if (!spec) {
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_response(id, jsonrpc_error_messages.method_not_found(method)),
							),
						);
						return;
					}

					const {auth} = spec;
					if (auth === 'keeper') {
						if (credential_type !== 'daemon_token' || !has_role(request_context, ROLE_KEEPER)) {
							ws.send(
								JSON.stringify(
									create_jsonrpc_error_response(
										id,
										jsonrpc_error_messages.forbidden(
											'keeper actions require daemon_token credential with keeper role',
										),
									),
								),
							);
							return;
						}
					} else if (typeof auth === 'object' && auth !== null) {
						if (!has_role(request_context, auth.role)) {
							ws.send(
								JSON.stringify(
									create_jsonrpc_error_response(
										id,
										jsonrpc_error_messages.forbidden(`requires role: ${auth.role}`),
									),
								),
							);
							return;
						}
					}

					// Rate limit — throttle-requests semantics, mirrors the HTTP RPC
					// dispatcher. Same limiters are shared across transports so an
					// attacker can't bypass the budget by switching from RPC to WS.
					const rate_limit = spec.rate_limit;
					if (rate_limit) {
						const ip_check =
							action_ip_rate_limiter && (rate_limit === 'ip' || rate_limit === 'both');
						const account_check =
							action_account_rate_limiter && (rate_limit === 'account' || rate_limit === 'both');
						const send_rate_limited = (retry_after: number): void => {
							ws.send(
								JSON.stringify(
									create_jsonrpc_error_response(
										id,
										jsonrpc_error_messages.rate_limited('rate limited', {retry_after}),
									),
								),
							);
						};
						if (ip_check) {
							const result = action_ip_rate_limiter.check(client_ip);
							if (!result.allowed) {
								send_rate_limited(result.retry_after);
								return;
							}
						}
						if (account_check) {
							const result = action_account_rate_limiter.check(request_context.account.id);
							if (!result.allowed) {
								send_rate_limited(result.retry_after);
								return;
							}
						}
						if (ip_check) action_ip_rate_limiter.record(client_ip);
						if (account_check) action_account_rate_limiter.record(request_context.account.id);
					}

					// Look up handler — method is validated against spec_by_method above.
					const handler = handlers[method];
					if (!handler) {
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_response(id, jsonrpc_error_messages.method_not_found(method)),
							),
						);
						return;
					}

					// Validate input against spec schema.
					const parsed = spec.input.safeParse(params);
					if (!parsed.success) {
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_response(
									id,
									jsonrpc_error_messages.invalid_params(`invalid params for ${method}`, {
										issues: parsed.error.issues,
									}),
								),
							),
						);
						return;
					}
					const validated_input = parsed.data;

					if (artificial_delay > 0) {
						log.debug(`throttling ${artificial_delay}ms`);
						await wait(artificial_delay);
					}

					// Socket-scoped notification — routes to originator only, not
					// broadcast. Same helper used in `on_socket_open` so both
					// paths share one code path for send-and-log-on-failure.
					// Future work: other audiences — account-scoped,
					// ACL-filtered, broadcast — likely via a transport-level
					// policy hook.
					const notify = notify_socket(ws);

					// Per-request controller — fires on explicit `cancel` or on
					// socket close (via the socket_abort_controller chain below).
					// Registered before dispatch so a cancel arriving mid-handler
					// finds it; cleared in `finally` so late cancels for a
					// completed id (or a future request that reuses the id) can't
					// null-abort the wrong handler.
					const request_controller = new AbortController();
					pending_controllers.set(id, request_controller);
					const base: BaseHandlerContext = {
						request_id: id,
						// Populated in `onOpen` before any message can dispatch —
						// non-null assertion is safe.
						connection_id: captured_connection_id!,
						notify,
						signal: AbortSignal.any([socket_abort_controller.signal, request_controller.signal]),
					};
					const ctx = extend_context(base, c);

					try {
						const output = await handler(validated_input, ctx);

						// DEV-only output validation — catches handler bugs during development.
						if (DEV) {
							const output_parsed = spec.output.safeParse(output);
							if (!output_parsed.success) {
								log.error(`output validation failed for ${method}:`, output_parsed.error.issues);
							}
						}

						// Send result directly — null stays null, matching the HTTP RPC path.
						ws.send(JSON.stringify({jsonrpc: JSONRPC_VERSION, id, result: output}));
					} catch (error) {
						if (error instanceof ThrownJsonrpcError) {
							// Expected handler outcome (conflict, not_found, invalid_params, ...).
							// Log at debug without the stack — the throw site is part of protocol, not a bug.
							log.debug('handler error:', method, `${error.code} ${error.message}`);
						} else {
							log.error('handler error:', method, error);
						}
						ws.send(JSON.stringify(create_jsonrpc_error_response_from_thrown(id, error)));
					} finally {
						pending_controllers.delete(id);
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
