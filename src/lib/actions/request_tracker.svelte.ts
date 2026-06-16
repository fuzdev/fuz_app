/**
 * Request tracker — manages pending JSON-RPC requests with timeouts.
 *
 * Uses SvelteMap for reactive pending request tracking.
 *
 * @module
 */

import {create_deferred, type Deferred, type AsyncStatus} from '@fuzdev/fuz_util/async.ts';
import {SvelteMap} from 'svelte/reactivity';

import {
	JSONRPC_INTERNAL_ERROR,
	type JsonrpcErrorResponse,
	type JsonrpcRequestId,
	type JsonrpcResponseOrError,
} from '../http/jsonrpc.ts';
import {ThrownJsonrpcError, JSONRPC_ERROR_CODES} from '../http/jsonrpc_errors.ts';

/** ISO datetime string for request creation timestamps. */
type Datetime = string & {readonly __brand: 'Datetime'};
const get_datetime_now = (): Datetime => new Date().toISOString() as Datetime;

// TODO what if this uses a tracker id param that's an opaque UUID but can be used for action association?

// TODO name, like `TrackedRequest`? or is this implicit namespacing and generic name preferred
export class RequestTrackerItem {
	readonly id: JsonrpcRequestId;
	readonly deferred: Deferred<JsonrpcResponseOrError>;
	readonly created: Datetime;
	status: AsyncStatus = $state.raw()!;
	timeout: NodeJS.Timeout | undefined = $state.raw();

	constructor(
		id: JsonrpcRequestId,
		deferred: Deferred<JsonrpcResponseOrError>,
		created: Datetime,
		status: AsyncStatus,
		timeout: NodeJS.Timeout | undefined,
	) {
		this.id = id;
		this.deferred = deferred;
		this.created = created;
		this.status = status;
		this.timeout = timeout;
	}
}

/**
 * Reactive pending-request store with per-request timeouts. Used by transports
 * that don't delegate request/response correlation to a `WebsocketRpcConnection`.
 */
export class RequestTracker {
	readonly pending_requests: SvelteMap<JsonrpcRequestId, RequestTrackerItem> = new SvelteMap();
	readonly request_timeout_ms: number;

	constructor(request_timeout_ms = 120_000) {
		this.request_timeout_ms = request_timeout_ms;
	}

	/**
	 * Track a new request keyed by `id`.
	 *
	 * @returns deferred resolved on response, or rejected via the timeout
	 * @mutates this - inserts a `RequestTrackerItem` into `pending_requests`
	 *   and arms a timeout that auto-rejects after `request_timeout_ms`;
	 *   clears any prior timeout for the same id
	 */
	track_request(id: JsonrpcRequestId): Deferred<JsonrpcResponseOrError> {
		const deferred = create_deferred<JsonrpcResponseOrError>();
		const created = get_datetime_now();

		// If we're tracking a request with the same id, clean up the previous one first
		const existing_request = this.pending_requests.get(id);
		if (existing_request?.timeout) {
			clearTimeout(existing_request.timeout);
		}

		// Set up a timeout to automatically reject the request after a delay
		const timeout = setTimeout(() => {
			// Create a proper timeout error message
			this.reject_request(id, {
				jsonrpc: '2.0' as const,
				id,
				error: {code: JSONRPC_INTERNAL_ERROR, message: `request timed out: ${id}`},
			});
		}, this.request_timeout_ms);

		// Store the request tracker using the new class
		this.pending_requests.set(
			id,
			new RequestTrackerItem(id, deferred, created, 'pending', timeout),
		);

		return deferred;
	}

	/**
	 * Resolve a pending request with its response.
	 *
	 * @mutates this - clears the timeout, marks status `'success'`,
	 *   resolves the deferred, and removes the entry from `pending_requests`
	 */
	resolve_request(id: JsonrpcRequestId, response: JsonrpcResponseOrError): void {
		const request = this.pending_requests.get(id);
		if (!request) {
			console.warn(`received response for unknown request: ${id}`);
			return;
		}

		// Clear the timeout and resolve the promise
		if (request.timeout) {
			clearTimeout(request.timeout);
			request.timeout = undefined;
		}

		request.status = 'success';
		request.deferred.resolve(response);
		this.pending_requests.delete(id);
	}

	/**
	 * Reject a pending request with `error_message`.
	 *
	 * @mutates this - clears the timeout, marks status `'failure'`,
	 *   rejects the deferred with a `ThrownJsonrpcError`, and removes the
	 *   entry from `pending_requests`
	 */
	reject_request(id: JsonrpcRequestId, error_message: JsonrpcErrorResponse): void {
		const request = this.pending_requests.get(id);
		if (!request) {
			console.warn(`received error for unknown request: ${id}`);
			return;
		}

		// Clear the timeout and reject the promise
		if (request.timeout) {
			clearTimeout(request.timeout);
			request.timeout = undefined;
		}

		request.status = 'failure';
		const error = new ThrownJsonrpcError(
			error_message.error.code,
			error_message.error.message,
			error_message.error.data,
		);
		request.deferred.reject(error);
		this.pending_requests.delete(id);
	}

	/**
	 * Handles an incoming JSON-RPC message. Resolves or rejects the associated request.
	 * Ignores notifications and unknown/invalid messages.
	 */
	handle_message(message: any): void {
		if (!message) return; // ignore invalid values

		const {id} = message;
		// TODO maybe log a warning/error?
		if (id == null) return; // ignore notifications and errors without ids

		// JSON-RPC responses require both an `id` and either a `result` or `error` field, but not both
		if ('result' in message) {
			this.resolve_request(id, message);
		} else if ('error' in message) {
			this.reject_request(id, message);
		}

		// ignore other messages
	}

	/**
	 * Cancel a pending request without rejecting its deferred — just
	 * cleanup. The caller's promise stays unsettled; pair with an external
	 * resolution if needed.
	 *
	 * @mutates this - clears the timeout and removes the entry from `pending_requests`
	 */
	cancel_request(id: JsonrpcRequestId): void {
		const request = this.pending_requests.get(id);
		if (!request) {
			return;
		}

		if (request.timeout) {
			clearTimeout(request.timeout);
			request.timeout = undefined;
		}

		// We don't reject the promise here, just clean up the tracking
		this.pending_requests.delete(id);
	}

	/**
	 * Cancel all pending requests.
	 * @param reason - optional reason to include in rejection
	 * @mutates this - clears every timeout, marks each status `'failure'`,
	 *   rejects each deferred with `internal_error`, and empties `pending_requests`
	 */
	cancel_all_requests(reason?: string): void {
		for (const [id, request] of this.pending_requests.entries()) {
			if (request.timeout) {
				clearTimeout(request.timeout);
				request.timeout = undefined;
			}

			request.status = 'failure';
			request.deferred.reject(
				new ThrownJsonrpcError(
					JSONRPC_ERROR_CODES.internal_error, // TODO canceled error?
					reason || 'request cancelled',
				),
			);
			this.pending_requests.delete(id);
		}
	}
}
