/**
 * Transport abstraction for action communication.
 *
 * Provides the `Transport` interface and `Transports` registry for managing
 * multiple transports with fallback behavior.
 *
 * @module
 */

import { z } from 'zod';

import type {
	JsonrpcMessageFromClientToServer,
	JsonrpcMessageFromServerToClient,
	JsonrpcNotification,
	JsonrpcRequest,
	JsonrpcResponseOrError,
	JsonrpcErrorResponse
} from '../http/jsonrpc.ts';

/**
 * WebSocket close code for session revocation — and for a credential that
 * expired while the socket was open (`WS_CLOSE_CREDENTIAL_EXPIRED_REASON`).
 *
 * Also the close for an upgrade refused at admission because its credential
 * was revoked while the upgrade was in flight (`register_action_ws`) — the
 * same outcome, reached a moment earlier.
 */
export const WS_CLOSE_SESSION_REVOKED = 4001;
/**
 * The close reason sent with `WS_CLOSE_SESSION_REVOKED` — one definition, so a
 * socket revoked mid-life and an upgrade refused at admission are
 * indistinguishable on the wire. The Rust spine sends the same text.
 */
export const WS_CLOSE_SESSION_REVOKED_REASON = 'Session revoked';
/**
 * The close reason sent with `WS_CLOSE_SESSION_REVOKED` when the socket's
 * credential expired while it was open — its session or API token passed its
 * expiry (`ResolvedAuth.credential_deadline`). The code is the revocation's on
 * purpose: the client cannot reconnect on the credential either way, so
 * `FrontendWebsocketClient` enters the same `revoked` state. The Rust spine
 * sends the same text.
 */
export const WS_CLOSE_CREDENTIAL_EXPIRED_REASON = 'Credential expired';
/** WebSocket close code — client timed out waiting for a response. */
export const WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT = 4002;
/**
 * The close reason `FrontendWebsocketClient` sends with
 * `WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT`. TS-only: the client is the same
 * against either spine.
 */
export const WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT_REASON = 'client heartbeat timeout';
/** WebSocket close code — server timed out with no incoming activity. */
export const WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT = 4003;
/**
 * The close reason sent with `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT`. The Rust
 * spine sends the same text.
 */
export const WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT_REASON = 'server heartbeat timeout';
/**
 * WebSocket close code — the server closed this socket to admit a newer
 * connection on the same account, past the per-account connection cap
 * (`BackendWebsocketTransport`'s `max_connections_per_account`, evict-oldest).
 *
 * Distinct from `WS_CLOSE_SESSION_REVOKED`: the credential is still good, so
 * a client must not enter its `revoked` state — but it must not auto-reconnect
 * either, since a reconnect would supersede a newer socket in turn and two
 * tabs past the cap would close each other in a loop. `FrontendWebsocketClient`
 * treats it as closed until the user acts (`superseded`). The twin of the Rust
 * spine's `WS_CLOSE_CONNECTION_LIMIT`.
 */
export const WS_CLOSE_CONNECTION_LIMIT = 4004;
/**
 * The close reason sent with `WS_CLOSE_CONNECTION_LIMIT`. The Rust spine
 * sends the same text.
 */
export const WS_CLOSE_CONNECTION_LIMIT_REASON = 'connection limit';
/**
 * WebSocket close code — the server had more waiting to be written to this
 * socket than the connection's outbound budget holds
 * (`BackendWebsocketTransport`'s `outbound_queue_bytes`), because the client
 * is reading slower than the server is sending to it, or not at all. The
 * frame that did not fit and everything still waiting are dropped, so the
 * close is the client's notice that it missed messages.
 *
 * Distinct from `WS_CLOSE_SESSION_REVOKED`: the credential is still good, so a
 * client must not enter its `revoked` state. Unlike
 * `WS_CLOSE_CONNECTION_LIMIT`, nothing took the connection's place:
 * `FrontendWebsocketClient` reconnects under its ordinary backoff, and the
 * consumer re-reads whatever state it tracks. A client that reads nothing at
 * all may never see the frame — a socket whose write makes no progress is
 * dropped without one, which a browser reports as 1006. The twin of the Rust
 * spine's `WS_CLOSE_OUTBOUND_OVERFLOW`.
 */
export const WS_CLOSE_OUTBOUND_OVERFLOW = 4005;
/**
 * The close reason sent with `WS_CLOSE_OUTBOUND_OVERFLOW`. The Rust spine
 * sends the same text.
 */
export const WS_CLOSE_OUTBOUND_OVERFLOW_REASON = 'outbound queue overflow';
/**
 * WebSocket close code — the socket's account lost a role its endpoint
 * requires (`register_action_ws`'s `required_roles`): a global grant of one
 * of those roles was revoked while the socket was open, or while its upgrade
 * was in flight (the admission re-read, `register_action_ws`). Nothing more
 * is sent on the socket.
 *
 * Distinct from `WS_CLOSE_SESSION_REVOKED`: the credential is still good, so
 * a client must not enter its `revoked` state — but a reconnect would be
 * refused at the role gate, so `FrontendWebsocketClient` stays closed until
 * `connect()` is called and rejects its pending work as `forbidden`. The twin
 * of the Rust spine's `WS_CLOSE_PERMISSION_REVOKED`.
 */
export const WS_CLOSE_PERMISSION_REVOKED = 4006;
/**
 * The close reason sent with `WS_CLOSE_PERMISSION_REVOKED`, mid-life and at
 * admission alike. The Rust spine sends the same text.
 */
export const WS_CLOSE_PERMISSION_REVOKED_REASON = 'Permission revoked';
/**
 * WebSocket close code — the server is shutting down (RFC 6455 §7.4.1 "Going
 * Away"). Sent to every live socket by `close_all_sockets`, which
 * `AppServer.close` runs, and to an upgrade the shutdown refuses — one
 * pending at the close-all, or born closed after it. Not a revocation: the credential is still good, so a
 * client reconnects under its ordinary backoff once a server is back.
 */
export const WS_CLOSE_GOING_AWAY = 1001;
/** The close reason sent with `WS_CLOSE_GOING_AWAY`. */
export const WS_CLOSE_GOING_AWAY_REASON = 'Server shutting down';
/**
 * WebSocket close code — an inbound message exceeded the receiver's size cap
 * (RFC 6455 §7.4.1 "Message Too Big").
 */
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009;
/**
 * The close reason sent with `WS_CLOSE_MESSAGE_TOO_BIG`. The Rust spine sends
 * the same text.
 */
export const WS_CLOSE_MESSAGE_TOO_BIG_REASON = 'message too big';
/**
 * WebSocket close code — the server closed a socket that sent too much while
 * it was still opening: past `MAX_PRE_ADMISSION_FRAMES` frames or the
 * `PRE_ADMISSION_QUEUE_BYTES_FACTOR` byte budget, before its admission and
 * `on_socket_open` had completed (RFC 6455 §7.4.1 "Policy Violation"). Not a
 * revocation: the client reconnects under its ordinary backoff.
 */
export const WS_CLOSE_POLICY_VIOLATION = 1008;
/**
 * The close reason sent with `WS_CLOSE_POLICY_VIOLATION` when a socket
 * overflows its pre-admission queue, by count or by bytes. TS-only: the Rust
 * spine sends no such close.
 */
export const WS_CLOSE_PRE_ADMISSION_OVERFLOW_REASON = 'too much sent before the socket opened';
/**
 * WebSocket close code — the server hit an unexpected condition (RFC 6455
 * §7.4.1 "Internal Error").
 *
 * Sent when an upgraded socket can't be admitted because its credential
 * re-check itself failed (a database error), when an `on_socket_open` hook
 * throws, and when a frame arrives on a socket whose connection was removed
 * from the transport without a close (a bare `remove_connection`). The
 * handshake has already answered `101`, so an HTTP `500` is no longer
 * available. Not a revocation: the client's credential may be fine, so it
 * reconnects under its ordinary backoff rather than entering its `revoked`
 * state. The twin of the Rust spine's `WS_CLOSE_INTERNAL_ERROR`.
 */
export const WS_CLOSE_INTERNAL_ERROR = 1011;
/**
 * The close reason sent with `WS_CLOSE_INTERNAL_ERROR` when an upgraded
 * socket can't be admitted — its credential re-check failed, or opening it
 * threw. The Rust spine sends the same text.
 */
export const WS_CLOSE_INTERNAL_ERROR_REASON = 'internal error';
/**
 * The close reason sent with `WS_CLOSE_INTERNAL_ERROR` when an
 * `on_socket_open` hook throws. TS-only: the Rust spine sends no such close.
 */
export const WS_CLOSE_SOCKET_OPEN_FAILED_REASON = 'socket bootstrap failed';
/**
 * The close reason sent with `WS_CLOSE_INTERNAL_ERROR` when a frame arrives
 * on a socket whose connection was removed from the transport without a
 * close (a bare `remove_connection`). TS-only: the Rust spine sends no such
 * close.
 */
export const WS_CLOSE_CONNECTION_UNREGISTERED_REASON = 'connection unregistered';

/**
 * Default cap on one WebSocket message, in UTF-8 bytes — equal to the default
 * HTTP body cap (`DEFAULT_MAX_BODY_SIZE`), so one JSON-RPC request is bounded
 * the same on both transports. The server closes the socket on a larger
 * inbound message with `WS_CLOSE_MESSAGE_TOO_BIG` (there's no per-message
 * error reply), and `FrontendWebsocketTransport` refuses to send one. The
 * twin of the Rust spine's `DEFAULT_WS_MAX_MESSAGE_BYTES`.
 */
export const DEFAULT_WS_MAX_MESSAGE_BYTES = 1024 * 1024;

const text_encoder = new TextEncoder();

/**
 * The UTF-8 byte length of `text` when it exceeds `max_bytes`, else `null`.
 * Skips encoding when the UTF-16 length alone rules it out — a code unit
 * takes at most 3 UTF-8 bytes.
 *
 * @param text - the string to measure
 * @param max_bytes - the byte cap
 * @returns the UTF-8 byte length when it exceeds `max_bytes`, else `null`
 */
export const utf8_length_over = (text: string, max_bytes: number): number | null => {
	if (text.length * 3 <= max_bytes) return null;
	const size = text_encoder.encode(text).byteLength;
	return size > max_bytes ? size : null;
};

/**
 * The UTF-8 byte length of `text`.
 *
 * @param text - the string to measure
 * @returns its length in UTF-8 bytes
 */
export const utf8_length = (text: string): number => text_encoder.encode(text).byteLength;

// TODO figure out the symmetry of frontend and backend transports (none/partial/full?) --
// we may also need orthogonal abstractions to clarify the transport role

export const TransportName = z.string(); // not branded for convenience, will just error at runtime, the schema is just for docs atm
export type TransportName = z.infer<typeof TransportName>;

/**
 * Per-call options accepted by every transport's `send`. Optional and
 * extensible — adding a field is non-breaking. Source of truth for the
 * shared option shape; `ActionDispatcherSendOptions` and `RpcClientCallOptions`
 * extend it.
 */
export interface TransportSendOptions {
	/**
	 * Per-call cancellation. Bottoms out at
	 * `FrontendWebsocketClient.request({signal})` on the WS path (sends the
	 * shared `cancel` notification on abort) and at `fetch({signal})` on
	 * HTTP.
	 */
	signal?: AbortSignal;
	/**
	 * Per-call durable-queue opt-in. Names the **client-authoritative vs
	 * server-authoritative** distinction — server-authoritative consumers
	 * (e.g. zzz completion calls) fail fast with `service_unavailable` when
	 * the transport is down; client-authoritative consumers (games,
	 * real-time apps) buffer and replay on reconnect because the user
	 * already committed to the action at click time. Honored only by
	 * `FrontendWebsocketTransport` on the `request_response` path (default
	 * `false`), and by `Transports.get_transport`, which chooses a transport
	 * that `queues` for such a request even while it is disconnected. HTTP
	 * ignores it; WS notifications also ignore it and always fail-fast when
	 * disconnected (fire-and-forget `connection.send` has no queue semantic).
	 */
	queue?: boolean;
}

export interface Transport {
	transport_name: TransportName;

	send(message: JsonrpcRequest, options?: TransportSendOptions): Promise<JsonrpcResponseOrError>;
	send(
		message: JsonrpcNotification,
		options?: TransportSendOptions
	): Promise<JsonrpcErrorResponse | null>;
	send(
		message: JsonrpcMessageFromClientToServer,
		options?: TransportSendOptions
	): Promise<JsonrpcMessageFromServerToClient | null>;
	is_ready: () => boolean;
	/**
	 * Whether a request sent with `queue: true` waits while the transport is
	 * not ready — buffered and sent once it is — rather than failing. Read at
	 * each choice, so it can change: `FrontendWebsocketTransport` queues (its
	 * connection's durable queue) only while its connection will reopen on its
	 * own. A transport that leaves this unset never does, and is chosen only
	 * when ready.
	 */
	readonly queues?: boolean;
	dispose?: () => void;
}

/** Options for `Transports.get_transport`. */
export interface GetTransportOptions {
	/**
	 * The call is a request sent with `queue: true` — a transport that
	 * `queues` is chosen even while not ready, so the request waits for it.
	 */
	queue?: boolean;
}

/**
 * The transports a peer sends through, by name. The first registered is the
 * default a call that names none prefers.
 */
export class Transports {
	#default_transport: Transport | null = null;
	#transport_by_name: Map<TransportName, Transport> = new Map();

	/**
	 * Registers a transport. The first transport registered is the default.
	 *
	 * @mutates this - inserts into `#transport_by_name`; sets the default if
	 *   none is set
	 */
	register_transport(transport: Transport): void {
		this.#transport_by_name.set(transport.transport_name, transport); // TODO maybe ensure unregistering of any previous transport?

		if (!this.#default_transport) {
			this.#default_transport = transport;
		}
	}

	/**
	 * Resolve the transport a call goes out on: the preferred one — the named
	 * transport, or the default when no name is given — when it is ready, or
	 * when it is not but `options.queue` is set and it `queues` (the call
	 * waits for it); otherwise the first ready transport, the default first.
	 *
	 * @param transport_name - the transport the call prefers; the default when omitted
	 * @param options - whether the call is a queued request
	 * @returns the resolved transport, or `null` when none can take the call
	 */
	get_transport(transport_name?: TransportName, options?: GetTransportOptions): Transport | null {
		const preferred = transport_name
			? this.#transport_by_name.get(transport_name)
			: this.#default_transport;
		if (preferred && (preferred.is_ready() || (options?.queue && preferred.queues))) {
			return preferred;
		}
		if (this.#default_transport?.is_ready()) return this.#default_transport;
		for (const transport of this.#transport_by_name.values()) {
			if (transport.is_ready()) return transport;
		}
		return null;
	}
}
