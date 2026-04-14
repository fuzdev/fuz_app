/**
 * Transport abstraction for action communication.
 *
 * Provides the `Transport` interface and `Transports` registry for managing
 * multiple transports with fallback behavior.
 *
 * @module
 */

import {z} from 'zod';

import type {
	JsonrpcMessageFromClientToServer,
	JsonrpcMessageFromServerToClient,
	JsonrpcNotification,
	JsonrpcRequest,
	JsonrpcResponseOrError,
	JsonrpcErrorResponse,
} from '../http/jsonrpc.js';

/** WebSocket close code for session revocation. */
export const WS_CLOSE_SESSION_REVOKED = 4001;

// TODO figure out the symmetry of frontend and backend transports (none/partial/full?) --
// we may also need orthogonal abstractions to clarify the transport role

export const TransportName = z.string(); // not branded for convenience, will just error at runtime, the schema is just for docs atm
export type TransportName = z.infer<typeof TransportName>;

export interface Transport {
	transport_name: TransportName;
	/* eslint-disable @typescript-eslint/method-signature-style */
	send(message: JsonrpcRequest): Promise<JsonrpcResponseOrError>;
	send(message: JsonrpcNotification): Promise<JsonrpcErrorResponse | null>;
	send(message: JsonrpcMessageFromClientToServer): Promise<JsonrpcMessageFromServerToClient | null>;
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
	 * Registers a transport.
	 */
	register_transport(transport: Transport): void {
		this.#transport_by_name.set(transport.transport_name, transport); // TODO maybe ensure unregistering of any previous transport?

		// Set current transport if not already set
		if (!this.#current_transport) {
			this.#current_transport = transport;
		}
	}

	set_current_transport(transport_name: TransportName): void {
		const transport = this.#transport_by_name.get(transport_name);
		if (!transport) throw new Error(`transport not registered: ${transport_name}`);
		this.#current_transport = transport;
	}

	/**
	 * Gets either the current transport or the first ready transport
	 * depending on `allow_fallback`, or throws an error.
	 * @param transport_name - optional transport to use instead of the current
	 * @throws when no transport available or ready
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

	/**
	 * Gets the specified transport, defaulting to the current, or throws an error.
	 * @param transport_name - optional transport type to use instead of the current
	 * @throws when no transport available or ready
	 */
	#get_exact(transport_name?: TransportName): Transport | null {
		const transport = transport_name
			? this.#transport_by_name.get(transport_name)
			: this.#current_transport;

		if (transport?.is_ready()) {
			return transport;
		}

		return null;
	}

	/**
	 * Gets the appropriate transport or throws an error.
	 * @param transport_name - optional transport type or array of types to use instead of the current
	 * @throws when no transport available or ready
	 */
	#get_first_ready(transport_name?: TransportName | Array<TransportName>): Transport | null {
		// First try the specified transport(s) if provided
		if (transport_name) {
			const transport_names = Array.isArray(transport_name) ? transport_name : [transport_name];

			for (const transport_name of transport_names) {
				const transport = this.#transport_by_name.get(transport_name);
				if (transport?.is_ready()) {
					return transport;
				}
			}
		}

		// Then try the current transport if it's ready
		if (this.#current_transport?.is_ready()) {
			return this.#current_transport;
		}

		// Finally, try any other available transport
		for (const transport of this.#transport_by_name.values()) {
			if (transport.is_ready()) {
				return transport;
			}
		}

		return null;
	}
}
