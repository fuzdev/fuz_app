/**
 * WebSocket JSON-RPC dispatch — the canonical WS transport binding.
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
 * routing to this handler (fuz_app's `require_auth` middleware). Inside the
 * dispatcher, `get_request_context(c)` is treated as guaranteed non-null and
 * per-action auth is enforced on each message.
 *
 * @module
 */

import {DEV} from 'esm-env';
import type {Context, Hono} from 'hono';
import type {UpgradeWebSocket, WSContext} from 'hono/ws';
import {wait} from '@fuzdev/fuz_util/async.js';
import {Logger, type Logger as LoggerType} from '@fuzdev/fuz_util/log.js';

import {get_request_context, has_role} from '../auth/request_context.js';
import {hash_session_token} from '../auth/session_queries.js';
import {ROLE_KEEPER} from '../auth/role_schema.js';
import {JSONRPC_VERSION, type JsonrpcRequestId} from '../http/jsonrpc.js';
import {jsonrpc_error_messages} from '../http/jsonrpc_errors.js';
import {
	create_jsonrpc_error_response,
	create_jsonrpc_error_response_from_thrown,
	create_jsonrpc_notification,
	to_jsonrpc_message_id,
	to_jsonrpc_params,
	is_jsonrpc_request,
} from '../http/jsonrpc_helpers.js';
import {CREDENTIAL_TYPE_KEY, AUTH_API_TOKEN_ID_KEY, type CredentialType} from '../hono_context.js';
import type {Uuid} from '../uuid.js';
import type {ActionSpecUnion} from './action_spec.js';
import {BackendWebsocketTransport, type ConnectionIdentity} from './transports_ws_backend.js';

/**
 * Minimum per-request context every handler receives.
 *
 * Consumers extend this with domain-specific fields via
 * `RegisterActionWsOptions.extend_context` (e.g., a `backend` singleton
 * or the authenticated `RequestContext`). Keeping the base minimal matches
 * the HTTP-side `ActionContext` (from `actions/action_rpc.ts`) and mirrors
 * Rust's `Ctx<'a>` shape (`request_id` + `NotifyFn` + `CancellationToken`).
 */
export interface BaseHandlerContext {
	/** JSON-RPC envelope request id — echoed back on the response. */
	request_id: JsonrpcRequestId;
	/**
	 * Send a request-scoped JSON-RPC notification to the originating socket.
	 * Not a broadcast — the message only reaches the client whose request
	 * triggered this handler. Streaming handlers (e.g. `completion_progress`)
	 * route chunks through this.
	 */
	notify: (method: string, params: unknown) => void;
	/** Fires on socket close; streaming handlers poll for early termination. */
	signal: AbortSignal;
}

/** Handler signature — receives validated input and per-request context. */
export type WsActionHandler<TCtx extends BaseHandlerContext> = (
	input: unknown,
	ctx: TCtx,
) => unknown;

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

/** Options for `register_action_ws`. */
export interface RegisterActionWsOptions<TCtx extends BaseHandlerContext> {
	/** Mount path (e.g., `/api/ws`). */
	path: string;
	/** The Hono app to mount on. */
	app: Hono;
	/** Hono's `upgradeWebSocket` helper from the runtime adapter. */
	upgradeWebSocket: UpgradeWebSocket;
	/** Action specs — drives method lookup, per-action auth, and input/output validation. */
	specs: ReadonlyArray<ActionSpecUnion>;
	/** Handler map keyed by `spec.method`. */
	handlers: Record<string, WsActionHandler<TCtx>>;
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
 *   via `has_role`, matching the HTTP path in `action_rpc.ts`.
 * - DEV mode validates handler output against the spec's `output` schema and
 *   warns on mismatches.
 *
 * @returns the transport (supplied or freshly created) — retain it to wire
 *   `create_ws_auth_guard` or broadcast on audit events.
 */
export const register_action_ws = <TCtx extends BaseHandlerContext>(
	options: RegisterActionWsOptions<TCtx>,
): RegisterActionWsResult => {
	const {
		path,
		app,
		upgradeWebSocket,
		specs,
		handlers,
		extend_context,
		transport = new BackendWebsocketTransport(),
		artificial_delay = 0,
		log = new Logger('[ws]'),
		on_socket_open,
		on_socket_close,
	} = options;

	// Build spec lookup for per-action auth and input validation.
	const spec_by_method = new Map(specs.map((spec) => [spec.method, spec]));

	app.get(
		path,
		upgradeWebSocket((c) => {
			// Upgrade-time auth extraction — `require_auth` middleware has already
			// rejected unauthenticated requests, so request_context is guaranteed
			// non-null by the time we get here.
			const request_context = get_request_context(c)!;
			const account_id: Uuid = request_context.account.id as Uuid;
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

			// Per-socket abort controller — fires on socket close, threaded into
			// every in-flight handler's ctx.signal on this connection. A
			// dedicated per-request controller linked to this is future work;
			// a single socket-scoped signal is sufficient today since cancel
			// granularity tracks connection lifetime, not individual requests.
			const socket_abort_controller = new AbortController();

			// Identity is assembled at upgrade time so `on_socket_close` can
			// still read it after the audit guard tears the transport record
			// down; `BackendWebsocketTransport.#revoke_connection` clears the
			// identity map before Hono fires onClose.
			const identity: ConnectionIdentity = {token_hash, account_id, api_token_id};
			// Captured on open, consumed on close. Null before onOpen fires or
			// when a consumer never opens (e.g. immediate disconnect).
			let captured_connection_id: Uuid | null = null;

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
				onOpen: async (event, ws) => {
					const connection_id = transport.add_connection(ws, token_hash, account_id, api_token_id);
					captured_connection_id = connection_id;
					log.debug('ws opened', connection_id, event);
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

					// Only handle requests (method + id). Notifications (no id) are silenced per JSON-RPC spec.
					if (!is_jsonrpc_request(json)) {
						if (typeof json === 'object' && json !== null && 'method' in json && !('id' in json)) {
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
					// broadcast. Future work: other audiences — account-scoped,
					// ACL-filtered, broadcast — likely via a transport-level
					// policy hook.
					const notify = (notify_method: string, notify_params: unknown): void => {
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

					const base: BaseHandlerContext = {
						request_id: id,
						notify,
						signal: socket_abort_controller.signal,
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
						log.error('handler error:', method, error);
						ws.send(JSON.stringify(create_jsonrpc_error_response_from_thrown(id, error)));
					}
				},
				onClose: async (event, ws) => {
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
					log.debug('ws closed', event);
				},
			};
		}),
	);

	return {transport};
};
