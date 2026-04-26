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

import type {Result} from '@fuzdev/fuz_util/result.js';

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
import type {ActionPeer, ActionPeerSendOptions} from './action_peer.js';
import type {ActionEventDataUnion} from './action_event_data.js';
import type {TransportName} from './transports.js';
import {jsonrpc_error_messages} from '../http/jsonrpc_errors.js';
import type {JsonrpcErrorObject} from '../http/jsonrpc.js';

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
 * Per-call options accepted by every typed Proxy method. Same shape as
 * `ActionPeerSendOptions` — the client threads these through unchanged
 * to the underlying peer. `transport_name` overrides the per-method
 * `transport_for_method` selector for this call.
 */
export interface RpcClientCallOptions extends ActionPeerSendOptions {} // eslint-disable-line @typescript-eslint/no-empty-object-type

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
			queue: options?.queue,
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
				queue: options?.queue,
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

/**
 * `method, input -> unwrapped output` signature for adapter wiring.
 *
 * The typed `create_rpc_client` Proxy returns `Result<T, JsonrpcErrorObject>`
 * on every call. UI adapters (e.g. `admin_rpc_adapters.ts`) want a
 * throw-on-error shape so form components can match on `error.data.reason`
 * via catch blocks. `create_throwing_rpc_call` bridges the two.
 */
export type ThrowingRpcCall = <TOutput = unknown>(
	method: string,
	input?: unknown,
) => Promise<TOutput>;

/**
 * Wrap a typed RPC client so every call returns its unwrapped value or throws.
 *
 * On `{ok: false}`, throws an `Error` whose `message` comes from the
 * JSON-RPC error object, plus `{code, data}` as own properties — so
 * catch blocks reading `err.message` / `err.code` / `err.data?.reason`
 * all work. On unknown method, throws a clear "rpc method not found"
 * error instead of the cryptic `undefined is not a function` that
 * would otherwise surface.
 *
 * Invariant upheld by `create_rpc_client`: every `{ok: false}` return
 * carries a well-formed `JsonrpcErrorObject` with `code` + `message`.
 * Callers must still use optional chaining on `err.data` because the
 * JSON-RPC `data` field is spec-level optional — a handler that throws
 * `jsonrpc_errors.forbidden()` without a `data` argument produces
 * `err.data === undefined`.
 *
 * Only `{code, data}` cross onto the thrown Error — `message` flows
 * through the `Error` constructor argument, and `name` / `stack` are
 * left as the Error's own so attacker-shaped `result.error` payloads
 * cannot overwrite them.
 *
 * The mapped-type generic constraint accepts both shapes without a cast:
 * a codegen-derived typed `ActionsApi` (named-method interface, e.g.
 * `{account_verify: (input) => Promise<Result<...>>, ...}`) and a loose
 * `Record<string, (input?: any) => Promise<any> | void>`. Using `keyof TApi`
 * in the constraint avoids the index-signature requirement that would
 * otherwise force consumers to `as unknown as Record<string, …>` their
 * generated client. The `| void` arm tolerates `remote_notification`
 * methods, whose `ActionsApi` signature is `(input) => void` even though
 * `create_remote_notification_method` returns a Promise at runtime — the
 * throwing wrapper is intended for `request_response` calls but must
 * accept mixed `ActionsApi` shapes without forcing a cast at the seam.
 *
 * @param api - typed RPC client from `create_rpc_client` (or any object
 *   whose values are all `(input?) => Promise<...> | void` functions —
 *   notably the consumer's generated `ActionsApi` interface)
 */
export const create_throwing_rpc_call = <
	TApi extends Record<keyof TApi, (input?: any) => Promise<any> | void>,
>(
	api: TApi,
): ThrowingRpcCall => {
	const rec = api as unknown as Record<string, ((input?: any) => Promise<any>) | undefined>;
	return async <TOutput = unknown>(method: string, input?: unknown): Promise<TOutput> => {
		const fn = rec[method];
		if (!fn) throw new Error(`rpc method not found: ${method}`);
		const result = await fn(input);
		if (!result.ok) {
			throw Object.assign(new Error(result.error?.message ?? 'rpc error'), {
				code: result.error?.code,
				data: result.error?.data,
			});
		}
		return result.value as TOutput;
	};
};

/**
 * Maps a typed `ActionsApi` to a throwing variant.
 *
 * For each method whose return type matches the `create_rpc_client` shape
 * (`Promise<Result<{value: T}, {error: JsonrpcErrorObject}>>`), the wrapped
 * method returns `Promise<T>` directly. Other shapes (notifications typed
 * as `=> void`, sync `local_call` methods) pass through unchanged — there
 * is nothing to unwrap.
 *
 * Input + options parameters are preserved verbatim so generics, branded
 * Uuids, and per-call `RpcClientCallOptions` keep working.
 */
export type ThrowingApi<TApi> = {
	[K in keyof TApi]: TApi[K] extends (
		input?: infer TInput,
		options?: infer TOptions,
	) => Promise<Result<{value: infer TValue}, {error: JsonrpcErrorObject}>>
		? (input?: TInput, options?: TOptions) => Promise<TValue>
		: TApi[K];
};

/**
 * Wrap a typed RPC client so every call resolves to its unwrapped value or
 * throws an `Error` carrying the JSON-RPC `{code, message, data?}` shape.
 *
 * Implementation is a Proxy because the underlying `create_rpc_client`
 * return is itself a Proxy with no concrete keys — a key-by-key wrap would
 * need to enumerate the typed surface, which only the consumer's generated
 * `ActionsApi` interface knows.
 *
 * Pass-through on non-Result returns is deliberate: sync `local_call`
 * Proxy methods return values directly (see `create_sync_local_call_method`
 * above). The Proxy can't distinguish those at get-time, so the wrapper
 * inspects `result` shape at call-time and only unwraps when it sees a
 * Result. Non-object returns pass through unchanged.
 *
 * Only `{code, data}` cross onto the thrown Error — `name` / `stack` are
 * left as the Error's own properties so attacker-shaped `result.error`
 * payloads cannot overwrite them. Same hardening as
 * `create_throwing_rpc_call`.
 *
 * Composable with `create_throwing_rpc_call` — same typed underlying
 * client feeds both: the Proxy form for direct call sites, the loose
 * method-keyed form for adapter wiring (`ui/admin_rpc_adapters.ts`).
 *
 * Recommended consumer convention: bind the throwing wrapper to `api`
 * (the common case at call sites) and the underlying Result-returning
 * Proxy to `api_raw` (the composable escape hatch for callers that
 * want to inspect `error.data.reason` without try/catch).
 *
 * Catch blocks read `err.data?.reason` — optional chaining required
 * because JSON-RPC `data` is spec-level optional.
 *
 * On unknown string-keyed methods, the get trap returns a function that
 * throws `"rpc method not found: <prop>"` on invocation — symmetric with
 * `create_throwing_rpc_call` and clearer than the JS default
 * `"api.foo is not a function"`. Symbol props and `then` stay
 * undefined so the Proxy isn't accidentally treated as a thenable
 * (`await api` would otherwise probe `then` and trip the thrower).
 *
 * @param api_raw - typed RPC client from `create_rpc_client`, cast
 *   to a consumer-generated `ActionsApi` interface
 */
export const create_throwing_api = <TApi extends object>(api_raw: TApi): ThrowingApi<TApi> => {
	return new Proxy(api_raw as Record<string | symbol, unknown>, {
		get(target, prop) {
			const fn = target[prop];
			if (typeof fn === 'function') {
				return async (...args: Array<unknown>) => {
					const result = await (fn as (...args: Array<unknown>) => unknown).apply(target, args);
					if (result === null || typeof result !== 'object') return result;
					const r = result as {ok?: unknown; value?: unknown; error?: unknown};
					if (r.ok === true) return r.value;
					if (r.ok === false && r.error && typeof r.error === 'object') {
						const e = r.error as JsonrpcErrorObject;
						throw Object.assign(new Error(e.message), {
							code: e.code,
							data: e.data,
						});
					}
					return result;
				};
			}
			if (fn !== undefined) return fn;
			// Underlying api has no member by this name. Symbol props and
			// `then` must stay undefined — `await tapi` reads `then` and
			// would otherwise trip the thrower.
			if (typeof prop !== 'string' || prop === 'then') return undefined;
			return () => {
				throw new Error(`rpc method not found: ${prop}`);
			};
		},
	}) as unknown as ThrowingApi<TApi>;
};
