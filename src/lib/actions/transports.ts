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

/** WebSocket close code for session revocation. */
export const WS_CLOSE_SESSION_REVOKED = 4001;
/** WebSocket close code — client timed out waiting for a response. */
export const WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT = 4002;
/** WebSocket close code — server timed out with no incoming activity. */
export const WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT = 4003;

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
