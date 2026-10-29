/**
 * The per-socket half of the WebSocket endpoint — one upgraded socket, from
 * admission to close.
 *
 * `register_action_ws` (`actions/register_action_ws.ts`) mounts the upgrade
 * route; per upgrade it reads the credential off the Hono context into a
 * `WsSocketUpgrade` and hands that, with the endpoint-level `WsSocketEndpoint`,
 * to `create_ws_socket_events`, whose `WSEvents` the runtime adapter drives.
 * Nothing here reads the Hono context or imports the mount, so a socket is
 * reachable with a fake `WSContext` and no app.
 *
 * The WS-specific concerns — connection lifecycle, heartbeat,
 * cancel-notification interception, socket-scoped notify — live here; the
 * relation to `create_rpc_endpoint` and the shared `perform_action` core is in
 * the `register_action_ws` module doc.
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
 * (`ConnectionRegistry.register_pending` — closeable by every
 * revocation, inert otherwise), re-read the credential, the acting actor, and
 * the role (`recheck_admission`, which the audit stream shares), then
 * `ConnectionRegistry.admit`. A
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
 * The acting actor the upgrade resolved is re-read beside the credential on
 * every endpoint, gated or not: an actor soft-deleted under its live account
 * keeps the account's sessions and tokens and its own grant rows, so neither
 * the credential nor the role re-read would refuse it. A tombstoned acting
 * actor is refused like a dead credential.
 *
 * An endpoint gated on `required_roles` re-reads them beside the credential:
 * its upgrade passed the role gate before the socket registered, so a role
 * revocation landing in between would close nothing (a `role` close target
 * matches registrations), and the socket would be admitted without the role
 * for its lifetime. The re-read reads the acting actor's grants afresh and
 * admits on a global grant of any listed role, as the gate did.
 *
 * A refused upgrade is closed with `WS_CLOSE_SESSION_REVOKED` (4001, the
 * reason a revoked socket gets) for a dead credential or a deleted acting actor,
 * `WS_CLOSE_PERMISSION_REVOKED` (4006) for a lost role, or
 * `WS_CLOSE_INTERNAL_ERROR` (1011) when a re-read itself failed — fail
 * closed, never admitted unchecked. The handshake has already answered `101`,
 * so a refusal can only be a close frame.
 *
 * Once the server is shutting down (`AppServer.close` ran the registry's
 * `close_all_connections`) a refusal is `WS_CLOSE_GOING_AWAY` instead, so the
 * client reconnects rather than treating its credential as revoked: an upgrade
 * pending at the close-all is closed by it — and its abort makes the refusal
 * that follows the re-read send nothing more, even when the database closed
 * under that re-read — and one that registers after it is born closed and
 * skips the re-read (`ConnectionRegistry` module doc, "Shutdown").
 *
 * Frames that arrive before admission are queued, not dispatched: nothing runs
 * on a credential that has not been re-read. They dispatch in arrival order
 * once the socket is admitted and `on_socket_open` has completed, and are
 * dropped unread on a refusal. The queue holds at most
 * `MAX_PRE_ADMISSION_FRAMES` frames and
 * `PRE_ADMISSION_QUEUE_BYTES_FACTOR` × `max_message_bytes` bytes; past either
 * the socket is closed.
 *
 * ## Credential deadline
 *
 * Expiry writes nothing a revocation listener could hear, so the socket
 * watches its own credential's expiry (`ResolvedAuth.credential_deadline`,
 * the earlier of a session's cookie and row, an API token's row, none for a
 * daemon token or an eternal token). From admission, a timer closes it at the
 * deadline with `WS_CLOSE_SESSION_REVOKED` (4001) and
 * `WS_CLOSE_CREDENTIAL_EXPIRED_REASON`. The wait is a chain of timers of at
 * most an hour (`schedule_credential_deadline`), so a session's 30 days — past
 * `setTimeout`'s ceiling — does not fire at once, and each wake-up checks the
 * wall clock too, so a host suspend does not extend the deadline.
 *
 * ## A server-closed socket dispatches nothing
 *
 * A runtime adapter can keep delivering inbound frames after the server calls
 * `ws.close(…)`, until the close handshake completes (`@hono/node-ws` does —
 * up to the `ws` close timeout when the client withholds its close frame).
 * So every server-side close — revocation, cap eviction, heartbeat timeout,
 * an oversized message, a refused admission — removes the connection from the
 * registry and aborts the socket's signal *at close time*, and `onMessage`
 * drops any frame on a socket that has ended. A connection the registry no
 * longer holds though nothing closed its socket (a bare `remove_connection`)
 * is ended on its next frame (`ConnectionRegistry.is_registered`), with
 * `WS_CLOSE_INTERNAL_ERROR` — it must not linger as a socket that reads
 * everything and answers nothing.
 *
 * @module
 */

import type { WSContext, WSEvents } from 'hono/ws';
import type { Logger as LoggerType } from '@fuzdev/fuz_util/log.ts';
import { UnreachableError } from '@fuzdev/fuz_util/error.ts';
import type { Uuid } from '../primitive_schemas.ts';

import type { RequestContext } from '../auth/request_context.ts';
import type { RoleName } from '../auth/role_schema.ts';
import {
	recheck_admission,
	resolved_auth_api_token_id,
	resolved_auth_session_hash,
	type AdmissionRecheck,
	type ResolvedAuth
} from '../auth/resolved_auth.ts';
import { schedule_credential_deadline } from '../auth/credential_deadline.ts';
import { flush_request_effects, type EffectErrorContext } from '../http/pending_effects.ts';
import type { RateLimiter } from '../rate_limiter.ts';
import type { JsonrpcErrorResponse, JsonrpcRequestId } from '../http/jsonrpc.ts';
import { jsonrpc_error_messages } from '../http/jsonrpc_errors.ts';
import {
	classify_jsonrpc_message,
	create_jsonrpc_error_response,
	create_jsonrpc_notification,
	to_jsonrpc_params
} from '../http/jsonrpc_helpers.ts';
import type { Db } from '../db/db.ts';
import type { RpcAction } from './action_types.ts';
import { cancel_action_spec, CancelNotificationParams } from './cancel.ts';
import {
	WS_CLOSE_CONNECTION_UNREGISTERED_REASON,
	WS_CLOSE_GOING_AWAY,
	WS_CLOSE_INTERNAL_ERROR,
	WS_CLOSE_INTERNAL_ERROR_REASON,
	WS_CLOSE_MESSAGE_TOO_BIG,
	WS_CLOSE_MESSAGE_TOO_BIG_REASON,
	WS_CLOSE_PERMISSION_REVOKED,
	WS_CLOSE_PERMISSION_REVOKED_REASON,
	WS_CLOSE_POLICY_VIOLATION,
	WS_CLOSE_PRE_ADMISSION_OVERFLOW_REASON,
	WS_CLOSE_CREDENTIAL_EXPIRED_REASON,
	WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT,
	WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT_REASON,
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SOCKET_OPEN_FAILED_REASON,
	WS_CLOSE_SESSION_REVOKED_REASON,
	utf8_length,
	utf8_length_over
} from './transports.ts';
import type { ConnectionRegistry, ConnectionIdentity } from './connection_registry.ts';
import { audit_unmatched_peer_response, type RequestClient } from './peer_request.ts';
import { perform_action, serialize_action_result } from './perform_action.ts';

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
 * Max requests one socket may have dispatching at once. A request that
 * arrives past it is answered `queue_overflow` with its id
 * (`WS_INBOUND_DISPATCH_OVERFLOW_MESSAGE`) and not dispatched; the socket
 * stays open, and the requests already running keep answering.
 *
 * A runtime adapter can hand frames over without awaiting the previous one's
 * dispatch (`@hono/node-ws` does not await `onMessage`), so without a ceiling
 * one socket could hold any number of handlers — and their pooled database
 * work — at once. Shedding rather than queueing keeps the socket reading, so a
 * reply to a server-initiated request still reaches the handler awaiting it.
 * Generous, so ordinary pipelining never meets it. Same value as the Rust
 * spine's `MAX_INBOUND_DISPATCHES_PER_CONNECTION`.
 *
 * Counted are the requests that passed envelope validation and are not yet
 * answered — the entries of the socket's cancellation map. Notifications,
 * replies to server-initiated requests, and refused frames never count.
 */
export const MAX_INBOUND_DISPATCHES_PER_CONNECTION = 128;

/**
 * The `queue_overflow` message a request gets past
 * `MAX_INBOUND_DISPATCHES_PER_CONNECTION`. Same text as the Rust spine's.
 */
export const WS_INBOUND_DISPATCH_OVERFLOW_MESSAGE =
	'too many concurrent requests on this connection';

/**
 * The `data.reason` of the `invalid_request` a WebSocket request gets when its
 * id names a request still running on the same socket. The duplicate is not
 * dispatched; the running request keeps its id, so its reply, and a `cancel`
 * naming that id, stay its own. An id is free again once its request has been
 * answered.
 */
export const ERROR_DUPLICATE_REQUEST_ID = 'duplicate_request_id';

/**
 * Send one JSON-RPC error response frame to `connection_id` through the
 * registry's outbound queue.
 */
const send_error_response = (
	registry: ConnectionRegistry,
	connection_id: Uuid,
	id: JsonrpcErrorResponse['id'],
	error: JsonrpcErrorResponse['error']
): void => {
	registry.send_to(connection_id, JSON.stringify(create_jsonrpc_error_response(id, error)));
};

/**
 * Context passed to the `on_socket_open` hook.
 *
 * Fires once the connection is **admitted** — registered in the registry and
 * its credential re-checked (so `connection_id` is valid, and broadcasts reach
 * it) — and before any client message dispatches. A socket refused at
 * admission never reaches it. Consumers use this to bootstrap per-socket
 * domain state — e.g. spawning a per-account unit and pushing an initial state
 * snapshot.
 */
export interface SocketOpenContext {
	/**
	 * The raw WebSocket context — exposed for edge cases; prefer `notify` for
	 * sends. A frame sent on it directly bypasses the connection's outbound
	 * budget and its ordering with queued frames.
	 */
	ws: WSContext;
	/** Connection id assigned by `ConnectionRegistry.register_pending`. */
	connection_id: Uuid;
	/**
	 * Auth identity registered for this connection. The registry holds its
	 * own copy, so this record is not what close targets match on.
	 */
	identity: Readonly<ConnectionIdentity>;
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
 * Fires after the registry has removed the connection — `connection_id` and
 * `identity` are the values captured at open, so consumer cleanup reads them
 * from here, not from the registry. Fires for both client-initiated closes
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
	/** Auth identity captured at open time — the registry no longer holds it. */
	identity: Readonly<ConnectionIdentity>;
}

/**
 * The endpoint-level values every socket of an endpoint reads — derived once
 * by `register_action_ws`, shared by all of its sockets.
 *
 * @internal
 */
export interface WsSocketEndpoint {
	/** Mount path, reported in `on_effect_error` contexts. */
	path: string;
	/** Pool-level DB: the admission re-read and per-message dispatch read through it. */
	db: Db;
	/** Logger for the endpoint's sockets. */
	log: LoggerType;
	/** The registry the endpoint's connections register with. */
	registry: ConnectionRegistry;
	/** Per-method dispatch lookup — `request_response` specs with a handler. */
	action_map: ReadonlyMap<string, RpcAction>;
	/** Receive silence (ms) past which a socket is closed; `null` keeps silent sockets open. */
	receive_timeout: number | null;
	/** The receive check's period (ms); `null` exactly when `receive_timeout` is. */
	receive_tick_interval: number | null;
	/** Cap on one inbound message, in bytes. */
	max_message_bytes: number;
	/** Byte budget of one socket's pre-admission queue. */
	pre_admission_queue_max_bytes: number;
	/** Hook called once per socket after admission; `undefined` for none. */
	on_socket_open: ((ctx: SocketOpenContext) => void | Promise<void>) | undefined;
	/** Hook called once per admitted socket after its connection is removed; `undefined` for none. */
	on_socket_close: ((ctx: SocketCloseContext) => void | Promise<void>) | undefined;
	/** Per-IP action rate limiter; `null` turns the IP check off. */
	action_ip_rate_limiter: RateLimiter | null;
	/** Per-account action rate limiter; `null` turns the account check off. */
	action_account_rate_limiter: RateLimiter | null;
	/** Called when an eager pending effect of a frame's action rejects; `undefined` for none. */
	on_effect_error: ((error: unknown, context: EffectErrorContext) => void) | undefined;
	/** Roles the endpoint's upgrade is gated on; empty for an ungated endpoint. */
	required_roles: ReadonlyArray<RoleName>;
}

/**
 * What `register_action_ws` captures from the upgrade request for one socket.
 * The socket reads these for its whole life; the Hono context itself is not
 * kept.
 *
 * @internal
 */
export interface WsSocketUpgrade {
	/** The client IP, keyed by the per-IP action rate limiter. */
	client_ip: string;
	/** The test-context preset, which skips the admission re-read and the live authorization phase. */
	upgrade_preset: { request_context: RequestContext | null } | undefined;
	/**
	 * The credential the auth middleware resolved — re-read at admission,
	 * passed to every message's dispatch, and the source of the connection's
	 * identity.
	 */
	resolved: ResolvedAuth;
	/** The request context the upgrade's authorization phase built, on the credential's account. */
	upgrade_context: RequestContext;
}

/**
 * Build the Hono `WSEvents` for one upgraded socket: admission, the receive
 * watchdog, the credential deadline, frame dispatch, and close (module doc).
 *
 * @param endpoint - the endpoint-level values, shared by all of its sockets
 * @param upgrade - what the upgrade request captured for this socket
 * @returns the adapter's `onOpen` / `onMessage` / `onClose` for the socket
 *
 * @internal
 */
export const create_ws_socket_events = (
	endpoint: WsSocketEndpoint,
	upgrade: WsSocketUpgrade
): WSEvents => {
	const {
		path,
		db,
		log,
		registry,
		action_map,
		receive_timeout,
		receive_tick_interval,
		max_message_bytes,
		pre_admission_queue_max_bytes,
		on_socket_open,
		on_socket_close,
		action_ip_rate_limiter,
		action_account_rate_limiter,
		on_effect_error,
		required_roles
	} = endpoint;
	const { client_ip, upgrade_preset, resolved, upgrade_context } = upgrade;
	// the request context's account — `register_action_ws` holds it to the
	// credential's before the upgrade
	const account_id: Uuid = upgrade_context.account.id;
	// Session-based connections have a session hash for targeted
	// revocation. Bearer/daemon connections pass null — still reachable
	// by an `account` or `token` close target.
	const session_hash = resolved_auth_session_hash(resolved);
	// `api_token.id` — set only for bearer connections; enables a
	// `token` close target to tear down just this socket on
	// `token_revoke` without affecting the account's other sockets.
	const api_token_id = resolved_auth_api_token_id(resolved);

	// Per-socket abort controller — fires when the socket ends, chained
	// into every in-flight handler's per-request controller via
	// `AbortSignal.any`. Keeping both signals lets the client
	// cancel-one-request-by-id (via the `cancel` notification) without
	// tearing down the whole socket. Registered with the registry, which
	// aborts it when it closes the connection (revocation, cap eviction),
	// and aborted here on every other end (`end_socket`, `onClose`) — at
	// close time, not when the close handshake lands.
	const socket_abort_controller = new AbortController();
	// Per-request controllers keyed by JSON-RPC request id — lets an
	// incoming `cancel` notification abort just the matching handler.
	// Populated on request dispatch, cleared in the handler's `finally`
	// so a late-arriving cancel for a completed id (or a reused id)
	// can't null-abort a freshly-arrived request. Idempotent: cancel
	// for unknown ids no-ops. One entry per running request — a
	// request reusing a live id is refused before it gets one — so its
	// size is the in-flight count `MAX_INBOUND_DISPATCHES_PER_CONNECTION`
	// bounds.
	const pending_controllers: Map<JsonrpcRequestId, AbortController> = new Map();

	// Identity is assembled at upgrade time so `on_socket_close` can
	// read it — by the time the hook runs the registry record is gone,
	// removed in `onClose` or earlier by a revocation, a connection-cap
	// eviction, or another server-side close.
	const identity: ConnectionIdentity = {
		session_hash,
		account_id,
		api_token_id,
		required_roles
	};
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
	// The code the registry closed the pending registration with, taken
	// before `onClose` removes it: the client's answer to that close can
	// arrive before the re-read returns.
	let pending_close_code: number | null = null;

	// Frames received while `opening`, in arrival order — dispatched once
	// the socket is open, dropped if it ends first. Each carries the
	// settlers of the promise its `onMessage` call returned, so a caller
	// awaiting that call (the test harnesses do) resumes when the frame
	// has been dispatched or dropped.
	const queued_frames: Array<{
		data: unknown;
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
	let receive_timer: ReturnType<typeof setInterval> | null = null;
	const stop_receive_timer = () => {
		if (receive_timer !== null) {
			clearInterval(receive_timer);
			receive_timer = null;
		}
	};
	// The credential deadline: the socket closes when the credential it
	// upgraded on expires (4001, `WS_CLOSE_CREDENTIAL_EXPIRED_REASON`) —
	// expiry writes nothing a revocation listener hears. Started at
	// admission, cancelled when the socket ends.
	let cancel_credential_deadline: (() => void) | null = null;
	const stop_credential_deadline = (): void => {
		cancel_credential_deadline?.();
		cancel_credential_deadline = null;
	};

	// The one place a socket's end is recorded, whoever ended it — the
	// registry (revocation, cap eviction), `end_socket`, or `onClose` all
	// abort this controller.
	socket_abort_controller.signal.addEventListener(
		'abort',
		() => {
			phase = 'ended';
			stop_receive_timer();
			stop_credential_deadline();
			drop_queued_frames();
		},
		{ once: true }
	);

	// End the socket from the server side: unregister it and abort its
	// signal *now* — so nothing more dispatches and in-flight handlers
	// see `signal.aborted` while the close handshake is still in flight —
	// then send the close frame. The registry does all three for a
	// connection it still holds, sending the close behind the waiting
	// frames the socket has room for and under the close deadline; a socket
	// whose connection is already gone has nothing waiting and is closed
	// directly.
	const end_socket = (ws: WSContext, code: number, reason: string): void => {
		const closed =
			captured_connection_id !== undefined &&
			registry.close_connection(captured_connection_id, code, reason);
		socket_abort_controller.abort();
		if (closed) return;
		try {
			ws.close(code, reason);
		} catch (error) {
			log.error(`ws close ${code} failed:`, error);
		}
	};

	// Refuse an upgrade at admission. A socket that already ended needs no
	// close frame: a revocation closed its pending registration (the
	// registry sent the 4001), the shutdown did (the 1001 — so a refusal
	// during shutdown never sends a revocation's or a failure's code), or
	// the client went away. Its registration is gone too — the registry
	// removed it with its close, `onClose` with the client's — and it is
	// not removed again here: `remove_connection` is for a socket that has
	// closed, and would drop the close deadline of one that has not.
	const refuse_upgrade = (ws: WSContext, code: number, reason: string): void => {
		if (!socket_abort_controller.signal.aborted) end_socket(ws, code, reason);
	};

	// Socket-scoped notification helper — routes to this socket only,
	// matches the `ctx.notify` semantics exposed to per-message handlers.
	// Through the registry's outbound queue, like every other frame: a
	// handler that notifies past the connection's budget closes it.
	const notify_socket =
		(connection_id: Uuid) =>
		(notify_method: string, notify_params: unknown): void => {
			try {
				const notification = create_jsonrpc_notification(
					notify_method,
					to_jsonrpc_params(notify_params)
				);
				registry.send_to(connection_id, JSON.stringify(notification));
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
		const connection_id = registry.register_pending(ws, identity, socket_abort_controller);
		captured_connection_id = connection_id;

		// Born closed — the server is shutting down, and the registry has
		// already closed the socket with `WS_CLOSE_GOING_AWAY` — or ended
		// otherwise before the re-read: nothing to re-read for. The removal
		// is a no-op for a born-closed registration, which was never inserted.
		if (socket_abort_controller.signal.aborted) {
			registry.remove_connection(connection_id);
			log.info(
				registry.is_closing()
					? 'ws upgrade admission: refused, the server is shutting down'
					: 'ws upgrade admission: socket ended before the re-check',
				connection_id,
				account_id
			);
			return null;
		}

		if (!upgrade_preset) {
			let recheck: AdmissionRecheck;
			try {
				// pool-level `db`: the reads must see every revocation committed
				// before they start
				recheck = await recheck_admission(
					{ db },
					{ resolved, request_context: upgrade_context, required_roles }
				);
			} catch (error) {
				// fail closed — never admitted unchecked. During shutdown the
				// database may close under the re-read; that is the shutdown's
				// refusal, not a failure.
				if (registry.is_closing()) {
					log.info('ws upgrade admission: re-check ended by the shutdown', error);
				} else {
					log.error('ws upgrade admission: credential, actor, or role re-check failed', error);
				}
				refuse_upgrade(ws, WS_CLOSE_INTERNAL_ERROR, WS_CLOSE_INTERNAL_ERROR_REASON);
				return null;
			}
			switch (recheck) {
				case 'admitted':
					break;
				case 'credential_revoked':
					log.info(
						'ws upgrade admission: credential revoked during the upgrade',
						connection_id,
						account_id
					);
					refuse_upgrade(ws, WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON);
					return null;
				case 'actor_inactive':
					log.info(
						'ws upgrade admission: acting actor deleted during the upgrade',
						connection_id,
						account_id
					);
					refuse_upgrade(ws, WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED_REASON);
					return null;
				case 'role_revoked':
					log.info(
						'ws upgrade admission: role revoked during the upgrade',
						connection_id,
						account_id
					);
					refuse_upgrade(ws, WS_CLOSE_PERMISSION_REVOKED, WS_CLOSE_PERMISSION_REVOKED_REASON);
					return null;
				default:
					throw new UnreachableError(recheck);
			}
		}

		// The cap's eviction happens here, after every gate and the re-read,
		// so a refused upgrade never closes someone else's socket.
		if (!registry.admit(connection_id)) {
			// why the entry closed, from the code the registry closed it with
			const code = pending_close_code ?? registry.take_pending_close_code(connection_id);
			log.info(
				code === WS_CLOSE_PERMISSION_REVOKED
					? 'ws upgrade admission: closed by a permission revocation while pending'
					: code === WS_CLOSE_SESSION_REVOKED
						? 'ws upgrade admission: closed by a credential revocation while pending'
						: code === WS_CLOSE_GOING_AWAY || registry.is_closing()
							? 'ws upgrade admission: closed by the shutdown while pending'
							: 'ws upgrade admission: ended while pending',
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
		// Not on a socket that ended in the tick since `admit`, for the same
		// reason as the heartbeat timer below.
		if (!phase_is('ended')) {
			cancel_credential_deadline = schedule_credential_deadline(
				resolved.credential_deadline,
				() => {
					log.info(
						'ws credential expired — closing',
						WS_CLOSE_SESSION_REVOKED,
						connection_id,
						identity.account_id
					);
					end_socket(ws, WS_CLOSE_SESSION_REVOKED, WS_CLOSE_CREDENTIAL_EXPIRED_REASON);
				}
			);
		}
		// Not on a socket that ended in the tick since `admit` (a revocation
		// can land there): its abort listener has already run, so nothing
		// would ever stop the timer.
		if (receive_timeout !== null && receive_tick_interval !== null && !phase_is('ended')) {
			last_receive_time = Date.now();
			receive_timer = setInterval(() => {
				const now = Date.now();
				const silence = now - last_receive_time;
				if (silence >= receive_timeout) {
					log.info(
						`receive timeout (${silence}ms) — closing ${WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT}`,
						connection_id,
						identity.account_id
					);
					stop_receive_timer();
					end_socket(
						ws,
						WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT,
						WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT_REASON
					);
				}
			}, receive_tick_interval);
		}
		if (on_socket_open) {
			try {
				await on_socket_open({
					ws,
					connection_id,
					identity,
					notify: notify_socket(connection_id),
					signal: socket_abort_controller.signal
				});
			} catch (error) {
				log.error('on_socket_open failed — closing socket:', error);
				// an ended socket has no one to tell
				if (phase_is('ended')) return;
				send_error_response(registry, connection_id, null, jsonrpc_error_messages.internal_error());
				end_socket(ws, WS_CLOSE_INTERNAL_ERROR, WS_CLOSE_SOCKET_OPEN_FAILED_REASON);
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
			if (registry.is_registered(connection_id)) {
				handle_frame(frame.data, connection_id).then(frame.resolve, frame.reject);
			} else {
				frame.resolve();
			}
		}
	};

	// Dispatch one inbound frame on an admitted, still-registered
	// connection.
	const handle_frame = async (data: unknown, connection_id: Uuid): Promise<void> => {
		const send_error = (
			id: JsonrpcErrorResponse['id'],
			error: JsonrpcErrorResponse['error']
		): void => send_error_response(registry, connection_id, id, error);
		let json;
		try {
			json = JSON.parse(String(data));
		} catch (error) {
			log.error('JSON parse error:', error);
			send_error(null, jsonrpc_error_messages.parse_error());
			return;
		}

		// Batch JSON-RPC is not supported on the WebSocket path.
		if (Array.isArray(json)) {
			send_error(
				null,
				jsonrpc_error_messages.invalid_request(
					'batch JSON-RPC requests are not supported on WebSocket'
				)
			);
			return;
		}

		// One classifier for both transports (`classify_jsonrpc_message`,
		// the Rust twin's order: version → method → id → params); this
		// path applies the WebSocket semantics to its arms.
		const classified = classify_jsonrpc_message(json);
		switch (classified.kind) {
			case 'invalid':
				send_error(classified.id, classified.error);
				return;
			case 'response': {
				// A reply to a server-initiated request (`peer/ping`, etc.) —
				// routed to the pending-request registry scoped to THIS
				// socket. An unmatched id (unsolicited, cross-connection, or
				// already settled) resolves nothing and is dropped, so the
				// read loop survives a junk frame.
				const { response } = classified;
				const matched = registry.resolve_peer_response(connection_id, response);
				if (!matched) audit_unmatched_peer_response(log, connection_id, response.id);
				return;
			}
			case 'notification': {
				// `cancel` is intercepted for request-scoped cancellation;
				// other notifications are silenced per JSON-RPC spec (consumer
				// notification handlers are not a feature yet). Notifications
				// stay unvalidated — they carry no id to answer an error on.
				if (classified.method === cancel_action_spec.method) {
					const parsed = CancelNotificationParams.safeParse(classified.params);
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
			case 'request':
				break;
			default:
				throw new UnreachableError(classified);
		}

		const { method, id, params } = classified.request;

		// A request is live from here until its reply is sent. One reusing
		// a live id is refused rather than dispatched: two requests under
		// one id would share a cancel entry and a reply id, and the first to
		// finish would clear the other's. Checked before the ceiling — a
		// duplicate is the client's error whatever the load, and retrying it
		// cannot succeed while the first runs. Neither refusal reaches
		// `perform_action`, so neither charges the action rate limiters —
		// the same on the Rust spine.
		if (pending_controllers.has(id)) {
			send_error(
				id,
				jsonrpc_error_messages.invalid_request({ reason: ERROR_DUPLICATE_REQUEST_ID })
			);
			return;
		}
		// The in-flight ceiling: shed, don't queue — see
		// `MAX_INBOUND_DISPATCHES_PER_CONNECTION`.
		if (pending_controllers.size >= MAX_INBOUND_DISPATCHES_PER_CONNECTION) {
			send_error(id, jsonrpc_error_messages.queue_overflow(WS_INBOUND_DISPATCH_OVERFLOW_MESSAGE));
			return;
		}

		// Per-action method lookup — return method_not_found before
		// we engage the dispatch machinery. Specs without a handler
		// (client-only / dispatcher-handled) miss action_map and
		// surface as method_not_found just like unknown methods.
		const action = action_map.get(method);
		if (!action) {
			send_error(id, jsonrpc_error_messages.method_not_found(method));
			return;
		}

		// Per-request controller — fires on explicit `cancel` or when the
		// socket ends (via the socket_abort_controller chain below).
		// Registered before dispatch, so the request is live (counted, and
		// its id taken) from the moment it is accepted — so a cancel
		// arriving mid-handler finds it;
		// cleared in `finally` so late cancels for a completed id (or a
		// future request that reuses the id) can't null-abort the wrong
		// handler.
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
		// send on the success path runs before the `finally`
		// flushes that queue, so the caller reads its reply and
		// then the 4001 close. Inverting the order — flushing the
		// queues before the send — would strand the caller without
		// a reply.
		const pending_effects: Array<Promise<void>> = [];
		const post_commit_effects: Array<() => void | Promise<void>> = [];

		const notify = notify_socket(connection_id);
		// Server→client request seam (ActionPeer) — closes over this
		// socket's connection_id so a handler can initiate a request to
		// the originating client and await the reply.
		const request_client: RequestClient = (request_method, request_params, request_options) =>
			registry.request_connection(connection_id, request_method, request_params, request_options);
		const signal = AbortSignal.any([socket_abort_controller.signal, request_controller.signal]);

		try {
			const result = await perform_action(
				{
					action,
					raw_params: params,
					request_id: id,
					auth: resolved,
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
			const { body: frame } = serialize_action_result(id, result, method, log);
			// Refused when the connection is gone — closed while the handler
			// ran, or closed by the handler's own notifications overflowing
			// its outbound budget — so nothing follows a close frame.
			registry.send_to(connection_id, frame);
		} finally {
			pending_controllers.delete(id);
			// deferred first — see the ordering invariant above
			await flush_request_effects(
				pending_effects,
				post_commit_effects,
				log,
				on_effect_error
					? (reason) => on_effect_error(reason, { transport: 'ws', method, path })
					: undefined
			);
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
				refuse_upgrade(ws, WS_CLOSE_INTERNAL_ERROR, WS_CLOSE_INTERNAL_ERROR_REASON);
			}
		},
		onMessage: (event, ws): void | Promise<void> => {
			// A socket the server closed — or refused — dispatches nothing
			// more, however long its client withholds the close frame.
			if (phase_is('ended')) return;
			const size = ws_message_size_over(event.data, max_message_bytes);
			if (size !== null) {
				log.warn(`closing socket: ${size}-byte message exceeds the ${max_message_bytes}-byte cap`);
				end_socket(ws, WS_CLOSE_MESSAGE_TOO_BIG, WS_CLOSE_MESSAGE_TOO_BIG_REASON);
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
					queued_frames.push({ data: event.data, resolve, reject });
				});
			}
			// The registry is the authority on whether the connection is
			// still live. A close it made (revocation, cap eviction) ended the
			// socket above; a connection it no longer holds though nothing
			// closed the socket — a bare `remove_connection` — is ended here,
			// rather than left reading every frame and answering none, where
			// a chatty client would also keep the heartbeat from reaping it.
			const connection_id = captured_connection_id;
			if (connection_id === undefined || !registry.is_registered(connection_id)) {
				log.warn('closing socket: its connection is no longer registered', connection_id);
				end_socket(ws, WS_CLOSE_INTERNAL_ERROR, WS_CLOSE_CONNECTION_UNREGISTERED_REASON);
				return;
			}
			// only a frame that is accepted counts as activity
			last_receive_time = Date.now();
			return handle_frame(event.data, connection_id);
		},
		onClose: async (event, ws) => {
			// belt and braces: the abort listener stops the timer and the
			// start is skipped on an ended socket, so this matters only if
			// one of those is ever broken
			stop_receive_timer();
			socket_abort_controller.abort();
			// Removed by the id captured on open — an adapter may hand each
			// event its own `WSContext` (`@hono/bun` does), so the one this
			// event carries can't identify the connection. And removed before
			// the hook is awaited: the socket is gone, so a slow hook must not
			// keep a dead entry that broadcasts still target and the
			// per-account cap still counts.
			if (captured_connection_id) {
				if (!was_admitted) {
					pending_close_code = registry.take_pending_close_code(captured_connection_id);
				}
				registry.remove_connection(captured_connection_id);
			}
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
