/**
 * ActionPeer — symmetric send/receive for JSON-RPC actions.
 *
 * Wraps a `Transports` registry and `ActionEventEnvironment` to provide
 * bidirectional action dispatch via JSON-RPC 2.0.
 *
 * @module
 */

import {
	JsonrpcMessageFromClientToServer,
	JsonrpcMessageFromServerToClient,
	JsonrpcNotification,
	JsonrpcRequest,
	JsonrpcResponseOrError,
	JsonrpcErrorResponse,
} from '../http/jsonrpc.ts';
import {
	create_jsonrpc_error_response,
	create_jsonrpc_error_response_from_thrown,
	to_jsonrpc_message_id,
	is_jsonrpc_request,
	is_jsonrpc_notification,
} from '../http/jsonrpc_helpers.ts';
import {jsonrpc_error_messages} from '../http/jsonrpc_errors.ts';
import {create_action_event} from './action_event.ts';
import {Transports, type TransportName, type TransportSendOptions} from './transports.ts';
import type {ActionEventEnvironment} from './action_event_types.ts';

// TODO @api @many refactor frontend_actions_api.ts with action_peer.ts

// TODO the goal is to make this fully symmetric but we're not quite there,
// this does receiving but only part of sending, and some deeper changes may be needed

/**
 * Per-call options for `ActionPeer.send`. Extends `TransportSendOptions`
 * with `transport_name` for per-call transport selection. The peer-wide
 * default for any field lives on `ActionPeerOptions.default_send_options` —
 * set `queue: true` there once for client-authoritative peers and override
 * per-call for exceptions (e.g. high-frequency position sync where stale
 * replays are wrong).
 */
export interface ActionPeerSendOptions extends TransportSendOptions {
	transport_name?: TransportName;
}

export interface ActionPeerOptions {
	environment: ActionEventEnvironment;

	// For sending - optional because some peers may be receive-only
	transports?: Transports;

	// Default send options. `signal` is excluded — signals are inherently
	// per-call (a shared signal would abort every subsequent call after the
	// first trip), and peer-level fallback wouldn't be applied anyway.
	default_send_options?: Omit<ActionPeerSendOptions, 'signal'>;
}

export class ActionPeer {
	readonly environment: ActionEventEnvironment;
	readonly transports: Transports;
	// TODO maybe expand the pattern of using `transports` in send, so what's used in receive?
	// It seems abstracting that out would make this class much simpler and generic, but too much so?
	// What deps should it actually know about, and what gains could we have by making it more decoupled?
	// e.g. don't just decouple for the sake of imagined flexibility!

	default_send_options: Omit<ActionPeerSendOptions, 'signal'>;

	constructor(options: ActionPeerOptions) {
		this.environment = options.environment;
		this.transports = options.transports ?? new Transports();
		this.default_send_options = options.default_send_options ?? {};
	}

	/**
	 * Resolve a transport (per-call name → default name → registry default)
	 * and forward the message. Catches unexpected throws and converts them
	 * to JSON-RPC error responses — this method never throws.
	 *
	 * @returns the response envelope for requests, or `null` for successful
	 *   notifications (`JsonrpcErrorResponse` if the notification's transport
	 *   send failed)
	 */
	// TODO the transport type option here may be bad magic
	async send(
		message: JsonrpcRequest,
		options?: ActionPeerSendOptions,
	): Promise<JsonrpcResponseOrError>;
	async send(
		message: JsonrpcNotification,
		options?: ActionPeerSendOptions,
	): Promise<JsonrpcErrorResponse | null>;
	async send(
		message: JsonrpcMessageFromClientToServer,
		options?: ActionPeerSendOptions,
	): Promise<JsonrpcMessageFromServerToClient | null> {
		try {
			const transport = this.transports.get_transport(
				options?.transport_name ?? this.default_send_options.transport_name,
			);

			if (!transport) {
				this.environment.log?.error('[peer] send failed: no transport available');
				return create_jsonrpc_error_response(
					to_jsonrpc_message_id(message),
					jsonrpc_error_messages.service_unavailable('no transport available'),
				);
			}

			const message_type = is_jsonrpc_request(message) ? 'request' : 'notification';
			this.environment.log?.debug(
				`[peer] send ${message_type}:`,
				message.method,
				`via ${transport.transport_name}`,
			);

			const result = await transport.send(message, {
				signal: options?.signal,
				queue: options?.queue ?? this.default_send_options.queue,
			});

			if (result && 'error' in result) {
				this.environment.log?.error(
					`[peer] send ${message_type} failed:`,
					message.method,
					result.error.message,
				);
			}

			return result;
		} catch (error) {
			// TODO add retry handling here?
			this.environment.log?.error('[peer] send unexpected error:', error);
			return create_jsonrpc_error_response_from_thrown(to_jsonrpc_message_id(message), error);
		} // TODO finally?
	}

	/**
	 * Dispatch an inbound JSON-RPC message — request, notification, or
	 * malformed envelope. Never throws; unexpected failures become
	 * JSON-RPC error responses.
	 *
	 * @returns response message for requests, `null` for notifications, or
	 *   an `invalid_request` error for malformed input
	 */
	async receive(message: unknown): Promise<JsonrpcMessageFromServerToClient | null> {
		try {
			const result = await this.#receive_message(message);
			return result;
		} catch (error) {
			this.environment.log?.error('[peer] receive unexpected error:', error);
			// Return appropriate error response based on the message
			return create_jsonrpc_error_response_from_thrown(to_jsonrpc_message_id(message), error);
		} // TODO finally?
	}

	async #receive_message(message: unknown): Promise<JsonrpcMessageFromServerToClient | null> {
		if (is_jsonrpc_request(message)) {
			return this.#receive_request(message);
		} else if (is_jsonrpc_notification(message)) {
			await this.#receive_notification(message);
			return null;
		} else {
			return create_jsonrpc_error_response(
				to_jsonrpc_message_id(message),
				jsonrpc_error_messages.invalid_request(),
			);
		}
	}

	async #receive_request(request: JsonrpcRequest): Promise<JsonrpcMessageFromServerToClient> {
		const spec = this.environment.lookup_action_spec(request.method);
		if (!spec) {
			this.environment.log?.warn(`[peer] receive request: method not found:`, request.method);
			return create_jsonrpc_error_response(
				request.id,
				jsonrpc_error_messages.method_not_found(request.method),
			);
		}

		this.environment.log?.debug(`[peer] receive request:`, request.method);

		try {
			// Create action event in receive_request phase
			const event = create_action_event(this.environment, spec, request.params, 'receive_request');
			event.set_request(request);

			// Parse and handle
			await event.parse().handle_async();

			// Check if we successfully handled the request
			if (event.data.step === 'handled') {
				// Transition to send_response phase
				event.transition('send_response');
				await event.parse().handle_async();

				// TODO doesn't seem exactly right, shouldn't need the guard, or needs some other tweaks
				// Return the response if any
				if (event.data.response) {
					return event.data.response;
				}
			}

			// Check for terminal failure
			if (event.data.step === 'failed') {
				this.environment.log?.error(
					`[peer] receive request failed:`,
					request.method,
					event.data.error,
				);
				return create_jsonrpc_error_response(request.id, event.data.error);
			}

			// Check if transitioned to error phase (send_error)
			if (event.data.phase === 'send_error') {
				// Error handler may exist - try to handle it (already parsed)
				await event.handle_async();

				// Return error response (handler may have modified/logged it)
				return create_jsonrpc_error_response(request.id, event.data.error);
			}

			// Fallback for unexpected states
			this.environment.log?.error(
				`[peer] receive request: unexpected state:`,
				request.method,
				event.data,
			);
			return create_jsonrpc_error_response(
				request.id,
				jsonrpc_error_messages.internal_error('unknown error'),
			);
		} catch (error) {
			this.environment.log?.error(`[peer] receive request exception:`, request.method, error);
			return create_jsonrpc_error_response_from_thrown(request.id, error);
		}
	}

	async #receive_notification(notification: JsonrpcNotification): Promise<void> {
		const spec = this.environment.lookup_action_spec(notification.method);
		if (!spec) {
			this.environment.log?.warn(
				`[peer] receive notification: method not found:`,
				notification.method,
			);
			return;
		}

		this.environment.log?.debug(`[peer] receive notification:`, notification.method);

		try {
			// Create action event in receive phase
			const event = create_action_event(this.environment, spec, notification.params, 'receive');
			event.set_notification(notification);

			// Parse and handle
			await event.parse().handle_async();

			if (event.data.step === 'failed') {
				this.environment.log?.error(
					`[peer] receive notification failed:`,
					notification.method,
					event.data.error,
				);
			}
		} catch (error) {
			this.environment.log?.error(
				`[peer] receive notification exception:`,
				notification.method,
				error,
			);
		}
	}
}
