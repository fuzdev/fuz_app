/**
 * Frontend-only typed RPC client factory.
 *
 * Bundles the `ActionRegistry + ActionEventEnvironment + Transports +
 * ActionDispatcher + create_rpc_client + create_throwing_api` boilerplate every
 * consumer repeats. `lookup_action_handler` defaults to `() => undefined`
 * (HTTP-only frontends rarely need handlers); pass `options.lookup_action_handler`
 * to wire WS-pushed `remote_notification` dispatch or a `receive_error` /
 * `local_call` hook.
 *
 * Transports: always a `FrontendHttpTransport` on `path` — a read
 * (`side_effects: false`) goes as a `GET` unless its input carries a
 * sensitive value (`'secret'` or `'personal'`) or its URL runs long, both
 * derived from `specs` — and, with `ws`, a
 * `FrontendWebsocketTransport` over the WebSocket client the caller passes,
 * which every `request_response` method routes to. The caller builds and
 * connects the client (`FrontendWebsocketClient`, its URL from
 * `to_same_origin_ws_url`), so an HTTP-only bundle never imports the socket.
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
 * `local_call` specs in `specs` no-op unless `lookup_action_handler`
 * resolves a handler for the `'execute'` phase. Frontend-side `local_call`
 * is uncommon; the factory targets wire-dispatched actions by default.
 *
 * @module
 */

import { ActionRegistry } from './action_registry.ts';
import { ActionDispatcher } from './action_dispatcher.ts';
import { Transports, type Transport } from './transports.ts';
import { FrontendHttpTransport } from './transports_http.ts';
import { FrontendWebsocketTransport, type WebsocketRpcConnection } from './transports_ws.ts';
import {
	create_rpc_client,
	create_throwing_api,
	type ThrowingApi,
	type TransportForMethod
} from './rpc_client.ts';
import type { ActionEvent } from './action_event.ts';
import type { ActionEventEnvironment } from './action_event_types.ts';
import type { ActionSpecUnion } from './action_spec.ts';

/** Options for `create_frontend_rpc_client`. */
export interface CreateFrontendRpcClientOptions<TApi extends object = object> {
	/**
	 * Action specs the typed Proxy can dispatch. Methods absent from this
	 * list silently return `undefined` from the Proxy — the generic `TApi`
	 * cannot constrain runtime membership, so consumers must keep this list
	 * in sync with the typed surface (codegen recommended).
	 *
	 * Protocol actions (`heartbeat`, `cancel`) are **not** auto-spread —
	 * they're filtered out of generated `action_specs` by codegen's
	 * `include_protocol_actions: false` default and consumers spread them
	 * in explicitly so the contract stays visible at every registration
	 * site. For WS-using consumers, spread `protocol_action_specs` from
	 * `actions/protocol.ts` here:
	 * `specs: [...protocol_action_specs, ...action_specs]`. HTTP-only
	 * consumers can omit them.
	 */
	specs: ReadonlyArray<ActionSpecUnion>;
	/**
	 * HTTP RPC endpoint path for the default `FrontendHttpTransport`.
	 * Defaults to `/api/rpc`. Ignored when `transports` is provided.
	 */
	path?: string;
	/** Extra headers on every HTTP RPC call — see `FrontendHttpTransportOptions.headers`. */
	http_headers?: Record<string, string>;
	/**
	 * The longest path and query a read is sent as a `GET` with — see
	 * `FrontendHttpTransportOptions.max_get_url_length`.
	 */
	max_get_url_length?: number;
	/**
	 * A WebSocket lane: a `FrontendWebsocketTransport` over `client`, registered
	 * after the HTTP transport, which every `request_response` method routes to
	 * unless `transport_for_method` says otherwise — the HTTP transport stays
	 * the fallback while the socket is down. Server-pushed requests and
	 * notifications on the socket dispatch through the peer
	 * (`lookup_action_handler`).
	 */
	ws?: FrontendRpcClientWsOptions;
	/**
	 * Optional explicit transport list. When provided, the default
	 * `FrontendHttpTransport(path)` is **not** registered — the caller is
	 * responsible for at least one ready transport. Exclusive with `ws`,
	 * `http_headers`, and `max_get_url_length`, which configure the built-in
	 * transports.
	 */
	transports?: ReadonlyArray<Transport>;
	/**
	 * Optional per-method transport selector — pure pass-through to
	 * `create_rpc_client`. Return the transport name to use for a given
	 * method, or `undefined` to fall back to the peer's default selection.
	 * With `ws` set it defaults to routing every `request_response` method to
	 * the WebSocket.
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
	/**
	 * Optional handler resolver. Wired onto `environment.lookup_action_handler`
	 * — the registry the dispatcher uses to find handlers for inbound
	 * messages and lifecycle phases. Defaults to `() => undefined`, which
	 * is fine for HTTP-only frontends that never receive a server-pushed
	 * notification or register a `receive_error` recovery hook.
	 *
	 * Common reasons to provide this:
	 * - **Server-pushed notifications over WS** — return a handler for
	 *   `(method, 'receive')` so a `remote_notification` arriving on the
	 *   socket dispatches to your subscriber bus (tx-style).
	 * - **Per-method retry / telemetry on errors** — return a handler for
	 *   `(method, 'receive_error')`. Note that as of the
	 *   `extract_action_result` fix, a missing handler already produces
	 *   `{ok: false, error}` — the stub is no longer required just to
	 *   surface server errors.
	 */
	lookup_action_handler?: ActionEventEnvironment['lookup_action_handler'];
	/**
	 * Where dispatch diagnostics go — pure pass-through to
	 * `environment.log`. Unset falls back to `console_action_log`; `null`
	 * silences them (see `resolve_action_log`).
	 */
	log?: ActionEventEnvironment['log'];
}

/** The WebSocket lane of `create_frontend_rpc_client`. */
export interface FrontendRpcClientWsOptions {
	/**
	 * The WebSocket client — typically a `FrontendWebsocketClient` over
	 * `to_same_origin_ws_url('/api/ws')`. The caller owns its lifecycle
	 * (`connect()` in the browser, `close()`).
	 */
	client: WebsocketRpcConnection;
	/**
	 * The peer's default `queue` — `true` for a client-authoritative app whose
	 * requests should wait out a disconnect in the socket's durable queue
	 * rather than fail. Per call, `RpcClientCallOptions.queue` overrides it.
	 *
	 * @default false
	 */
	queue?: boolean;
	/** See `FrontendWebsocketTransportOptions.max_message_bytes`. */
	max_message_bytes?: number | null;
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
	peer: ActionDispatcher;
	/** The `ws.client` the WebSocket lane runs over, or `null` without one. */
	socket: WebsocketRpcConnection | null;
	/** Action environment — exposed for consumers that need to share it (e.g. attach a notification handler registry). */
	environment: ActionEventEnvironment;
}

/** Build a frontend-only typed RPC client. See module doc for the bundle's design. */
export const create_frontend_rpc_client = <TApi extends object>(
	options: CreateFrontendRpcClientOptions<TApi>
): FrontendRpcClient<TApi> => {
	const { ws } = options;
	if (
		options.transports &&
		(ws || options.http_headers !== undefined || options.max_get_url_length !== undefined)
	) {
		throw new Error(
			'create_frontend_rpc_client: `transports` replaces the built-in transports, which `ws`, `http_headers`, and `max_get_url_length` configure — pass one or the other'
		);
	}
	const registry = new ActionRegistry([...options.specs]);
	const environment: ActionEventEnvironment = {
		executor: 'frontend',
		lookup_action_spec: (method) => registry.spec_by_method.get(method),
		lookup_action_handler: options.lookup_action_handler ?? (() => undefined),
		log: options.log
	};
	const transports = new Transports();
	const peer = new ActionDispatcher({
		environment,
		transports,
		default_send_options: ws?.queue ? { queue: true } : undefined
	});
	let ws_transport: FrontendWebsocketTransport | null = null;
	if (options.transports) {
		for (const t of options.transports) transports.register_transport(t);
	} else {
		transports.register_transport(
			new FrontendHttpTransport({
				url: options.path ?? '/api/rpc',
				headers: options.http_headers,
				lookup_action_spec: environment.lookup_action_spec,
				max_get_url_length: options.max_get_url_length
			})
		);
		if (ws) {
			ws_transport = new FrontendWebsocketTransport(ws.client, (data) => peer.receive(data), {
				max_message_bytes: ws.max_message_bytes
			});
			transports.register_transport(ws_transport);
		}
	}
	const ws_transport_name = ws_transport?.transport_name;
	const transport_for_method: TransportForMethod | undefined =
		options.transport_for_method ??
		(ws_transport_name
			? (method) =>
					registry.spec_by_method.get(method)?.kind === 'request_response'
						? ws_transport_name
						: undefined
			: undefined);
	const api_result = create_rpc_client<TApi>({
		peer,
		environment,
		on_action_event: options.on_action_event,
		transport_for_method
	});
	const api = create_throwing_api(api_result);
	return { api, api_result, peer, socket: ws?.client ?? null, environment };
};
