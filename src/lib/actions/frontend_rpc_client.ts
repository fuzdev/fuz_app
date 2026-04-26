/**
 * Frontend-only typed RPC client factory.
 *
 * Bundles the `ActionRegistry + ActionEventEnvironment + Transports +
 * ActionPeer + create_rpc_client` boilerplate every consumer repeats — plus
 * the `lookup_action_handler: () => undefined` stub (frontend never registers
 * `request_response` handlers; every method dispatches over the wire).
 *
 * Generic `TApi` is the consumer's typed Proxy interface. The `as unknown
 * as TApi` double cast happens inside the helper so call sites get a typed
 * return value without the cast hostility.
 *
 * Companion to `create_throwing_api` — typical wiring is two lines:
 *
 * ```ts
 * const {api: api_raw} = create_frontend_rpc_client<MyActionsApi>({specs: all_specs});
 * const api = create_throwing_api(api_raw);
 * ```
 *
 * Returns the underlying `peer` and `environment` alongside `api` so
 * advanced consumers (zzz-style frontends needing extra transports / WS
 * notification handlers / action-history wiring) can extend without
 * recreating the bundle.
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
import {create_rpc_client} from './rpc_client.js';
import type {ActionEventEnvironment} from './action_event_types.js';
import type {ActionSpecUnion} from './action_spec.js';

/** Options for `create_frontend_rpc_client`. */
export interface CreateFrontendRpcClientOptions {
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
}

/** Bundle returned by `create_frontend_rpc_client`. */
export interface FrontendRpcClient<TApi> {
	/** Typed Proxy — call `api.method(input)` for `Promise<Result<...>>`. */
	api: TApi;
	/** Underlying peer — exposed for consumers that need to register more transports or send raw messages. */
	peer: ActionPeer;
	/** Action environment — exposed for consumers that need to share it (e.g. attach a notification handler registry). */
	environment: ActionEventEnvironment;
}

/**
 * Build a frontend-only typed RPC client.
 *
 * @param options - `specs` (required), optional `path` / `transports`
 * @returns `{api, peer, environment}` — typed Proxy plus the underlying primitives
 */
export const create_frontend_rpc_client = <TApi>(
	options: CreateFrontendRpcClientOptions,
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
	const api = create_rpc_client({peer, environment}) as unknown as TApi;
	return {api, peer, environment};
};
