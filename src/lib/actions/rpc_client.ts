/**
 * Typed RPC client — creates a Proxy-based API from action specs.
 *
 * Two tiers of usage:
 * - **Tier 1** (simple, for tx): transport send/receive, Result return. No `environment`.
 * - **Tier 2** (full, for zzz): ActionEvent lifecycle with `environment`.
 *
 * Consumers cast the return to their generated `ActionsApi` interface for full type safety.
 *
 * @module
 */

import type {
	ActionSpecUnion,
	LocalCallActionSpec,
	RemoteNotificationActionSpec,
	RequestResponseActionSpec,
} from './action_spec.js';
import type {ActionEventEnvironment} from './action_event_types.js';
import {create_action_event} from './action_event.js';
import {
	is_send_request,
	is_notification_send,
	extract_action_result,
} from './action_event_helpers.js';
import type {ActionPeer} from './action_peer.js';
import type {ActionEventDataUnion} from './action_event_data.js';
import type {TransportName} from './transports.js';
import {jsonrpc_error_messages} from '../http/jsonrpc_errors.js';

/**
 * Optional per-method transport selector. Return the transport to use for a
 * given method, or `undefined` to let the peer pick via its fallback rules.
 *
 * Useful when methods are registered on different backend dispatchers — e.g.
 * a streaming action mounted on the WebSocket endpoint while the rest of the
 * RPC surface lives on HTTP.
 */
export type TransportForMethod = (method: string) => TransportName | undefined;

// TODO @api @many refactor frontend_actions_api.ts with action_peer.ts

// TODO @api think about unification between frontend|backend_actions_api.ts

/** Duck-typed action history — consumers pass their concrete Actions cell. */
export interface RpcClientActionHistory {
	add_from_json: (json: {method: string; action_event_data: ActionEventDataUnion}) =>
		| {
				listen_to_action_event: (event: any) => void;
		  }
		| undefined;
}

/** Options for `create_rpc_client`. */
export interface CreateRpcClientOptions {
	peer: ActionPeer;
	environment: ActionEventEnvironment;
	/** Optional action history tracking (duck-typed Actions cell). */
	actions?: RpcClientActionHistory;
	/**
	 * Optional per-method transport selector. When provided, the client calls
	 * `peer.send(msg, {transport_name})` with the returned transport for each
	 * `request_response` / `remote_notification` dispatch. Returning `undefined`
	 * falls back to the peer's default selection.
	 */
	transport_for_method?: TransportForMethod;
}

/**
 * Creates a Proxy-based API from action specs.
 *
 * Method calls are dynamically dispatched based on the action spec's kind:
 * - `request_response` → send request, await response, return Result
 * - `remote_notification` → send notification, return Result
 * - `local_call` → execute locally (sync or async), return Result or throw
 *
 * @param options - client options (peer, environment, optional action history)
 * @returns a Proxy that responds to any method name found in the environment's specs
 */
export const create_rpc_client = (
	options: CreateRpcClientOptions,
): Record<string, (...args: Array<any>) => any> => {
	const {peer, environment, actions, transport_for_method} = options;

	return new Proxy({} as Record<string, (...args: Array<any>) => any>, {
		get(_target, method: string) {
			const spec = environment.lookup_action_spec(method);
			if (!spec) {
				return undefined;
			}

			return create_action_method(peer, environment, spec, actions, transport_for_method);
		},
		has(_target, method: string) {
			return environment.lookup_action_spec(method) !== undefined;
		},
	});
};

/**
 * Creates a method that executes an action through its complete lifecycle.
 */
const create_action_method = (
	peer: ActionPeer,
	environment: ActionEventEnvironment,
	spec: ActionSpecUnion,
	actions?: RpcClientActionHistory,
	transport_for_method?: TransportForMethod,
) => {
	switch (spec.kind) {
		case 'local_call':
			return spec.async
				? create_async_local_call_method(environment, spec, actions)
				: create_sync_local_call_method(environment, spec, actions);
		case 'request_response':
			return create_request_response_method(peer, environment, spec, actions, transport_for_method);
		case 'remote_notification':
			return create_remote_notification_method(
				peer,
				environment,
				spec,
				actions,
				transport_for_method,
			);
	}
};

/**
 * Creates a synchronous local call method.
 * Returns value directly - can throw on error (sync methods cannot return Result).
 */
const create_sync_local_call_method = (
	environment: ActionEventEnvironment,
	spec: LocalCallActionSpec,
	actions?: RpcClientActionHistory,
) => {
	return (input?: unknown) => {
		const event = create_action_event(environment, spec, input);
		const action = actions?.add_from_json({
			method: spec.method,
			action_event_data: event.toJSON(),
		});
		action?.listen_to_action_event(event);

		event.parse().handle_sync();

		const result = extract_action_result(event);
		if (result.ok) {
			return result.value;
		} else {
			// Sync methods must throw on error (cannot return Result synchronously)
			throw new Error(`${spec.method} failed: ${result.error.message}`);
		}
	};
};

/**
 * Per-call options accepted by every typed Proxy method. `signal` lets the
 * caller cancel an in-flight request (sends the shared `cancel` notification
 * on the WS path, aborts `fetch` on HTTP). `transport_name` overrides the
 * per-method `transport_for_method` selector for this call.
 */
export interface RpcClientCallOptions {
	signal?: AbortSignal;
	transport_name?: TransportName;
}

/**
 * Creates an asynchronous local call method.
 * Returns Result for type-safe error handling.
 *
 * Local calls don't traverse a transport, so `transport_name` is ignored and
 * `signal` can only short-circuit before the synchronous handler runs (no
 * cooperative interrupt mid-handler).
 */
const create_async_local_call_method = (
	environment: ActionEventEnvironment,
	spec: LocalCallActionSpec,
	actions?: RpcClientActionHistory,
) => {
	return async (input?: unknown, options?: RpcClientCallOptions) => {
		if (options?.signal?.aborted) {
			return {
				ok: false as const,
				error: jsonrpc_error_messages.internal_error(`${spec.method} aborted before execution`),
			};
		}

		const event = create_action_event(environment, spec, input);
		const action = actions?.add_from_json({
			method: spec.method,
			action_event_data: event.toJSON(),
		});
		action?.listen_to_action_event(event);

		await event.parse().handle_async();

		return extract_action_result(event);
	};
};

/**
 * Creates a request/response method that communicates over the network.
 */
const create_request_response_method = (
	peer: ActionPeer,
	environment: ActionEventEnvironment,
	spec: RequestResponseActionSpec,
	actions?: RpcClientActionHistory,
	transport_for_method?: TransportForMethod,
) => {
	return async (input?: unknown, options?: RpcClientCallOptions) => {
		const event = create_action_event(environment, spec, input);
		const action = actions?.add_from_json({
			method: spec.method,
			action_event_data: event.toJSON(),
		});
		action?.listen_to_action_event(event);

		await event.parse().handle_async();

		// Check if we're in send_error phase before type narrowing
		if (event.data.kind === 'request_response' && event.data.phase === 'send_error') {
			await event.handle_async(); // Call send_error handler
			return extract_action_result(event);
		}

		if (!is_send_request(event.data)) throw Error(); // TODO @many maybe make this an assertion helper?

		if (event.data.step !== 'handled') {
			return extract_action_result(event);
		}

		const response = await peer.send(event.data.request, {
			transport_name: options?.transport_name ?? transport_for_method?.(spec.method),
			signal: options?.signal,
		});

		event.transition('receive_response');

		// TODO @api shouldn't this happen in the peer like the other method calls?
		event.set_response(response);

		event.parse(); // May transition to receive_error

		await event.handle_async();

		return extract_action_result(event);
	};
};

/**
 * Creates a remote notification method (fire and forget).
 * Returns Result<{value: void}> for consistency.
 */
const create_remote_notification_method = (
	peer: ActionPeer,
	environment: ActionEventEnvironment,
	spec: RemoteNotificationActionSpec,
	actions?: RpcClientActionHistory,
	transport_for_method?: TransportForMethod,
) => {
	return async (input?: unknown, options?: RpcClientCallOptions) => {
		const event = create_action_event(environment, spec, input);
		const action = actions?.add_from_json({
			method: spec.method,
			action_event_data: event.toJSON(),
		});
		action?.listen_to_action_event(event);

		await event.parse().handle_async();

		if (!is_notification_send(event.data)) throw Error(); // TODO @many maybe make this an assertion helper?

		if (event.data.step === 'handled') {
			const send_result = await peer.send(event.data.notification, {
				transport_name: options?.transport_name ?? transport_for_method?.(spec.method),
				signal: options?.signal,
			});
			// Check if notification failed to send
			if (send_result !== null) {
				environment.log?.error('notification send failed:', send_result.error);
				return {ok: false, error: send_result.error};
			}
			return {ok: true, value: undefined};
		}

		return extract_action_result(event);
	};
};
