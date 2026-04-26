/**
 * Frontend-only typed RPC client factory.
 *
 * Bundles the `ActionRegistry + ActionEventEnvironment + Transports +
 * ActionPeer + create_rpc_client + create_throwing_api` boilerplate every
 * consumer repeats — plus the `lookup_action_handler: () => undefined`
 * stub (frontend never registers `request_response` handlers; every method
 * dispatches over the wire).
 *
 * Returns both Proxy shapes from one factory call:
 *
 * - `api` — typed throwing Proxy. `await api.foo(input)` returns the
 *   unwrapped value or throws an `Error` carrying `{code, data}` from the
 *   JSON-RPC error. Use at hot-path call sites.
 * - `api_result` — typed Result-shaped Proxy. `await api_result.foo(input)`
 *   returns `Result<{value}, {error: JsonrpcErrorObject}>`. Use when call
 *   sites want to inspect `error.data.reason` without try/catch — and
 *   anywhere allocating an `Error` per `{ok: false}` is wasteful (e.g.
 *   reconnect-storm `service_unavailable` paths). Result is the protocol
 *   primitive; the throwing form is a wrapper over it. Both share the
 *   same underlying transport — pick per call site, no construction cost.
 *
 * Generic `TApi` is the consumer's typed Proxy interface. The `as unknown
 * as TApi` double cast happens inside the helper so call sites get a
 * typed return value without the cast hostility. `api`'s type is
 * `ThrowingApi<TApi>` — the mapped type strips the Result wrapper.
 *
 * ```ts
 * const {api, api_result} = create_frontend_rpc_client<MyActionsApi>({
 *   specs: all_specs,
 * });
 * // hot path:    await api.account_verify()
 * // rare branch: const r = await api_result.account_verify(); if (!r.ok) { … }
 * ```
 *
 * Returns the underlying `peer` and `environment` alongside the two api
 * shapes so advanced consumers (zzz-style frontends needing extra
 * transports / WS notification handlers / action-history wiring) can
 * extend without recreating the bundle.
 *
 * Note: `local_call` specs in `specs` will silently no-op because
 * `lookup_action_handler` always returns `undefined` — the frontend
 * factory is for wire-dispatched actions. Frontend-side `local_call`
 * needs a different wiring shape (custom `environment.lookup_action_handler`).
 *
 * @module
 */

import {ActionRegistry} from './action_registry.js';
import {ActionPeer} from './action_peer.js';
import {Transports, type Transport} from './transports.js';
import {FrontendHttpTransport} from './transports_http.js';
import {
	create_rpc_client,
	create_throwing_api,
	type ThrowingApi,
	type TransportForMethod,
} from './rpc_client.js';
import type {ActionEvent} from './action_event.js';
import type {ActionEventEnvironment} from './action_event_types.js';
import type {ActionSpecUnion} from './action_spec.js';

/** Options for `create_frontend_rpc_client`. */
export interface CreateFrontendRpcClientOptions<TApi extends object = object> {
	/**
	 * Action specs the typed Proxy can dispatch. Methods absent from this
	 * list silently return `undefined` from the Proxy — the generic `TApi`
	 * cannot constrain runtime membership, so consumers must keep this list
	 * in sync with the typed surface (codegen recommended).
	 */
	specs: ReadonlyArray<ActionSpecUnion>;
	/**
	 * HTTP RPC endpoint path for the default `FrontendHttpTransport`.
	 * Defaults to `/api/rpc`. Ignored when `transports` is provided.
	 */
	path?: string;
	/**
	 * Optional explicit transport list. When provided, the default
	 * `FrontendHttpTransport(path)` is **not** registered — the caller is
	 * responsible for at least one ready transport. Use for WS-first or
	 * WS+HTTP mixed setups.
	 */
	transports?: ReadonlyArray<Transport>;
	/**
	 * Optional per-method transport selector — pure pass-through to
	 * `create_rpc_client`. Return the transport name to use for a given
	 * method, or `undefined` to fall back to the peer's default selection.
	 *
	 * Useful when methods are registered on different backend dispatchers
	 * (e.g. streaming actions on WS, REST RPC on HTTP) — a tx-style mixed
	 * setup. Per-call `RpcClientCallOptions.transport_name` overrides this
	 * for individual dispatches.
	 */
	transport_for_method?: TransportForMethod;
	/**
	 * Optional callback fired once per dispatched action — pure pass-through
	 * to `create_rpc_client`. Used by zzz-style consumers that thread the
	 * `ActionEvent` into a reactive cell (`add_from_json` + `listen_to_action_event`)
	 * for `pending` / `failed` / `value` derivations.
	 *
	 * `event.spec.method` and `event.data.method` narrow to
	 * `keyof TApi & string` — drop the `as ActionMethod` cast at the call
	 * site when `TApi` is a generated `ActionsApi` interface.
	 */
	on_action_event?: (event: ActionEvent<keyof TApi & string>) => void;
}

/** Bundle returned by `create_frontend_rpc_client`. */
export interface FrontendRpcClient<TApi> {
	/**
	 * Typed throwing Proxy. `await api.method(input)` returns the unwrapped
	 * value or throws an `Error` with `{code, data}` from the JSON-RPC
	 * error. Default for call sites that don't inspect errors.
	 */
	api: ThrowingApi<TApi>;
	/**
	 * Typed Result-shaped Proxy. `await api_result.method(input)` returns
	 * `Result<{value}, {error: JsonrpcErrorObject}>`. Use when call sites
	 * inspect `error.data.reason` without try/catch, or when Error
	 * allocation per `{ok: false}` would be wasteful.
	 */
	api_result: TApi;
	/** Underlying peer — exposed for consumers that need to register more transports or send raw messages. */
	peer: ActionPeer;
	/** Action environment — exposed for consumers that need to share it (e.g. attach a notification handler registry). */
	environment: ActionEventEnvironment;
}

/**
 * Build a frontend-only typed RPC client.
 *
 * @param options - `specs` (required), optional `path` / `transports` /
 *   `transport_for_method` / `on_action_event`
 * @returns `{api, api_result, peer, environment}` — both Proxy shapes plus
 *   the underlying primitives. `api` throws on `{ok: false}`; `api_result`
 *   returns the Result.
 */
export const create_frontend_rpc_client = <TApi extends object>(
	options: CreateFrontendRpcClientOptions<TApi>,
): FrontendRpcClient<TApi> => {
	const registry = new ActionRegistry([...options.specs]);
	const environment: ActionEventEnvironment = {
		executor: 'frontend',
		lookup_action_spec: (method) => registry.spec_by_method.get(method),
		lookup_action_handler: () => undefined,
	};
	const transports = new Transports();
	if (options.transports) {
		for (const t of options.transports) transports.register_transport(t);
	} else {
		transports.register_transport(new FrontendHttpTransport(options.path ?? '/api/rpc'));
	}
	const peer = new ActionPeer({environment, transports});
	const api_result = create_rpc_client<TApi>({
		peer,
		environment,
		on_action_event: options.on_action_event,
		transport_for_method: options.transport_for_method,
	});
	const api = create_throwing_api(api_result);
	return {api, api_result, peer, environment};
};
