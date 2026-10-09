/**
 * WebSocket JSON-RPC dispatch — the low-level WS transport binding.
 *
 * Consumers declare WS endpoints on `create_app_server`'s `ws_endpoints`,
 * which mounts each through `register_ws_endpoint`
 * (`actions/register_ws_endpoint.ts`) — this function wrapped in the
 * standard upgrade stack (origin check + auth + token scope + actor
 * resolution + optional role). This module stays exported as the
 * lower-level entry point for tests that drive the dispatcher directly via
 * `create_ws_test_harness`.
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
 * ## Admission: the revocation race
 *
 * The auth middleware resolves the credential before the handshake, and the
 * socket exists only once `onOpen` fires. Every revocation (session revoke,
 * logout, password change, token revoke, account delete) closes the sockets
 * *registered* under what it revoked, so one landing in that gap would close
 * nothing, and the socket would then be admitted on the dead credential and
 * keep it: per-message dispatch re-authorizes the *actor*, never the session
 * or token — and its admission could evict a live socket of the same account
 * past the cap.
 *
 * `onOpen` closes the gap in three steps: register the connection **pending**
 * (`BackendWebsocketTransport.register_pending` — closeable by every
 * revocation, inert otherwise), re-read the credential
 * (`revalidate_resolved_auth`), then `BackendWebsocketTransport.admit`. A
 * revocation whose close ran after the registration found the pending entry,
 * so `admit` refuses; one that committed before the re-read is seen by it. The
 * cap is enforced only by `admit`, so a refused upgrade evicts nothing, and
 * pending registrations never count toward it.
 *
 * That argument needs every revocation to close only after its commit —
 * otherwise a close could miss the registration while the re-read still sees
 * the credential alive. Every one does: the revocation handlers queue their
 * close behind the commit (`queue_connection_close`), and the audit emitter
 * announces a success row to the listeners behind it too. So no interleaving
 * admits a revoked credential; `docs/security.md` §Connection Admission says
 * what that rests on.
 *
 * A refused upgrade is closed with `WS_CLOSE_SESSION_REVOKED` (4001, the
 * reason a revoked socket gets), or `WS_CLOSE_INTERNAL_ERROR` (1011) when the
 * re-read itself failed — fail closed, never admitted unchecked. The handshake
 * has already answered `101`, so a refusal can only be a close frame.
 *
 * Frames that arrive before admission are queued, not dispatched: nothing runs
 * on a credential that has not been re-read. They dispatch in arrival order
 * once the socket is admitted and `on_socket_open` has completed, and are
 * dropped unread on a refusal. The queue holds at most
 * `MAX_PRE_ADMISSION_FRAMES` frames and
 * `PRE_ADMISSION_QUEUE_BYTES_FACTOR` × `max_message_bytes` bytes; past either
 * the socket is closed.
 *
 * The upgrade's role gate is *not* re-read: a role revocation closes no
 * WebSocket in the first place (per-message dispatch re-reads role grants).
 *
 * ## A server-closed socket dispatches nothing
 *
 * A runtime adapter can keep delivering inbound frames after the server calls
 * `ws.close(…)`, until the close handshake completes (`@hono/node-ws` does —
 * up to the `ws` close timeout when the client withholds its close frame).
 * So every server-side close — revocation, cap eviction, heartbeat timeout,
 * an oversized message, a refused admission — removes the connection from the
 * transport and aborts the socket's signal *at close time*, and `onMessage`
 * drops any frame on a socket that has ended. A connection the transport no
 * longer holds though nothing closed its socket (a bare `remove_connection`)
 * is ended on its next frame (`BackendWebsocketTransport.is_registered`), with
 * `WS_CLOSE_INTERNAL_ERROR` — it must not linger as a socket that reads
 * everything and answers nothing.
 *
 * @module
 */

import type { Hono } from 'hono';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';
import { wait } from '@fuzdev/fuz_util/async.ts';
import { Logger, type Logger as LoggerType } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import {
	get_request_context,
	require_request_context,
	token_scope_surface_denial,
	type RequestContext
} from '../auth/request_context.ts';
import { get_resolved_auth, revalidate_resolved_auth } from '../auth/resolved_auth.ts';
import { get_client_ip } from '../http/client_ip.ts';
import { flush_pending_effects, flush_post_commit_effects } from '../http/pending_effects.ts';
import type { RateLimiter } from '../rate_limiter.ts';
import {
	JsonrpcRequest,
	type JsonrpcErrorResponse,
	type JsonrpcRequestId,
	type JsonrpcResponse
} from '../http/jsonrpc.ts';
import { dev_only, jsonrpc_error_messages } from '../http/jsonrpc_errors.ts';
import {
	create_jsonrpc_error_response,
	create_jsonrpc_notification,
	to_jsonrpc_envelope_id,
	to_jsonrpc_message_id,
	to_jsonrpc_params,
	is_jsonrpc_object,
	is_jsonrpc_request,
	is_jsonrpc_request_id
} from '../http/jsonrpc_helpers.ts';
import { TOKEN_SCOPE_KEY, TEST_CONTEXT_PRESET_KEY } from '../hono_context.ts';
import type { Db } from '../db/db.ts';
import { type Action } from './action_types.ts';
import { compile_action_registry } from './compile_action_registry.ts';
import type { RealtimeCloser } from './connection_closer.ts';
import { cancel_action_spec, CancelNotificationParams } from './cancel.ts';
import {
	DEFAULT_WS_MAX_MESSAGE_BYTES,
	WS_CLOSE_INTERNAL_ERROR,
	WS_CLOSE_MESSAGE_TOO_BIG,
	WS_CLOSE_POLICY_VIOLATION,
	WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT,
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SESSION_REVOKED_REASON,
	utf8_length,
	utf8_length_over
} from './transports.ts';
import { BackendWebsocketTransport, type ConnectionIdentity } from './transports_ws_backend.ts';
import { audit_unmatched_peer_response, type RequestClient } from './peer_request.ts';
import { perform_action, perform_action_result_to_envelope } from './perform_action.ts';

/** Default inactivity window before the server closes a silent socket. */
export const DEFAULT_SERVER_HEARTBEAT_TIMEOUT = 60_000;

/**
 * Max inbound frames one socket may have queued while it is still opening —
 * between the handshake and the end of the credential re-check plus
 * `on_socket_open`. One more closes the socket with
 * `WS_CLOSE_POLICY_VIOLATION`.
 *
 * Frames sent before the socket is open wait rather than dispatch (nothing
 * runs on a credential that has not been re-read), and a runtime adapter hands
 * them over with no backpressure, so the wait needs a bound. This is the count
 * half; `PRE_ADMISSION_QUEUE_BYTES_FACTOR` is the byte half.
 *
 * Sized so a client flushing its durable queue on reopen never meets it at the
 * default `DEFAULT_QUEUE_MAX_SIZE` (`actions/socket.svelte.ts`). A consumer
 * that raises the client's queue above this cap makes a full flush overflow
 * it: the socket closes with `WS_CLOSE_POLICY_VIOLATION`, the flushed requests
 * fail, and the client reconnects.
 */
export const MAX_PRE_ADMISSION_FRAMES = 256;

/**
 * The byte budget of one socket's pre-admission queue, as a multiple of the
 * endpoint's `max_message_bytes`: the frames queued while the socket is still
 * opening may total at most this many maximum-size messages. The frame that
 * would pass it closes the socket with `WS_CLOSE_POLICY_VIOLATION`.
 *
 * The count cap alone (`MAX_PRE_ADMISSION_FRAMES`) would let each pending
 * socket hold that many full-size messages, and pending sockets are not
 * capped per account — a registration that is never admitted must not be able
 * to pin that much memory. Small requests, which is what a client flushes on
 * reopen, meet the count cap long before this one.
 *
 * A client whose queued requests total more than this budget and flushes
 * them all on reopen overflows it: the socket closes, the flushed requests
 * fail, and the client reconnects.
 */
export const PRE_ADMISSION_QUEUE_BYTES_FACTOR = 4;

/**
 * The close reason sent with `WS_CLOSE_POLICY_VIOLATION` when a socket
 * overflows its pre-admission queue, by count or by bytes.
 */
export const WS_CLOSE_PRE_ADMISSION_OVERFLOW_REASON = 'too much sent before the socket opened';

/** Send one JSON-RPC error response frame on `ws`. */
const send_error_response = (
	ws: WSContext,
	id: JsonrpcErrorResponse['id'],
	error: JsonrpcErrorResponse['error']
): void => {
	ws.send(JSON.stringify(create_jsonrpc_error_response(id, error)));
};

/**
 * Whether a frame is a reply to a server-initiated request, in the shape the
 * Rust twin's `classify` accepts: `jsonrpc: '2.0'`, **no** string `method`, a
 * string/number `id`, and exactly one of `result` / `error`.
 *
 * The method axis is string-typed like the twin, whose
 * `obj.get("method").and_then(Value::as_str)` reads a present-but-non-string
 * `method` as absent — so `{id, method: 123, result}` is a response on both
 * sides, not a request. The `result` / `error` XOR likewise refuses a frame
 * carrying both, so neither side has to pick a winner between them.
 *
 * Deliberately narrower than the `is_jsonrpc_response` /
 * `is_jsonrpc_error_response` guards, which only ask for a version, an `id`,
 * and a `result` or `error` — those stay loose because a client matching a
 * reply must still recognize an error response carrying `id: null`. Here a
 * loose match would swallow hybrids the twin answers: `{method, id, result}`
 * is a request the dispatcher should run, and `{id, result, error}` or a
 * boolean `id` is `invalid_request`. Everything this rejects falls through to
 * the version guard / notification / envelope steps below.
 */
const is_peer_response = (json: unknown): json is JsonrpcResponse | JsonrpcErrorResponse => {
	if (!is_jsonrpc_object(json)) return false;
	if (typeof (json as { method?: unknown }).method === 'string') return false;
	if (!is_jsonrpc_request_id((json as { id?: unknown }).id)) return false;
	return 'result' in json !== 'error' in json;
};

/**
 * Context passed to the `on_socket_open` hook.
 *
 * Fires once the connection is **admitted** — registered in the transport and
 * its credential re-checked (so `connection_id` is valid, and broadcasts reach
 * it) — and before any client message dispatches. A socket refused at
 * admission never reaches it. Consumers use this to bootstrap per-socket
 * domain state — e.g. spawning a per-account unit and pushing an initial state
 * snapshot.
 */
export interface SocketOpenContext {
	/** The raw WebSocket context — exposed for edge cases; prefer `notify` for sends. */
	ws: WSContext;
	/** Connection id assigned by `BackendWebsocketTransport.register_pending`. */
	connection_id: Uuid;
	/** Auth identity registered for this connection. */
	identity: ConnectionIdentity;
	/**
	 * Send a JSON-RPC notification to just this socket. Mirrors `ctx.notify`
	 * on per-message handler contexts — same socket-scoped semantics.
	 */
	notify: (method: string, params: unknown) => void;
	/**
	 * Fires when this socket ends — the client closed it, or the server did
	 * (revocation, cap eviction, heartbeat timeout), at the moment the server
	 * closes rather than when the close handshake lands. Threaded through to
	 * every handler's `ctx.signal`.
	 */
	signal: AbortSignal;
}

/**
 * Context passed to the `on_socket_close` hook.
 *
 * Fires after the transport has removed the connection — `connection_id` and
 * `identity` are the values captured at open, so consumer cleanup reads them
 * from here, not from the transport. Fires for both client-initiated closes
 * (Hono onClose) and server-initiated closes — a revocation, the per-account
 * connection cap's eviction, and a heartbeat timeout all call `ws.close()`,
 * which triggers Hono's onClose. Fires only for a socket that was admitted: one
 * refused at admission never ran `on_socket_open`, so it has no close hook
 * either.
 */
export interface SocketCloseContext {
	/**
	 * The WebSocket context the close event carried. Not necessarily the object
	 * `on_socket_open` received — an adapter may build one per event — so key
	 * per-socket state on `connection_id`.
	 */
	ws: WSContext;
	/** Connection id captured at open time. */
	connection_id: Uuid;
	/** Auth identity captured at open time — the transport no longer holds it. */
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
	 * The backend's closer — `deps.connection_closer`. This endpoint's
	 * transport is added to it, so every revocation handler's close reaches
	 * the sockets opened here. Required so it can't be forgotten: left out of
	 * the closer, a transport's sockets close only through the audit listener,
	 * which a failed audit write or a session / token cap eviction never
	 * reaches. Pass `null` only when no revocation has to reach this transport
	 * (a harness driving the dispatcher directly), or when the transport was
	 * added by hand.
	 *
	 * The transport is added once the mount succeeds, so a mount that throws
	 * adds nothing. The addition is permanent — its remover is not returned.
	 * A caller that must release the membership (as `create_app_server` does
	 * on close) passes `null` and adds the transport itself, holding the
	 * remover `RealtimeCloser.add` returns.
	 */
	connection_closer: RealtimeCloser | null;
	/**
	 * Per-account connection cap for the transport this call creates — see
	 * `BackendWebsocketTransportOptions.max_connections_per_account`
	 * (evict-oldest, closing with `WS_CLOSE_CONNECTION_LIMIT`; `null`
	 * disables). Rejected alongside `transport`: a supplied transport carries
	 * its own cap, set where it was constructed.
	 *
	 * @default DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT
	 */
	max_connections_per_account?: number | null;
	/**
	 * Server-side heartbeat policy. Default-on (receive-silence detection,
	 * 60s timeout). `false` disables the timer entirely — only do this if
	 * the upstream stack (TCP keepalive, Cloudflare idle timeout, etc.)
	 * already owns disconnect detection. Pass an object to tune the timeout.
	 */
	heartbeat?: boolean | ServerHeartbeatOptions;
	/** Optional per-message delay for testing loading states. Ignored when `0`. */
	artificial_delay?: number;
	/**
	 * Cap on one inbound message, in bytes (UTF-8 for text frames). A larger
	 * message closes the socket with `WS_CLOSE_MESSAGE_TOO_BIG` before it's
	 * parsed — there's no per-message error reply, matching the Rust spine.
	 * The cap is checked after the runtime adapter has buffered the message,
	 * so it bounds dispatch work, not memory; bound the adapter's own frame
	 * limit too (e.g. `ws`'s `maxPayload`) where memory matters. A consumer
	 * that raises it passes the same value to the client's
	 * `FrontendWebsocketTransportOptions.max_message_bytes`.
	 *
	 * @default DEFAULT_WS_MAX_MESSAGE_BYTES
	 */
	max_message_bytes?: number;
	/** Optional logger; defaults to `[ws]` namespace. */
	log?: LoggerType;
	/**
	 * Called once per socket, after the connection is admitted (module doc,
	 * "Admission"). Awaited before any inbound frame is dispatched — every
	 * frame the client sends meanwhile waits in arrival order, replies to
	 * server-initiated requests included: a hook that awaits
	 * `transport.request_connection` on its own connection gets no reply until
	 * it returns, so start such a request without awaiting it. Throwing logs an
	 * error and closes the socket with an `internal_error` frame and
	 * `WS_CLOSE_INTERNAL_ERROR` — a failing bootstrap should not leave a
	 * partially-initialized socket alive.
	 */
	on_socket_open?: (ctx: SocketOpenContext) => void | Promise<void>;
	/**
	 * Called once per admitted socket on close, *after* the transport has
	 * removed the connection — a slow hook never holds a dead entry that
	 * broadcasts still target and the per-account cap still counts. Receives
	 * `connection_id` and `identity` captured at open time, the same whether the
	 * close came from the client, a revocation, or a connection-cap eviction.
	 * Errors are logged and swallowed.
	 */
	on_socket_close?: (ctx: SocketCloseContext) => void | Promise<void>;
	/**
	 * Per-IP rate limiter consulted for actions whose spec declares
	 * `rate_limit: 'ip'` or `'both'`, keyed on the client IP read at upgrade
	 * time. Required, with no default: pass `null` to turn the IP check off,
	 * so an unthrottled socket is a choice the call site states rather than
	 * an option it forgot. Share one instance with the HTTP RPC dispatcher so
	 * one budget covers both transports per action — `create_app_server`
	 * does, for the endpoints it mounts from `ws_endpoints`.
	 */
	action_ip_rate_limiter: RateLimiter | null;
	/**
	 * Per-account rate limiter consulted for actions whose spec declares
	 * `rate_limit: 'account'` or `'both'`. Keyed on
	 * `request_context.account.id`. Required, with no default: pass `null`
	 * to turn the account check off. Share one instance with the HTTP RPC
	 * dispatcher.
	 */
	action_account_rate_limiter: RateLimiter | null;
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
 * - Per-message dispatch goes through `perform_action`: pre-authorization
 *   auth (401) → authorization phase → post-authorization auth (403) →
 *   rate limit (429) → input validation (400) → handler (with transaction
 *   wrap iff `spec.side_effects: true`) → DEV output validation.
 * - Authorization phase runs **per message** — role_grant changes during a
 *   connection lifetime are picked up on the next message without any
 *   in-place refresh. Authentication invalidation closes the socket: the
 *   revocation handlers through `connection_closer`, and `create_ws_auth_guard`
 *   on the audit row.
 * - Admission re-reads the credential once, after the handshake: a socket
 *   whose session or token was revoked while it was upgrading closes with
 *   `WS_CLOSE_SESSION_REVOKED`, and one whose re-check failed with
 *   `WS_CLOSE_INTERNAL_ERROR`. Frames sent before admission wait for it.
 * - A socket the server has closed dispatches nothing more, whether or not
 *   its client answers the close.
 *
 * @returns the transport (supplied or freshly created) — retain it to wire
 *   `create_ws_auth_guard` or broadcast on audit events.
 * @mutates options.app - registers a `GET path` route via `upgradeWebSocket`
 * @mutates options.transport - per socket, registers, admits, and removes a
 *   connection via `register_pending` / `admit` / `remove_connection`
 * @mutates options.connection_closer - adds the endpoint's transport, once the
 *   mount has succeeded
 * @throws Error when `max_connections_per_account` is passed alongside
 *   `transport`, or is neither `null` nor a positive integer, or when
 *   `actions` fails to compile (`compile_action_registry`)
 */
export const register_action_ws = (options: RegisterActionWsOptions): RegisterActionWsResult => {
	if (options.transport && options.max_connections_per_account !== undefined) {
		// a cap that silently did nothing would read as enforced
		throw new Error(
			`register_action_ws: max_connections_per_account configures the transport created for ${options.path}, ` +
				'but a transport was supplied — set the cap on that BackendWebsocketTransport instead'
		);
	}
	const {
		path,
		app,
		upgradeWebSocket,
		actions,
		db,
		heartbeat = true,
		artificial_delay = 0,
		max_message_bytes = DEFAULT_WS_MAX_MESSAGE_BYTES,
		log = new Logger('[ws]'),
		on_socket_open,
		on_socket_close,
		action_ip_rate_limiter,
		action_account_rate_limiter
	} = options;

	const transport =
		options.transport ??
		new BackendWebsocketTransport({
			max_connections_per_account: options.max_connections_per_account,
			log
		});

	// Build the dispatcher's per-method lookup. Only request_response
	// specs with a handler reach `action_map` — perform_action is the
	// only site that calls handlers, and it requires an `RpcAction`.
	// Other kinds (`remote_notification` like `cancel`, `local_call`)
	// are registry-only on WS; the cancel handler reads
	// `cancel_action_spec.method` directly.
	const { action_map } = compile_action_registry(actions, 'WS action');

	const pre_admission_queue_max_bytes = PRE_ADMISSION_QUEUE_BYTES_FACTOR * max_message_bytes;

	const heartbeat_enabled = heartbeat !== false;
	const heartbeat_config = typeof heartbeat === 'object' ? heartbeat : {};
	const heartbeat_timeout = heartbeat_config.timeout ?? DEFAULT_SERVER_HEARTBEAT_TIMEOUT;
	// Run the checker on timeout/2 so event-loop blockage pauses the timer
	// itself — a dead-because-blocked socket is close enough to
	// dead-because-unresponsive that closing is arguably correct.
	const heartbeat_tick_interval = Math.max(100, Math.floor(heartbeat_timeout / 2));

	app.get(
		path,
		// Token-scope surface gate — a narrowed token cannot hold a socket.
		//
		// Mounted as pre-upgrade middleware rather than inside the
		// `upgradeWebSocket` callback, which must return `WSEvents` and so has no
		// way to produce a denial response.
		//
		// Rule 3, doing real work rather than being conservative for its own
		// sake: server-initiated pushes (broadcasts, role-grant-offer
		// notifications, peer requests) reach whatever the account's connection
		// reaches, and there is no per-recipient filter to narrow them by. So a
		// scoped token that could upgrade would observe far more than it was
		// granted.
		async (c, next) => {
			const denied = token_scope_surface_denial(c, 'surface:ws_upgrade');
			if (denied) return denied;
			return next();
		},
		upgradeWebSocket((c) => {
			// Upgrade-time identity capture. `require_auth` middleware has
			// already rejected unauthenticated upgrades, so request_context is
			// non-null here. Per-message dispatch reads `account_id` +
			// `credential_type` from this closure; the live request_context is
			// only used by the test-preset escape hatch (perform_action runs
			// the authorization phase fresh on every message in production).
			//
			// Session / token validity is read here, by the auth middleware,
			// and re-read once at admission (`onOpen` below) — never per
			// message: per-message dispatch reloads role_grants via the
			// authorization phase and nothing else. From admission on,
			// revocation enforcement lives outside this dispatcher: the
			// revocation handlers close through `deps.connection_closer`
			// (which holds this endpoint's transport — see the
			// `connection_closer` option), and the audit-driven WS auth guard
			// (`transports_ws_auth_guard.ts`) repeats the close. With neither
			// reaching this transport, `session_revoke` / `token_revoke` are
			// no-ops for connections that are already open.
			const upgrade_context = require_request_context(c);
			const account_id: Uuid = upgrade_context.account.id;
			const client_ip = get_client_ip(c);
			// The credential the auth middleware resolved — the one derivation
			// both long-lived transports share (`get_resolved_auth`), read off
			// the keys the middleware set rather than re-derived here, so a
			// custom session context key or a daemon token riding beside a
			// session cookie can't make this path disagree with the middleware.
			// Fail closed: no credential, or one on another account than the
			// request context's, never reaches the upgrade.
			const resolved = get_resolved_auth(c);
			if (resolved === null) {
				throw new Error(
					`register_action_ws: no resolved credential for the upgrade on ${path} — is the auth middleware wired?`
				);
			}
			if (resolved.account_id !== account_id) {
				throw new Error(
					`register_action_ws: the credential and the request context name different accounts for the upgrade on ${path}`
				);
			}
			const { credential_type } = resolved;
			// Captured at upgrade and consulted per message. Rule 3 rejects a
			// narrowed token at the boundary below, so in practice this is always
			// `full` on a live socket — but the per-message gate runs regardless,
			// so the invariant is enforced rather than assumed.
			const token_scope = c.get(TOKEN_SCOPE_KEY) ?? null;
			// Session-based connections have a token hash for targeted revocation.
			// Bearer/daemon connections pass null — still reachable via
			// `close_sockets_for_account` / `close_sockets_for_token`. A session
			// credential with no hash on the context is a shape the middleware
			// never builds; the admission re-read refuses it.
			const { token_hash } = resolved;
			// `api_token.id` — set only for bearer connections; enables
			// `close_sockets_for_token` to tear down just this socket on
			// `token_revoke` without affecting the account's other sockets.
			const { api_token_id } = resolved;

			// Test escape hatch — captured once at upgrade. perform_action
			// honors it per-message so harnesses with pre-baked
			// `RequestContext` skip the live authorization phase. It skips the
			// admission re-read for the same reason: a pre-baked credential has
			// no session, token, or account row to re-read.
			const upgrade_preset: { request_context: RequestContext | null } | undefined = c.get(
				TEST_CONTEXT_PRESET_KEY
			)
				? { request_context: get_request_context(c) }
				: undefined;

			// Per-socket abort controller — fires when the socket ends, chained
			// into every in-flight handler's per-request controller via
			// `AbortSignal.any`. Keeping both signals lets the client
			// cancel-one-request-by-id (via the `cancel` notification) without
			// tearing down the whole socket. Registered with the transport, which
			// aborts it when it closes the connection (revocation, cap eviction),
			// and aborted here on every other end (`end_socket`, `onClose`) — at
			// close time, not when the close handshake lands.
			const socket_abort_controller = new AbortController();
			// Per-request controllers keyed by JSON-RPC request id — lets an
			// incoming `cancel` notification abort just the matching handler.
			// Populated on request dispatch, cleared in the handler's `finally`
			// so a late-arriving cancel for a completed id (or a reused id)
			// can't null-abort a freshly-arrived request. Idempotent: cancel
			// for unknown ids no-ops.
			const pending_controllers: Map<JsonrpcRequestId, AbortController> = new Map();

			// Identity is assembled at upgrade time so `on_socket_close` can
			// read it — by the time the hook runs the transport record is gone,
			// removed in `onClose` or earlier by a revocation, a connection-cap
			// eviction, or another server-side close.
			const identity: ConnectionIdentity = { token_hash, account_id, api_token_id };
			// Captured on open, consumed on close. Undefined before onOpen
			// fires or when a consumer never opens (e.g. immediate disconnect).
			let captured_connection_id: Uuid | undefined;

			// Where the socket is in its life:
			// - `opening` — from the handshake until admission and `on_socket_open`
			//   have both completed. Inbound frames are queued.
			// - `open` — admitted; inbound frames dispatch.
			// - `ended` — the client closed it, the server closed it, or it was
			//   refused at admission. Inbound frames are dropped: an adapter can
			//   keep delivering them until the close handshake lands.
			let phase: 'opening' | 'open' | 'ended' = 'opening';
			// read through a function so a check after an `await` isn't narrowed
			// to the value assigned before it
			const phase_is = (expected: typeof phase): boolean => phase === expected;
			// Whether the connection was ever admitted — gates `on_socket_close`,
			// the counterpart of an `on_socket_open` a refused socket never ran.
			let was_admitted = false;

			// Frames received while `opening`, in arrival order — dispatched once
			// the socket is open, dropped if it ends first. Each carries the
			// settlers of the promise its `onMessage` call returned, so a caller
			// awaiting that call (the test harnesses do) resumes when the frame
			// has been dispatched or dropped.
			const queued_frames: Array<{
				data: unknown;
				ws: WSContext;
				resolve: () => void;
				reject: (reason: unknown) => void;
			}> = [];
			// bytes queued so far, against `pre_admission_queue_max_bytes` — only
			// read while the socket is opening, so never reset
			let queued_bytes = 0;
			const drop_queued_frames = (): void => {
				for (const frame of queued_frames.splice(0)) frame.resolve();
			};

			// Receive-silence watchdog. Seeded at admission so the first window is
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

			// The one place a socket's end is recorded, whoever ended it — the
			// transport (revocation, cap eviction), `end_socket`, or `onClose` all
			// abort this controller.
			socket_abort_controller.signal.addEventListener(
				'abort',
				() => {
					phase = 'ended';
					stop_heartbeat_timer();
					drop_queued_frames();
				},
				{ once: true }
			);

			// End the socket from the server side: unregister it and abort its
			// signal *now* — so nothing more dispatches and in-flight handlers
			// see `signal.aborted` while the close handshake is still in flight —
			// then send the close frame.
			const end_socket = (ws: WSContext, code: number, reason: string): void => {
				if (captured_connection_id !== undefined) {
					transport.remove_connection(captured_connection_id);
				}
				socket_abort_controller.abort();
				try {
					ws.close(code, reason);
				} catch (error) {
					log.error(`ws close ${code} failed:`, error);
				}
			};

			// Refuse an upgrade at admission. A socket that already ended needs no
			// close frame: either a revocation closed its pending registration (the
			// transport sent the 4001) or the client went away.
			const refuse_upgrade = (ws: WSContext, code: number, reason: string): void => {
				if (captured_connection_id !== undefined) {
					transport.remove_connection(captured_connection_id);
				}
				if (!socket_abort_controller.signal.aborted) end_socket(ws, code, reason);
			};

			// Socket-scoped notification helper — routes to this socket only,
			// matches the `ctx.notify` semantics exposed to per-message handlers.
			const notify_socket =
				(ws: WSContext) =>
				(notify_method: string, notify_params: unknown): void => {
					try {
						const notification = create_jsonrpc_notification(
							notify_method,
							to_jsonrpc_params(notify_params)
						);
						ws.send(JSON.stringify(notification));
					} catch (error) {
						log.error('notify send failed:', notify_method, error);
					}
				};

			// Admit the upgraded socket: register it pending, re-check its
			// credential, admit it (module doc, "Admission: the revocation
			// race"). Returns the connection id once admitted, or `null` after
			// refusing — the socket is then already closed.
			const admit_upgrade = async (ws: WSContext): Promise<Uuid | null> => {
				// Pending first, synchronously: from here every revocation finds it.
				const connection_id = transport.register_pending(
					ws,
					token_hash,
					account_id,
					api_token_id,
					socket_abort_controller
				);
				captured_connection_id = connection_id;

				if (!upgrade_preset) {
					let credential_is_live: boolean;
					try {
						// pool-level `db`: the statements must see every revocation
						// committed before they start
						credential_is_live = await revalidate_resolved_auth({ db }, resolved);
					} catch (error) {
						// fail closed — never admitted unchecked
						log.error('ws upgrade admission: credential re-check failed', error);
						refuse_upgrade(ws, WS_CLOSE_INTERNAL_ERROR, 'internal error');
						return null;
					}
					if (!credential_is_live) {
						log.info(
							'ws upgrade admission: credential revoked during the upgrade',
							connection_id,
							account_id
						);
						refuse_upgrade(ws, WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON);
						return null;
					}
				}

				// The cap's eviction happens here, after every gate and the re-read,
				// so a refused upgrade never closes someone else's socket.
				if (!transport.admit(connection_id)) {
					log.info(
						'ws upgrade admission: closed by a revocation while pending',
						connection_id,
						account_id
					);
					refuse_upgrade(ws, WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON);
					return null;
				}
				was_admitted = true;
				return connection_id;
			};

			const open_socket = async (ws: WSContext): Promise<void> => {
				const connection_id = await admit_upgrade(ws);
				if (connection_id === null) return;
				log.debug('ws opened', connection_id);
				// Not on a socket that ended in the tick since `admit` (a revocation
				// can land there): its abort listener has already run, so nothing
				// would ever stop the timer.
				if (heartbeat_enabled && !phase_is('ended')) {
					last_receive_time = Date.now();
					heartbeat_timer = setInterval(() => {
						const now = Date.now();
						const silence = now - last_receive_time;
						if (silence >= heartbeat_timeout) {
							log.info(
								`heartbeat timeout (${silence}ms) — closing ${WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT}`,
								connection_id,
								identity.account_id
							);
							stop_heartbeat_timer();
							end_socket(ws, WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT, 'server heartbeat timeout');
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
							signal: socket_abort_controller.signal
						});
					} catch (error) {
						log.error('on_socket_open failed — closing socket:', error);
						// an ended socket has no one to tell
						if (phase_is('ended')) return;
						try {
							send_error_response(ws, null, jsonrpc_error_messages.internal_error());
						} catch {
							// ignore — socket may already be dead
						}
						end_socket(ws, WS_CLOSE_INTERNAL_ERROR, 'socket bootstrap failed');
						return;
					}
				}
				// Ended while the hook ran (a revocation, the client leaving) — the
				// queue is already dropped.
				if (!phase_is('opening')) return;
				// Open: dispatch what arrived meanwhile, in arrival order and back
				// to back, the way the adapter would have delivered it.
				phase = 'open';
				for (const frame of queued_frames.splice(0)) {
					if (transport.is_registered(connection_id)) {
						handle_frame(frame.data, frame.ws, connection_id).then(frame.resolve, frame.reject);
					} else {
						frame.resolve();
					}
				}
			};

			// Dispatch one inbound frame on an admitted, still-registered
			// connection.
			const handle_frame = async (
				data: unknown,
				ws: WSContext,
				connection_id: Uuid
			): Promise<void> => {
				let json;
				try {
					json = JSON.parse(String(data));
				} catch (error) {
					log.error('JSON parse error:', error);
					send_error_response(ws, null, jsonrpc_error_messages.parse_error());
					return;
				}

				// Batch JSON-RPC is not supported on the WebSocket path.
				if (Array.isArray(json)) {
					send_error_response(
						ws,
						null,
						jsonrpc_error_messages.invalid_request(
							'batch JSON-RPC requests are not supported on WebSocket'
						)
					);
					return;
				}

				// Inbound responses to server-initiated requests (`peer/ping`,
				// etc.) — route to the pending-request registry scoped to THIS
				// socket. A response carries a string/number `id`, exactly one
				// of `result` / `error`, and no string `method`, so it precedes the
				// request/notification split below. An unmatched id
				// (unsolicited, cross-connection, or already settled) resolves
				// nothing and is dropped, so the read loop survives a junk
				// frame.
				if (is_peer_response(json)) {
					const matched = transport.resolve_peer_response(connection_id, json);
					if (!matched) audit_unmatched_peer_response(log, connection_id, json.id);
					return;
				}

				// Envelope version — the first thing the Rust twin's `classify`
				// checks (version → id → method → params). A frame without
				// `jsonrpc: '2.0'` is `invalid_request` on both transports
				// rather than falling through to the notification branch,
				// which would silently drop `{method: 'x'}` and
				// `{jsonrpc: '1.0', method: 'x'}`. It also covers a
				// non-object frame (a scalar has no id to echo — `id: null`).
				// A genuine peer response carries the version and is matched
				// above; a response-shaped frame that misses that shape check
				// falls through here on purpose, so it is answered rather
				// than swallowed.
				if (!is_jsonrpc_object(json)) {
					send_error_response(
						ws,
						to_jsonrpc_envelope_id(json),
						jsonrpc_error_messages.invalid_request()
					);
					return;
				}

				// Notifications (string method + no id) — `cancel` is
				// intercepted for request-scoped cancellation; other
				// notifications are silenced per JSON-RPC spec (consumer
				// notification handlers are not a feature yet). The method
				// axis is string-typed like the twin's `classify`, so a
				// non-string `method` is answered `invalid_request` below
				// rather than silently dropped as a notification.
				if (!is_jsonrpc_request(json)) {
					const notification_method = (json as { method?: unknown }).method;
					if (typeof notification_method === 'string' && !('id' in json)) {
						if (notification_method === cancel_action_spec.method) {
							const parsed = CancelNotificationParams.safeParse(
								(json as { params?: unknown }).params
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
					send_error_response(
						ws,
						to_jsonrpc_message_id(json),
						jsonrpc_error_messages.invalid_request()
					);
					return;
				}

				// Envelope validation — the same `JsonrpcRequest.safeParse` the
				// HTTP POST path runs, so a malformed envelope (`params: null`,
				// an array `params`, a boolean `id`) answers `invalid_request`
				// on both transports instead of reaching the dispatcher and
				// surfacing as `invalid_params`. It sits after the
				// notification / cancel block so notifications stay
				// unvalidated (they carry no id to echo) and `cancel` routing
				// precedes it.
				const envelope = JsonrpcRequest.safeParse(json);
				if (!envelope.success) {
					send_error_response(
						ws,
						to_jsonrpc_message_id(json),
						jsonrpc_error_messages.invalid_request(dev_only({ issues: envelope.error.issues }))
					);
					return;
				}

				const { method, id, params } = envelope.data;

				// Per-action method lookup — return method_not_found before
				// we engage the dispatch machinery. Specs without a handler
				// (client-only / dispatcher-handled) miss action_map and
				// surface as method_not_found just like unknown methods.
				const action = action_map.get(method);
				if (!action) {
					send_error_response(ws, id, jsonrpc_error_messages.method_not_found(method));
					return;
				}

				if (artificial_delay > 0) {
					log.debug(`throttling ${artificial_delay}ms`);
					await wait(artificial_delay);
				}

				// Per-request controller — fires on explicit `cancel` or when the
				// socket ends (via the socket_abort_controller chain below).
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
				// Ordering invariant — the deferred queue starts first. Its
				// thunks are invoked before the eager writes are awaited, so
				// a revocation's close never waits on the audit INSERT: held
				// behind a slow write, the socket would stay open on a
				// credential already committed gone, and its next frame
				// would be dispatched. The thunks that need a write (a
				// success row's listener fan-out) await it themselves.
				//
				// Ordering invariant — reply-before-flush is load-bearing.
				// A handler that revokes its own credential
				// (`session_revoke_all`, `token_revoke` of the calling
				// bearer) queues a close of this very socket on
				// `post_commit_effects` (`queue_connection_close`), and
				// the audit listeners repeat it from the same queue. The
				// `ws.send` on the success path runs before the `finally`
				// flushes that queue, so the caller reads its reply and
				// then the 4001 close. Inverting the order — flushing the
				// queues before the send — would strand the caller without
				// a reply.
				const pending_effects: Array<Promise<void>> = [];
				const post_commit_effects: Array<() => void | Promise<void>> = [];

				const notify = notify_socket(ws);
				// Server→client request seam (ActionPeer) — closes over this
				// socket's connection_id so a handler can initiate a request to
				// the originating client and await the reply.
				const request_client: RequestClient = (request_method, request_params, request_options) =>
					transport.request_connection(
						connection_id,
						request_method,
						request_params,
						request_options
					);
				const signal = AbortSignal.any([socket_abort_controller.signal, request_controller.signal]);

				try {
					const result = await perform_action(
						{
							action,
							raw_params: params,
							request_id: id,
							account_id,
							credential_type,
							token_scope,
							client_ip,
							signal,
							notify,
							connection_id,
							request_client,
							preset: upgrade_preset
						},
						{
							db,
							pending_effects,
							post_commit_effects,
							log,
							action_ip_rate_limiter,
							action_account_rate_limiter
						}
					);
					let frame: string;
					try {
						frame = JSON.stringify(perform_action_result_to_envelope(id, result));
					} catch (error) {
						// The handler's output is not JSON (a `bigint`, a cycle). Answer
						// `internal_error` rather than throwing: the adapter does not await
						// this promise, so a rejection here is unhandled, and the caller
						// would get no reply to a request that did run.
						log.error(`action result is not serializable: ${method}`, error);
						frame = JSON.stringify(
							create_jsonrpc_error_response(
								id,
								jsonrpc_error_messages.internal_error(
									dev_only(error instanceof Error ? error.message : undefined)
								)
							)
						);
					}
					ws.send(frame);
				} finally {
					pending_controllers.delete(id);
					// deferred first — see the ordering invariant above
					const deferred = flush_post_commit_effects(post_commit_effects, log);
					await flush_pending_effects(pending_effects, log);
					await deferred;
				}
			};

			return {
				onOpen: async (_event, ws) => {
					// An adapter may not await this (`@hono/node-ws` doesn't), so it
					// must never reject.
					try {
						await open_socket(ws);
					} catch (error) {
						log.error('ws open failed — closing socket:', error);
						refuse_upgrade(ws, WS_CLOSE_INTERNAL_ERROR, 'internal error');
					}
				},
				onMessage: (event, ws): void | Promise<void> => {
					// A socket the server closed — or refused — dispatches nothing
					// more, however long its client withholds the close frame.
					if (phase_is('ended')) return;
					const size = ws_message_size_over(event.data, max_message_bytes);
					if (size !== null) {
						log.warn(
							`closing socket: ${size}-byte message exceeds the ${max_message_bytes}-byte cap`
						);
						end_socket(ws, WS_CLOSE_MESSAGE_TOO_BIG, 'message too big');
						return;
					}
					if (phase_is('opening')) {
						// Not open yet: queue, never dispatch — nothing runs on a
						// credential that has not been re-read. Bounded by count and
						// by bytes, since the adapter applies no backpressure.
						const bytes = ws_message_size(event.data);
						if (
							queued_frames.length >= MAX_PRE_ADMISSION_FRAMES ||
							queued_bytes + bytes > pre_admission_queue_max_bytes
						) {
							log.warn(
								`closing socket: pre-admission queue overflow (${queued_frames.length} frames, ${queued_bytes} + ${bytes} bytes)`
							);
							end_socket(ws, WS_CLOSE_POLICY_VIOLATION, WS_CLOSE_PRE_ADMISSION_OVERFLOW_REASON);
							return;
						}
						queued_bytes += bytes;
						last_receive_time = Date.now();
						return new Promise<void>((resolve, reject) => {
							queued_frames.push({ data: event.data, ws, resolve, reject });
						});
					}
					// The transport is the authority on whether the connection is
					// still live. A close it made (revocation, cap eviction) ended the
					// socket above; a connection it no longer holds though nothing
					// closed the socket — a bare `remove_connection` — is ended here,
					// rather than left reading every frame and answering none, where
					// a chatty client would also keep the heartbeat from reaping it.
					const connection_id = captured_connection_id;
					if (connection_id === undefined || !transport.is_registered(connection_id)) {
						log.warn('closing socket: its connection is no longer registered', connection_id);
						end_socket(ws, WS_CLOSE_INTERNAL_ERROR, 'connection unregistered');
						return;
					}
					// only a frame that is accepted counts as activity
					last_receive_time = Date.now();
					return handle_frame(event.data, ws, connection_id);
				},
				onClose: async (event, ws) => {
					// belt and braces: the abort listener stops the timer and the
					// start is skipped on an ended socket, so this matters only if
					// one of those is ever broken
					stop_heartbeat_timer();
					socket_abort_controller.abort();
					// Removed by the id captured on open — an adapter may hand each
					// event its own `WSContext` (`@hono/bun` does), so the one this
					// event carries can't identify the connection. And removed before
					// the hook is awaited: the socket is gone, so a slow hook must not
					// keep a dead entry that broadcasts still target and the
					// per-account cap still counts.
					if (captured_connection_id) transport.remove_connection(captured_connection_id);
					if (on_socket_close && captured_connection_id && was_admitted) {
						try {
							await on_socket_close({
								ws,
								connection_id: captured_connection_id,
								identity
							});
						} catch (error) {
							log.error('on_socket_close failed:', error);
						}
					}
					log.debug('ws closed', captured_connection_id, {
						code: event.code,
						reason: event.reason
					});
				}
			};
		})
	);

	// last, after everything that can throw, so a failed mount leaves no member
	options.connection_closer?.add(transport);
	return { transport };
};

/**
 * The byte size of an inbound WebSocket message — UTF-8 bytes for a text
 * frame, the buffer or blob size for a binary one.
 */
const ws_message_size = (data: unknown): number => {
	if (typeof data === 'string') return utf8_length(data);
	if (data instanceof Blob) return data.size;
	if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
	return 0;
};

/**
 * The byte size of an inbound WebSocket message when it exceeds `max_bytes`,
 * else `null` — UTF-8 bytes for a text frame, the buffer or blob size for a
 * binary one. A text frame that cannot exceed the cap is not encoded to be
 * measured.
 */
const ws_message_size_over = (data: unknown, max_bytes: number): number | null => {
	if (typeof data === 'string') return utf8_length_over(data, max_bytes);
	const size = ws_message_size(data);
	return size > max_bytes ? size : null;
};
