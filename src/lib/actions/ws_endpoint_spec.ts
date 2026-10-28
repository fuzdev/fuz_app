/**
 * `WsEndpointSpec` — the canonical WebSocket endpoint declaration consumed
 * by `create_app_server`'s `ws_endpoints` option (mirror of `RpcEndpointSpec`
 * for HTTP RPC).
 *
 * Also `resolve_ws_endpoints`, which fills in the server's `allowed_origins`
 * and, for a spec that omits them, the actions of the sole RPC endpoint.
 *
 * Lives in its own module so both `server/app_server.ts` (which mounts
 * endpoints from these specs) and `http/surface.ts` (which threads the
 * resolved spec list into surface generation) can import it without a
 * cycle between the two.
 *
 * @module
 */

import type { Action } from './action_types.ts';
import type { RoleName } from '../auth/role_schema.ts';
import type { ConnectionRegistry } from './connection_registry.ts';
import type { SocketCloseContext, SocketOpenContext } from './ws_socket_session.ts';
import type { RpcEndpointSpec } from '../http/surface.ts';
import { to_ws_actions } from './protocol.ts';

/**
 * Declarative description of a WebSocket endpoint to be auto-mounted by
 * `create_app_server`.
 *
 * Single source of truth for mount + surface — the same array drives
 * `register_action_ws` upgrade wiring AND the `surface.ws_endpoints`
 * slot emitted into `AppSurface`, so consumers cannot drift their declared
 * actions from what dispatch actually serves.
 */
export interface WsEndpointSpec {
	/** Hono mount path (e.g. `/api/ws`). */
	path: string;
	/**
	 * Origin allowlist regexes for the upgrade — passed straight to
	 * `verify_request_source`. Defaults to the server's
	 * `AppServerOptions.allowed_origins`, the list the HTTP routes check.
	 * Set it only to narrow one endpoint: the auth middleware's origin check
	 * runs on the upgrade too, so a request reaches the endpoint only when
	 * its origin passes both lists. An empty list throws at assembly.
	 */
	allowed_origins?: ReadonlyArray<RegExp>;
	/**
	 * The actions registered on this endpoint. Spread `protocol_actions`
	 * from `actions/protocol.ts` first to complete the
	 * disconnect-detection + per-request cancel pairing with the frontend
	 * client.
	 *
	 * Omit to serve the actions of the server's sole `rpc_endpoints` entry —
	 * `to_ws_actions` of its list, the protocol actions first — so one action
	 * set (one set of handler closures) runs on both transports. Assembly
	 * throws when it is omitted and the server resolves no RPC endpoint or
	 * more than one.
	 */
	actions?: ReadonlyArray<Action>;
	/**
	 * Roles permitted to upgrade — any-of disjunction, global grants only.
	 * Omit (or pass `[]`) to skip the upgrade-time role gate; per-action
	 * `auth` on each spec still applies at dispatch time via
	 * `perform_action`. Pass `[ROLE_ADMIN]` for an admin-only WS endpoint.
	 * Held for the socket's life — see `register_action_ws`'s
	 * `required_roles`.
	 */
	required_roles?: ReadonlyArray<RoleName>;
	/**
	 * Existing registry to register connections with. Auto-created when
	 * omitted. Either way the mounted registry is reachable on
	 * `AppServer.ws_endpoints[path]` for broadcast / fan-out.
	 */
	registry?: ConnectionRegistry;
	/**
	 * Per-account connection cap for the auto-created registry. See
	 * `RegisterActionWsOptions.max_connections_per_account` — rejected
	 * alongside `registry`, which carries its own cap.
	 *
	 * @default DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT
	 */
	max_connections_per_account?: number | null;
	/**
	 * Byte budget of the frames waiting to be written to one connection, for
	 * the auto-created registry. See
	 * `RegisterActionWsOptions.outbound_queue_bytes` — rejected alongside
	 * `registry`, which carries its own budget.
	 *
	 * @default DEFAULT_WS_OUTBOUND_QUEUE_BYTES
	 */
	outbound_queue_bytes?: number;
	/**
	 * Receive silence (ms) past which the server closes a socket with
	 * `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT`; `null` keeps silent sockets open.
	 * See `RegisterActionWsOptions.receive_timeout`.
	 *
	 * @default DEFAULT_WS_RECEIVE_TIMEOUT
	 */
	receive_timeout?: number | null;
	/**
	 * Cap on one inbound message, in bytes. See
	 * `RegisterActionWsOptions.max_message_bytes`.
	 *
	 * @default DEFAULT_WS_MAX_MESSAGE_BYTES
	 */
	max_message_bytes?: number;
	/**
	 * Called once per socket after the connection is admitted — registered
	 * and its credential re-checked — and before the first message
	 * dispatches. See `RegisterActionWsOptions.on_socket_open`.
	 */
	on_socket_open?: (ctx: SocketOpenContext) => void | Promise<void>;
	/**
	 * Called once per admitted socket on close, after
	 * `registry.remove_connection`. See
	 * `RegisterActionWsOptions.on_socket_close`.
	 */
	on_socket_close?: (ctx: SocketCloseContext) => void | Promise<void>;
}

/**
 * A `WsEndpointSpec` with `allowed_origins` and `actions` resolved — its own,
 * or the server's.
 */
export type ResolvedWsEndpointSpec = WsEndpointSpec & {
	allowed_origins: ReadonlyArray<RegExp>;
	actions: ReadonlyArray<Action>;
};

/** What `resolve_ws_endpoints` fills a spec's omitted fields from. */
export interface ResolveWsEndpointsOptions {
	/** The server's allowlist, the default `allowed_origins`. */
	allowed_origins: ReadonlyArray<RegExp>;
	/**
	 * The server's resolved RPC endpoints — a spec that omits `actions` serves
	 * the sole entry's, through `to_ws_actions`.
	 */
	rpc_endpoints: ReadonlyArray<RpcEndpointSpec> | undefined;
}

/**
 * Fill in each WS endpoint spec's omitted `allowed_origins` (the server's) and
 * `actions` (the sole RPC endpoint's, through `to_ws_actions`), so every
 * consumer of the resolved list — the mount, the surface — reads the effective
 * values.
 *
 * @param ws_endpoints - the resolved `ws_endpoints` option
 * @param options - the server's allowlist and RPC endpoints, the defaults
 * @returns the specs, each with `allowed_origins` and `actions` set
 * @throws Error when a spec omits `actions` and `rpc_endpoints` does not hold
 *   exactly one endpoint — there is no single action set to serve
 */
export const resolve_ws_endpoints = (
	ws_endpoints: ReadonlyArray<WsEndpointSpec> | undefined,
	options: ResolveWsEndpointsOptions
): Array<ResolvedWsEndpointSpec> | undefined =>
	ws_endpoints?.map((endpoint) => {
		let { actions } = endpoint;
		if (actions === undefined) {
			const rpc_endpoints = options.rpc_endpoints ?? [];
			if (rpc_endpoints.length !== 1) {
				throw new Error(
					`ws_endpoints ${endpoint.path} omits actions, which serves the sole rpc_endpoints entry's, ` +
						`but ${rpc_endpoints.length} rpc endpoints resolved — pass the endpoint's actions explicitly`
				);
			}
			actions = to_ws_actions(rpc_endpoints[0]!.actions);
		}
		return {
			...endpoint,
			allowed_origins: endpoint.allowed_origins ?? options.allowed_origins,
			actions
		};
	});
