/**
 * Typed RPC client — creates a Proxy-based API from action specs.
 *
 * Two tiers of usage:
 * - **Tier 1** (simple, for tx): transport send/receive, Result return. No `environment`.
 * - **Tier 2** (full, for zzz): ActionEvent lifecycle with `environment`.
 *
 * Pass the consumer's generated `ActionsApi` interface as `<TApi>` to flow
 * full type safety through without an explicit cast at the call site.
 *
 * @module
 */

import type { Result } from '@fuzdev/fuz_util/result.ts';

import type {
	ActionSpecUnion,
	LocalCallActionSpec,
	RemoteNotificationActionSpec,
	RequestResponseActionSpec
} from './action_spec.ts';
import type { ActionEventEnvironment } from './action_event_types.ts';
import { create_action_event, type ActionEvent } from './action_event.ts';
import {
	is_send_request,
	is_notification_send,
	extract_action_result
} from './action_event_helpers.ts';
import type { ActionDispatcher, ActionDispatcherSendOptions } from './action_dispatcher.ts';
import type { TransportName } from './transports.ts';
import { jsonrpc_error_messages } from '../http/jsonrpc_errors.ts';
import type { JsonrpcErrorObject } from '../http/jsonrpc.ts';

/**
 * Optional per-method transport selector. Return the transport to use for a
 * given method, or `undefined` to let the peer pick via its fallback rules.
 *
 * Useful when methods are registered on different backend dispatchers — e.g.
 * a streaming action mounted on the WebSocket endpoint while the rest of the
 * RPC surface lives on HTTP.
 */
export type TransportForMethod = (method: string) => TransportName | undefined;

// TODO @api @many refactor frontend_actions_api.ts with action_dispatcher.ts

// TODO @api think about unification between frontend|backend_actions_api.ts

/** Options for `create_rpc_client`. */
export interface CreateRpcClientOptions<TApi extends object = object> {
	peer: ActionDispatcher;
	environment: ActionEventEnvironment;
	/**
	 * Optional callback fired once per dispatched action with the live
	 * `ActionEvent`. Consumers wire reactive state here — e.g. zzz's `Actions`
	 * cell calls `add_from_json` + `listen_to_action_event` inside the
	 * callback so its history stays decoupled from the rpc_client surface.
	 *
	 * `event.spec.method` and `event.data.method` narrow to
	 * `keyof TApi & string` — drop the `as ActionMethod` cast at the call
	 * site when `TApi` is a generated `ActionsApi` interface.
	 */
	on_action_event?: (event: ActionEvent<keyof TApi & string>) => void;
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
 * Generic `TApi` is the consumer's typed Proxy interface (typically a
 * codegen-derived `ActionsApi`). Required — no default, so forgetting it
 * is a type error rather than a silent slide into `any`. The `as unknown
 * as TApi` coercion lives inside this function so call sites get a typed
 * return without a cast at the seam. `TApi` is a type-layer promise about
 * what the Proxy responds to; the runtime walks `specs` (kept in sync by
 * the consumer, codegen recommended).
 *
 * ```ts
 * const api_result = create_rpc_client<MyActionsApi>({peer, environment});
 * ```
 *
 * @returns a Proxy typed as `TApi` that responds to any method name found in the environment's specs
 */
export const create_rpc_client = <TApi extends object>(
	options: CreateRpcClientOptions<TApi>
): TApi => {
	const { peer, environment, on_action_event, transport_for_method } = options;

	// Internal factories construct broadly-typed `ActionEvent` instances; the
	// public callback narrows `event.spec.method` to `keyof TApi & string`.
	// Cast once here — function parameters are contravariant, so the narrow
	// callback isn't directly assignable to the broad slot the helpers take.
	const broad_on_action_event = on_action_event as ((event: ActionEvent) => void) | undefined;

	return new Proxy({} as Record<string, (...args: Array<unknown>) => unknown>, {
		get(_target, method: string) {
			const spec = environment.lookup_action_spec(method);
			if (!spec) {
				return undefined;
			}

			return create_action_method(
				peer,
				environment,
				spec,
				broad_on_action_event,
				transport_for_method
			);
		},
		has(_target, method: string) {
			return environment.lookup_action_spec(method) !== undefined;
		}
	}) as unknown as TApi;
};

const create_action_method = (
	peer: ActionDispatcher,
	environment: ActionEventEnvironment,
	spec: ActionSpecUnion,
	on_action_event?: (event: ActionEvent) => void,
	transport_for_method?: TransportForMethod
) => {
	switch (spec.kind) {
		case 'local_call':
			return spec.async
				? create_async_local_call_method(environment, spec, on_action_event)
				: create_sync_local_call_method(environment, spec, on_action_event);
		case 'request_response':
			return create_request_response_method(
				peer,
				environment,
				spec,
				on_action_event,
				transport_for_method
			);
		case 'remote_notification':
			return create_remote_notification_method(
				peer,
				environment,
				spec,
				on_action_event,
				transport_for_method
			);
	}
};

/** Sync local-call dispatch — returns the value directly; throws on error (no Result wrapping). */
const create_sync_local_call_method = (
	environment: ActionEventEnvironment,
	spec: LocalCallActionSpec,
	on_action_event?: (event: ActionEvent) => void
) => {
	return (input?: unknown) => {
		const event = create_action_event(environment, spec, input);
		on_action_event?.(event);

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
 * `ActionDispatcherSendOptions` — the client threads these through unchanged
 * to the underlying peer. `transport_name` overrides the per-method
 * `transport_for_method` selector for this call.
 */
export interface RpcClientCallOptions extends ActionDispatcherSendOptions {}

/**
 * Async local-call dispatch — returns Result.
 *
 * Local calls don't traverse a transport, so `transport_name` is ignored and
 * `signal` can only short-circuit before the synchronous handler runs (no
 * cooperative interrupt mid-handler).
 */
const create_async_local_call_method = (
	environment: ActionEventEnvironment,
	spec: LocalCallActionSpec,
	on_action_event?: (event: ActionEvent) => void
) => {
	return async (input?: unknown, options?: RpcClientCallOptions) => {
		if (options?.signal?.aborted) {
			return {
				ok: false as const,
				error: jsonrpc_error_messages.internal_error(`${spec.method} aborted before execution`)
			};
		}

		const event = create_action_event(environment, spec, input);
		on_action_event?.(event);

		await event.parse().handle_async();

		return extract_action_result(event);
	};
};

const create_request_response_method = (
	peer: ActionDispatcher,
	environment: ActionEventEnvironment,
	spec: RequestResponseActionSpec,
	on_action_event?: (event: ActionEvent) => void,
	transport_for_method?: TransportForMethod
) => {
	return async (input?: unknown, options?: RpcClientCallOptions) => {
		const event = create_action_event(environment, spec, input);
		on_action_event?.(event);

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
			queue: options?.queue
		});

		event.transition('receive_response');

		// TODO @api shouldn't this happen in the peer like the other method calls?
		event.set_response(response);

		event.parse(); // May transition to receive_error

		await event.handle_async();

		return extract_action_result(event);
	};
};

/** Fire-and-forget remote notification — returns `Result<{value: void}>` for consistency with `request_response`. */
const create_remote_notification_method = (
	peer: ActionDispatcher,
	environment: ActionEventEnvironment,
	spec: RemoteNotificationActionSpec,
	on_action_event?: (event: ActionEvent) => void,
	transport_for_method?: TransportForMethod
) => {
	return async (input?: unknown, options?: RpcClientCallOptions) => {
		const event = create_action_event(environment, spec, input);
		on_action_event?.(event);

		await event.parse().handle_async();

		if (!is_notification_send(event.data)) throw Error(); // TODO @many maybe make this an assertion helper?

		if (event.data.step === 'handled') {
			const send_result = await peer.send(event.data.notification, {
				transport_name: options?.transport_name ?? transport_for_method?.(spec.method),
				signal: options?.signal,
				queue: options?.queue
			});
			// Check if notification failed to send
			if (send_result !== null) {
				environment.log?.error('notification send failed:', send_result.error);
				return { ok: false, error: send_result.error };
			}
			return { ok: true, value: undefined };
		}

		return extract_action_result(event);
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
 * Input + options parameters are preserved verbatim via `...args: infer TArgs`
 * so the conditional matches both required-input (`input: T`) and
 * optional-input (`input?: T` / nullary) signatures uniformly. Required-input
 * shapes (e.g. `admin_session_revoke_all(input: AdminSessionRevokeAllInput)`)
 * are not assignable to a `(input?: TInput) => …` pattern under
 * `--strictFunctionTypes`, so an earlier `(input?, options?) =>` form
 * silently fell through to `TApi[K]` and left those methods Result-shaped —
 * `create_admin_rpc_adapters(api)` would then reject the typed throwing
 * Proxy because half its surface still returned `Result<...>`. The rest-args
 * form preserves both required and optional parameters and resolves the gap.
 */
export type ThrowingApi<TApi> = {
	[K in keyof TApi]: TApi[K] extends (
		...args: infer TArgs
	) => Promise<Result<{ value: infer TValue }, { error: JsonrpcErrorObject }>>
		? (...args: TArgs) => Promise<TValue>
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
 * payloads cannot overwrite them.
 *
 * Recommended consumer convention: `create_frontend_rpc_client` ships
 * both shapes by default — `api` (throwing) for hot-path call sites and
 * `api_result` (Result) for sites that inspect `error.data.reason`
 * without try/catch. Result is the protocol primitive; this wrapper is
 * the ergonomic layer over it. Picking is per call site — both Proxies
 * share the same underlying transport.
 *
 * Catch blocks read `err.data?.reason` — optional chaining required
 * because JSON-RPC `data` is spec-level optional.
 *
 * On unknown string-keyed methods, the get trap returns a function that
 * throws `"rpc method not found: <prop>"` on invocation — clearer than
 * the JS default `"api.foo is not a function"`. Symbol props and `then`
 * stay undefined so the Proxy isn't accidentally treated as a thenable
 * (`await api` would otherwise probe `then` and trip the thrower).
 *
 * @param api_result - typed Result-returning RPC client from
 *   `create_rpc_client<ActionsApi>(...)`. The "_result" suffix names
 *   what the underlying calls return (`Result<{value}, {error}>`).
 */
export const create_throwing_api = <TApi extends object>(api_result: TApi): ThrowingApi<TApi> => {
	return new Proxy(api_result as Record<string | symbol, unknown>, {
		get(target, prop) {
			const fn = target[prop];
			if (typeof fn === 'function') {
				return async (...args: Array<unknown>) => {
					const result = await (fn as (...args: Array<unknown>) => unknown).apply(target, args);
					if (result === null || typeof result !== 'object') return result;
					const r = result as { ok?: unknown; value?: unknown; error?: unknown };
					if (r.ok === true) return r.value;
					if (r.ok === false && r.error && typeof r.error === 'object') {
						const e = r.error as JsonrpcErrorObject;
						throw Object.assign(new Error(e.message), {
							code: e.code,
							data: e.data
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
		}
	}) as unknown as ThrowingApi<TApi>;
};
