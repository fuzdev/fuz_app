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
 * WebSocket close code for session revocation.
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
/** WebSocket close code — client timed out waiting for a response. */
export const WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT = 4002;
/** WebSocket close code — server timed out with no incoming activity. */
export const WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT = 4003;
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
 * WebSocket close code — an inbound message exceeded the receiver's size cap
 * (RFC 6455 §7.4.1 "Message Too Big").
 */
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009;
/**
 * WebSocket close code — the server closed a socket that sent too much while
 * it was still opening: past `MAX_PRE_ADMISSION_FRAMES` frames or the
 * `PRE_ADMISSION_QUEUE_BYTES_FACTOR` byte budget, before its admission and
 * `on_socket_open` had completed (RFC 6455 §7.4.1 "Policy Violation"). Not a
 * revocation: the client reconnects under its ordinary backoff.
 */
export const WS_CLOSE_POLICY_VIOLATION = 1008;
/**
 * WebSocket close code — the server hit an unexpected condition (RFC 6455
 * §7.4.1 "Internal Error").
 *
 * Sent when an upgraded socket can't be admitted because its credential
 * re-check itself failed (a database error), and when an `on_socket_open` hook
 * throws. The handshake has already answered `101`, so an HTTP `500` is no
 * longer available. Not a revocation: the client's credential may be fine, so
 * it reconnects under its ordinary backoff rather than entering its `revoked`
 * state. The twin of the Rust spine's `WS_CLOSE_INTERNAL_ERROR`.
 */
export const WS_CLOSE_INTERNAL_ERROR = 1011;

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
	 * HTTP. Backend transport has no per-call abort surface to honor.
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
	 * `false`). HTTP and backend transports ignore it; WS notifications
	 * also ignore it and always fail-fast when disconnected (fire-and-forget
	 * `connection.send` has no queue semantic).
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
	dispose?: () => void;
}

export class Transports {
	#current_transport: Transport | null = null;
	#transport_by_name: Map<TransportName, Transport> = new Map();

	/**
	 * Whether to allow fallback to other transports if the current one is not available.
	 * @default true
	 */
	allow_fallback: boolean = true; // TODO allow registering transports with a priority level so this can be customized

	/**
	 * Registers a transport. The first transport registered also becomes the current.
	 *
	 * @mutates this - inserts into `#transport_by_name`; sets `#current_transport`
	 *   if no current is set
	 */
	register_transport(transport: Transport): void {
		this.#transport_by_name.set(transport.transport_name, transport); // TODO maybe ensure unregistering of any previous transport?

		if (!this.#current_transport) {
			this.#current_transport = transport;
		}
	}

	/**
	 * Switch the current transport selection by name.
	 *
	 * @mutates this - sets `#current_transport`
	 * @throws Error if no transport with `transport_name` has been registered
	 */
	set_current_transport(transport_name: TransportName): void {
		const transport = this.#transport_by_name.get(transport_name);
		if (!transport) throw new Error(`transport not registered: ${transport_name}`);
		this.#current_transport = transport;
	}

	/**
	 * Resolve a transport. With `allow_fallback`, walks specified → current →
	 * any-ready; without, returns the named transport (or current) only when
	 * it's ready.
	 *
	 * @returns the resolved transport, or `null` when none is ready
	 */
	get_transport(transport_name?: TransportName): Transport | null {
		return this.allow_fallback
			? this.#get_first_ready(transport_name)
			: this.#get_exact(transport_name);
	}

	// TODO these 4 arent used yet but seem useful? `get_transport` is the main method
	is_ready(): boolean | null {
		const transport = this.#current_transport;
		if (!transport) return null;
		return transport.is_ready();
	}

	get_current_transport(): Transport | null {
		return this.#current_transport ?? null;
	}

	get_current_transport_name(): TransportName | null {
		return this.#current_transport?.transport_name ?? null;
	}

	get_transport_by_name(transport_name: TransportName): Transport | null {
		return this.#transport_by_name.get(transport_name) ?? null;
	}

	#get_exact(transport_name?: TransportName): Transport | null {
		const transport = transport_name
			? this.#transport_by_name.get(transport_name)
			: this.#current_transport;

		if (transport?.is_ready()) {
			return transport;
		}

		return null;
	}

	#get_first_ready(transport_name?: TransportName | Array<TransportName>): Transport | null {
		if (transport_name) {
			const transport_names = Array.isArray(transport_name) ? transport_name : [transport_name];

			for (const transport_name of transport_names) {
				const transport = this.#transport_by_name.get(transport_name);
				if (transport?.is_ready()) {
					return transport;
				}
			}
		}

		if (this.#current_transport?.is_ready()) {
			return this.#current_transport;
		}

		for (const transport of this.#transport_by_name.values()) {
			if (transport.is_ready()) {
				return transport;
			}
		}

		return null;
	}
}
