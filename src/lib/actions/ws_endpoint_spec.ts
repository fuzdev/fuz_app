/**
 * `WsEndpointSpec` — the canonical WebSocket endpoint declaration consumed
 * by `create_app_server`'s `ws_endpoints` option (mirror of `RpcEndpointSpec`
 * for HTTP RPC).
 *
 * Also `resolve_ws_endpoints`, which fills in the server's `allowed_origins`.
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
import type { BackendWebsocketTransport } from './transports_ws_backend.ts';
import type {
	ServerHeartbeatOptions,
	SocketCloseContext,
	SocketOpenContext
} from './register_action_ws.ts';
import type { AuditEventHandler } from './transports_ws_auth_guard.ts';

/**
 * Declarative description of a WebSocket endpoint to be auto-mounted by
 * `create_app_server`.
 *
 * Single source of truth for mount + surface — the same array drives
 * `register_ws_endpoint`-style upgrade wiring AND the `surface.ws_endpoints`
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
	 * its origin passes both lists.
	 */
	allowed_origins?: ReadonlyArray<RegExp>;
	/**
	 * The actions registered on this endpoint. Spread `protocol_actions`
	 * from `actions/protocol.ts` first to complete the
	 * disconnect-detection + per-request cancel pairing with the frontend
	 * client.
	 */
	actions: ReadonlyArray<Action>;
	/**
	 * Roles permitted to upgrade — any-of disjunction. Omit (or pass `[]`)
	 * to skip the upgrade-time role gate; per-action `auth` on each spec
	 * still applies at dispatch time via `perform_action`. Pass
	 * `[ROLE_ADMIN]` for a zap-style admin-only WS endpoint.
	 */
	required_roles?: ReadonlyArray<RoleName>;
	/**
	 * Existing transport to register connections with. Auto-created when
	 * omitted. Either way the mounted transport is reachable on
	 * `AppServer.ws_endpoints[path]` for broadcast / fan-out.
	 */
	transport?: BackendWebsocketTransport;
	/**
	 * Per-account connection cap for the auto-created transport. See
	 * `RegisterActionWsOptions.max_connections_per_account` — rejected
	 * alongside `transport`, which carries its own cap.
	 *
	 * @default DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT
	 */
	max_connections_per_account?: number | null;
	/**
	 * Server-side heartbeat policy. Default-on (60s receive-silence
	 * timeout). Set `false` only when an upstream stack (TCP keepalive,
	 * Cloudflare idle timeout) already owns disconnect detection.
	 */
	heartbeat?: boolean | ServerHeartbeatOptions;
	/** Optional per-message delay for testing loading states. */
	artificial_delay?: number;
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
	 * `transport.remove_connection`. See
	 * `RegisterActionWsOptions.on_socket_close`.
	 */
	on_socket_close?: (ctx: SocketCloseContext) => void | Promise<void>;
	/**
	 * Default `true` — registers `create_ws_auth_guard` against this
	 * endpoint's transport via `deps.audit.add_listener`, so a revocation's
	 * audit row closes its sockets. Wiring is deduped by
	 * transport **reference identity** (`WeakSet<BackendWebsocketTransport>`),
	 * so two `WsEndpointSpec`s sharing the exact same instance get a
	 * single listener.
	 *
	 * The guard repeats what the revocation handlers already do: the
	 * transport is always in `deps.connection_closer`, whatever this flag
	 * says, and the handlers close through it after their commit. Turning the
	 * guard off leaves those closes in place.
	 *
	 * **Shared-transport OR-semantics.** When multiple `WsEndpointSpec`s
	 * share one transport, the guard is wired iff **any** of those specs
	 * has `auth_guard !== false`. To opt out for a shared transport,
	 * every sibling spec must pass `auth_guard: false`. The default is
	 * "fail safe" — easier to enable than disable, and predictable
	 * regardless of spec order.
	 *
	 * Reference-identity dedupe means **wrapped or proxied transports
	 * dedupe as separate entries** — a consumer threading every
	 * transport through a tracing / DI / metrics shim will get a fresh
	 * listener per shimmed reference, even when the underlying
	 * transport is the same. If you wrap or proxy, set `auth_guard:
	 * false` on the duplicate `WsEndpointSpec`s and compose
	 * `create_ws_auth_guard` against the underlying transport once.
	 *
	 * Set `false` when a consumer needs to compose their own callback
	 * from scratch — or to opt out of the auto-wiring entirely.
	 *
	 * NOTE: does NOT close sockets on `role_grant_revoke` — that omission
	 * is deliberate (per-connection role tracking is out of scope). A user
	 * whose admin role is revoked keeps their socket open; the next message
	 * gets `forbidden` from the per-message authorization phase. Consumers
	 * wanting role-revoke disconnection use `extra_audit_handlers`.
	 */
	auth_guard?: boolean;
	/**
	 * Extra audit-event handlers registered via `deps.audit.add_listener`
	 * AFTER the standard `auth_guard` wiring (when enabled). By the time
	 * these run, the standard guard may have already closed sockets. Use
	 * for role-revoke disconnection, custom analytics, etc.
	 *
	 * Never deduped — consumer-owned; pass the same handler twice and it
	 * fires twice.
	 */
	extra_audit_handlers?: ReadonlyArray<AuditEventHandler>;
}

/** A `WsEndpointSpec` whose `allowed_origins` is resolved — its own, or the server's. */
export type ResolvedWsEndpointSpec = WsEndpointSpec & { allowed_origins: ReadonlyArray<RegExp> };

/**
 * Fill in the server's `allowed_origins` on each WS endpoint spec that omits
 * its own, so every consumer of the resolved list — the mount, the surface —
 * reads the effective patterns.
 *
 * @param ws_endpoints - the resolved `ws_endpoints` option
 * @param allowed_origins - the server's allowlist, the default
 * @returns the specs, each with `allowed_origins` set
 */
export const resolve_ws_endpoints = (
	ws_endpoints: ReadonlyArray<WsEndpointSpec> | undefined,
	allowed_origins: ReadonlyArray<RegExp>
): Array<ResolvedWsEndpointSpec> | undefined =>
	ws_endpoints?.map((endpoint) => ({
		...endpoint,
		allowed_origins: endpoint.allowed_origins ?? allowed_origins
	}));
