/**
 * Server assembly factory.
 *
 * Consumers provide a pre-initialized `AppBackend` and options (session,
 * origins, routes); `create_app_server()` handles middleware, bootstrap
 * status, surface generation, and Hono app assembly.
 *
 * @module
 */

import { Hono, type Context } from 'hono';
import { logger } from 'hono/logger';
import type { UpgradeWebSocket } from 'hono/ws';
import type { AnySchema } from '@fuzdev/fuz_schema/schema.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { is_cookie_name } from '../auth/session_cookie.ts';
import type { BootstrapTokenStore } from '../auth/bootstrap_token_store.ts';
import { create_sse_stream, type EventSpec } from '../realtime/sse.ts';
import {
	create_audit_log_sse,
	create_sse_connection_closer,
	audit_log_event_specs,
	type AuditLogSse
} from '../realtime/audit_log_sse.ts';
import { BaseServerEnv } from './env.ts';
import {
	RateLimiter,
	announce_rate_limiters_disabled,
	default_login_ip_rate_limit,
	default_login_account_rate_limit,
	default_action_account_rate_limit,
	default_action_ip_rate_limit,
	type RateLimiterMode,
	type RateLimiterOptions
} from '../rate_limiter.ts';
import type { DaemonTokenState } from '../auth/daemon_token.ts';
import { resolve_keeper_account_id } from '../auth/daemon_token_middleware.ts';
import type { MigrationResult } from '../db/migrate.ts';
import type { AppBackend } from './app_backend.ts';
import type { AppServerContext } from './app_server_context.ts';
// Side-effect import: augments Hono's ContextVariableMap so consumers
// that import app_server get type-safe c.get('auth_session_id') etc.
import '../hono_context.ts';
import { create_proxy_middleware_spec } from '../http/proxy.ts';
import { create_static_middleware, type ServeStaticFactory } from './static.ts';
import { create_unmatched_route_handler } from './unmatched_route.ts';
import { get_request_path } from '../http/request_target.ts';
import { log_startup_summary } from './startup.ts';
import { create_app_error_handler } from './app_error_handler.ts';
import {
	create_app_surface_spec,
	type AppSurfaceSpec,
	type AppSurfaceDiagnostic,
	type RpcEndpointSpec
} from '../http/surface.ts';
import { create_dev_route_error_check } from '../http/dev_route_error_check.ts';
import { create_dev_set_cookie_check } from '../http/dev_set_cookie_check.ts';
import {
	apply_middleware_specs,
	apply_route_specs,
	prefix_route_specs,
	type RouteSpec
} from '../http/route_spec.ts';
import type { MiddlewareCarveOut, MiddlewareSpec } from '../http/middleware_spec.ts';
import {
	is_bootstrap_available,
	create_bootstrap_route_specs,
	type BootstrapStatus
} from '../auth/bootstrap_routes.ts';
import { create_surface_route_spec, type SurfaceRouteOptions } from './surface_route.ts';
import { ERROR_SERVICE_UNAVAILABLE } from '../http/error_schemas.ts';
import {
	create_request_tracker_view,
	flush_request_effects,
	type EffectErrorContext,
	type RequestTracker
} from '../http/pending_effects.ts';
import {
	assert_credential_routes_in_auth_scope,
	assert_endpoint_in_auth_scope,
	assert_middleware_stack_mounted,
	create_auth_middleware_specs
} from '../auth/middleware.ts';
import { fuz_auth_guard_resolver } from '../auth/auth_guard_resolver.ts';
import { create_fuz_authorization_handler } from '../auth/request_context.ts';
import { create_body_limit_middleware_spec } from '../http/body_limit.ts';
import { admit_origin_wildcards, ALLOWED_ORIGINS_VAR } from '../http/origin_wildcard.ts';
import { create_host_gate_middleware_spec } from '../http/host.ts';
import { create_rpc_endpoint } from '../actions/action_rpc.ts';
import { register_action_ws } from '../actions/register_action_ws.ts';
import {
	resolve_ws_endpoints,
	type ResolvedWsEndpointSpec,
	type WsEndpointSpec
} from '../actions/ws_endpoint_spec.ts';
import { create_revocation_guard } from '../actions/connection_closer.ts';
import type { ConnectionRegistry } from '../actions/connection_registry.ts';
import { start_auth_cleanup, type AuthCleanupScheduleOptions } from '../auth/cleanup.ts';
import type { AuditEmitter } from '../auth/audit_emitter.ts';

/**
 * Bootstrap configuration for `AppServerOptions.bootstrap`.
 *
 * Discriminated union over three deployment intents. Distinct from
 * `BootstrapRouteOptions` in `auth/bootstrap_routes.ts` — that one is
 * per-factory runtime state (mutable `bootstrap_status` ref, rate
 * limiter); this one is the consumer-facing server option that
 * `create_app_server` reads at startup to decide whether to mount the
 * routes and where.
 *
 * Three modes:
 * - `disabled` — no route mounted, nothing in `/api/surface`.
 *   Equivalent to omitting `bootstrap` entirely; the explicit mode is
 *   for documentation and reviewable intent at the wiring layer.
 * - `surface_only` — route present, permanent 403 via
 *   `is_bootstrap_available`. For tests asserting on the
 *   disabled-but-present wire shape.
 * - `live` — route mounted, real token verification. Success path
 *   reachable. `token_store` is required.
 */
export type BootstrapServerOptions =
	BootstrapDisabledOptions | BootstrapSurfaceOnlyOptions | BootstrapLiveOptions;

export interface BootstrapDisabledOptions {
	mode: 'disabled';
}

export interface BootstrapSurfaceOnlyOptions {
	mode: 'surface_only';
	/** Route prefix for surface generation. Default `'/api/account'`; must sit under `/api/`. */
	route_prefix?: string;
}

export interface BootstrapLiveOptions {
	mode: 'live';
	/**
	 * The one-shot token — production passes
	 * `create_file_bootstrap_token_store(runtime, path)` over
	 * `FUZ_BOOTSTRAP_TOKEN_PATH`.
	 */
	token_store: BootstrapTokenStore;
	/** Route prefix for bootstrap routes. Default `'/api/account'`; must sit under `/api/`. */
	route_prefix?: string;
}

/**
 * Configuration for `create_app_server()`.
 *
 * Requires a pre-initialized `AppBackend` from `create_app_backend()`.
 * Two explicit steps: init backend then assemble server.
 */
export interface AppServerOptions {
	/** Pre-initialized backend from `create_app_backend()`. */
	backend: AppBackend;
	/**
	 * The session cookie's name (`SESSION_COOKIE_NAME` is the spine default).
	 * Assembly throws on a name that is no RFC 6265 cookie-name, which the
	 * `Set-Cookie` grammar cannot carry.
	 */
	session_cookie_name: string;
	/**
	 * Parsed allowed origin patterns, as `parse_allowed_origins` returns them
	 * (`validate_server_env`'s `allowed_origins`); assembly throws on a matcher
	 * built any other way, since its wildcards can't be checked. Must not be
	 * empty — an empty list would refuse every browser request, so assembly
	 * throws.
	 */
	allowed_origins: Array<RegExp>;
	/**
	 * Admit a wildcard `allowed_origins` entry (`:*`, a `*` label) — the
	 * operator's `FUZ_ALLOW_ORIGIN_WILDCARDS=true`, as `validate_server_env`
	 * reads it. Without it assembly throws on one, naming each entry and what it
	 * admits; with it each is logged at `warn`, on every assembly. Covers each
	 * `ws_endpoints` spec's own `allowed_origins` too. Classifies the matchers
	 * `parse_allowed_origins` built (`http/origin_wildcard.ts`); assembly throws
	 * on any other matcher, flag or not. Defaults to `false`.
	 */
	allow_origin_wildcards?: boolean;
	/**
	 * Mount the `Host` check (`http/host.ts`), the DNS-rebinding gate, on every
	 * path ahead of the origin check: a request whose `Host` is neither a
	 * loopback name nor a host `allowed_origins` names is refused `403`
	 * `forbidden_host`, and logged at `warn` (rate-limited). Defaults to `true`;
	 * `false` is for a server reached by names its allowlist doesn't hold, which
	 * then accepts the rebinding exposure. Twin of the Rust spine's
	 * `StackOptions::host_gate`.
	 */
	host_gate?: boolean;
	/**
	 * Paths the origin check skips, each with its reason. The check covers
	 * every path by default (`ORIGIN_MIDDLEWARE_PATH`) — a request with no
	 * `Origin` passes it anyway, so probes and CLI clients need no carve-out;
	 * one is for a path that refuses browser callers by other means. Copied at
	 * assembly, so a later change to this array changes nothing; assembly
	 * throws on a carve-out with no reason, or one that overlaps the auth
	 * middleware's scope (`AUTH_MIDDLEWARE_PATH`) — every route that reads or
	 * mints a credential, and every RPC, WS, and bootstrap endpoint, sits
	 * there (`assert_origin_carve_outs_valid`).
	 */
	origin_carve_outs?: Array<MiddlewareCarveOut>;

	/** Trusted proxy options. */
	proxy: {
		trusted_proxies: Array<string>;
		get_connection_ip: (c: Context) => string | undefined;
	};

	/**
	 * What an omitted rate limiter becomes — `'enforced'` (the default) builds
	 * a default instance for each `*_rate_limiter` option left out,
	 * `'disabled_for_testing'` leaves each of them `null`. An explicit option
	 * (an instance or `null`) always wins over the mode. The disabled mode adds
	 * one surface warning, and prints a stderr banner once per module instance
	 * (`announce_rate_limiters_disabled`). Never `'disabled_for_testing'` in production — see
	 * `RateLimiterMode`.
	 */
	rate_limiters?: RateLimiterMode;
	/**
	 * Per-IP rate limiter for login + password change — the distributed-spray
	 * backstop. Omit or `undefined` to use a default limiter (5 attempts per
	 * 15 minutes) under `rate_limiters: 'enforced'`, none under
	 * `'disabled_for_testing'`. Pass `null` to explicitly disable rate limiting.
	 * Also available on `AppServerContext` for route factory callbacks.
	 *
	 * One instance per auth surface, not one shared across all four. These
	 * buckets are monotone within their window — a success never refunds them
	 * (see `RateLimiter.reset`) — so a shared instance let a failure on any
	 * surface spend the budget that bounds guessing on every other one, and
	 * let one caller's exhaustion deny four routes at once. Pass the same
	 * limiter to two of these fields to opt back into a shared budget.
	 */
	login_ip_rate_limiter?: RateLimiter | null;
	/**
	 * Per-IP rate limiter for signup. Omit or `undefined` for the mode's
	 * default (5 attempts per 15 minutes under `rate_limiters: 'enforced'`).
	 * Pass `null` to explicitly disable.
	 * Separate from `login_ip_rate_limiter` because an open-signup deployment
	 * lets any unauthenticated caller spend it. Also available on
	 * `AppServerContext` for route factory callbacks.
	 */
	signup_ip_rate_limiter?: RateLimiter | null;
	/**
	 * Per-IP rate limiter for bootstrap. Omit or `undefined` for the mode's
	 * default (5 attempts per 15 minutes under `rate_limiters: 'enforced'`).
	 * Pass `null` to explicitly disable.
	 * Separate from `login_ip_rate_limiter` so a fumbled bootstrap token can't
	 * spend the operator's login budget. Wired directly into the factory-managed
	 * bootstrap route; also on `AppServerContext` for symmetry.
	 */
	bootstrap_ip_rate_limiter?: RateLimiter | null;
	/**
	 * Per-account rate limiter for login attempts. Omit or `undefined` for the
	 * mode's default (10 attempts per 30 minutes under
	 * `rate_limiters: 'enforced'`). Pass `null` to explicitly disable.
	 * Also available on `AppServerContext` for route factory callbacks.
	 */
	login_account_rate_limiter?: RateLimiter | null;
	/**
	 * Per-account rate limiter for signup attempts, keyed by submitted username.
	 * Omit or `undefined` for the mode's default (10 attempts per 30 minutes
	 * under `rate_limiters: 'enforced'`). Pass `null` to explicitly disable.
	 * Also available on `AppServerContext` for route factory callbacks.
	 */
	signup_account_rate_limiter?: RateLimiter | null;
	/**
	 * Per-IP rate limiter for the action dispatchers (HTTP RPC + WebSocket).
	 * Consulted for actions whose spec declares `rate_limit: 'ip'` or `'both'`.
	 * Same limiter applies across transports — one budget per action.
	 * Omit or `undefined` for the mode's default (600 attempts per 15 minutes
	 * — permissive — under `rate_limiters: 'enforced'`). Pass `null` to
	 * explicitly disable.
	 * Threaded into every endpoint mounted from `rpc_endpoints` and
	 * `ws_endpoints`; also available on `AppServerContext`.
	 */
	action_ip_rate_limiter?: RateLimiter | null;
	/**
	 * Per-account rate limiter for the action dispatchers (HTTP RPC +
	 * WebSocket). Consulted for actions whose spec declares
	 * `rate_limit: 'account'` or `'both'`. Keyed on the authenticated account's
	 * id, so every actor and credential of one account shares a budget.
	 * Omit or `undefined` for the mode's default (1200 attempts per 15 minutes
	 * — permissive — under `rate_limiters: 'enforced'`). Pass `null` to
	 * explicitly disable.
	 * Threaded into every endpoint mounted from `rpc_endpoints` and
	 * `ws_endpoints`; also available on `AppServerContext`.
	 */
	action_account_rate_limiter?: RateLimiter | null;
	/**
	 * Maximum allowed request body size in bytes, a safe integer `0` or more
	 * (anything else throws at assembly). Omit or `undefined` to use the
	 * default (1 MiB). Pass `null` to explicitly disable body size limiting,
	 * which adds a security warning to the surface's diagnostics (logged at
	 * startup). The limit is mounted as a middleware spec at `'*'` ahead of
	 * the others (`create_body_limit_middleware_spec`), so every route's
	 * error map declares its `413` and `400`; with `null` it is absent.
	 */
	max_body_size?: number | null;
	/**
	 * Daemon token state for keeper auth. Omit to disable. A null
	 * `keeper_account_id` is resolved from the database at assembly (an
	 * already-bootstrapped server), and a live bootstrap sets it once its
	 * account commits; the daemon leg never re-reads it per request, so a
	 * keeper seeded by another process (`seed_dev_account`) needs a restart,
	 * as on the Rust spine.
	 */
	daemon_token_state?: DaemonTokenState;

	/** Bootstrap options. Omit to skip bootstrap status check and routes. */
	bootstrap?: BootstrapServerOptions;

	/**
	 * Mount `GET /api/surface`, which serves this server's generated
	 * `AppSurface` (every route, its auth, and its schemas) to an admin UI such
	 * as `AdminSurface.svelte`. Off by default — the Rust spine serves no such
	 * route, and a map of the API is nothing to publish unasked.
	 *
	 * When mounted the route is admin-only (`roles: ['admin']`, so it takes the
	 * `?acting=` selector) and a rule-3 token surface
	 * (`required_scope: 'surface:app_surface'`): a narrowed API token is refused
	 * it whatever its method list says. See `server/surface_route.ts`.
	 *
	 * @default false
	 */
	surface_route?: boolean;

	/**
	 * Build route specs from the initialized backend.
	 * Called after all middleware is ready.
	 */
	create_route_specs: (context: AppServerContext) => Array<RouteSpec>;

	/**
	 * Optional: transform middleware specs before applying.
	 *
	 * Receives shallow copies of the trusted-proxy spec followed by the auth
	 * stack, in a fresh array — mutating them leaves the originals untouched.
	 * Add layers anywhere (before the proxy spec, between it and the auth
	 * stack, between the auth layers, or after), but keep each of those specs
	 * — its `handler`, not just its `name` — mounted once at its original path
	 * (`'*'` for the proxy and the origin check, `AUTH_MIDDLEWARE_PATH` for the
	 * rest of the auth stack) in its original
	 * order: the endpoint auth-scope check (`assert_endpoint_in_auth_scope`)
	 * and client-IP rate limiting (`get_client_ip`) assume it, so assembly
	 * throws (`assert_middleware_stack_mounted`) if the transform moves, drops,
	 * duplicates, reorders, wraps, or replaces one. The check pins where those
	 * layers sit, not what added layers do — a layer you add runs with full
	 * context access.
	 */
	transform_middleware?: (specs: Array<MiddlewareSpec>) => Array<MiddlewareSpec>;

	/**
	 * Enable factory-managed audit log SSE.
	 *
	 * When truthy, creates an `AuditLogSse` instance internally, registers the SSE
	 * listener via `backend.deps.audit.add_listener` (composing with the
	 * consumer's `on_audit_event` callback rather than rebuilding `AppDeps`),
	 * adds its registry to `backend.deps.connection_closer` so revocations close
	 * its streams, and auto-includes `audit_log_event_specs` in the surface. The
	 * result is exposed on `AppServerContext` (for route factories) and
	 * `AppServer` (for the caller), always typed as `AuditLogSse | null` — when
	 * this option is set, the field is non-null. Use `require_audit_sse(ctx)` to
	 * assert the invariant in route factories that depend on it.
	 *
	 * Pass `true` for defaults (admin role), or `{role: 'custom'}` for a custom
	 * role; `keep_alive_ms` sets the streams' keep-alive interval (a test server
	 * shortens it; default `SSE_KEEP_ALIVE_INTERVAL_MS`). Omit to wire audit SSE
	 * manually.
	 */
	audit_log_sse?: true | { role?: string; keep_alive_ms?: number | null };

	/**
	 * Schedule the auth cleanup beside the server: `start_auth_cleanup` over
	 * `backend.deps` — a pass as assembly finishes, then one per interval —
	 * stopped by `AppServer.close`. Each pass deletes expired sessions and
	 * closes the connections they opened through `deps.connection_closer`
	 * (every WebSocket connection registry and audit stream this server mounts), and
	 * audits each newly expired role_grant offer once.
	 *
	 * **Off by default; a production server should turn it on.** Without it
	 * nothing sweeps: expired session rows accumulate and an offer's expiry is
	 * never audited. Connections do not depend on it — each closes at its
	 * credential's deadline (`auth/credential_deadline.ts`), and the sweep's
	 * close repeats that one. The Rust spine's servers all schedule the twin
	 * (`spawn_auth_cleanup`).
	 *
	 * Pass `true` for the default interval
	 * (`DEFAULT_AUTH_CLEANUP_INTERVAL_MS`), or `{interval_ms}` for another.
	 * Leave it off in an in-process test harness — a background pass deletes
	 * rows and writes audit rows mid-test — and in a process that runs
	 * `run_auth_cleanup` on a schedule of its own.
	 */
	auth_cleanup?: boolean | AuthCleanupScheduleOptions;

	/** SSE event specs for surface generation. Defaults to `[]` (no SSE events). */
	event_specs?: Array<EventSpec>;

	/**
	 * RPC endpoint specs — single source of truth for both surface generation
	 * *and* live dispatch. Each entry becomes route specs via
	 * `create_rpc_endpoint`, applied with the other routes, so consumers don't call
	 * `create_rpc_endpoint` themselves inside `create_route_specs`.
	 *
	 * Accepts either an array (evaluated eagerly) or a factory
	 * `(ctx: AppServerContext) => Array<RpcEndpointSpec>` (evaluated after the
	 * server context is assembled). Use the factory form when action lists
	 * depend on `ctx.deps` — e.g. `create_standard_rpc_actions(ctx.deps)`.
	 *
	 * Each path must sit inside the auth middleware's scope
	 * (`AUTH_MIDDLEWARE_PATH`, `'/api/*'`) — assembly throws otherwise, since
	 * an endpoint outside it would see every caller as unauthenticated.
	 */
	rpc_endpoints?: Array<RpcEndpointSpec> | ((context: AppServerContext) => Array<RpcEndpointSpec>);

	/**
	 * The Hono runtime adapter's `upgradeWebSocket` helper, which services
	 * every mounted `ws_endpoints` entry. Required when `ws_endpoints`
	 * resolves non-empty — assembly throws without it — and unused otherwise.
	 *
	 * Bun's is `upgradeWebSocket` from `@hono/bun`, whose `websocket` goes
	 * to `Bun.serve`. Node's is `upgradeWebSocket` from `@hono/node-server`,
	 * which upgrades only on a server given a `ws` `WebSocketServer` built
	 * with `noServer: true`; cap its `maxPayload` near the endpoint's
	 * `max_message_bytes`, since `ws` defaults to 100 MiB:
	 *
	 * ```ts
	 * import {serve, upgradeWebSocket} from '@hono/node-server';
	 * import {WebSocketServer} from 'ws';
	 * const server = await create_app_server({..., upgrade_websocket: upgradeWebSocket});
	 * const wss = new WebSocketServer({noServer: true, maxPayload: 2 * max_message_bytes});
	 * serve({fetch: server.app.fetch, port, websocket: {server: wss}});
	 * ```
	 *
	 * Test harnesses pass `stub.upgradeWebSocket` with
	 * `create_stub_upgrade` from `testing/ws_round_trip.ts`.
	 */
	upgrade_websocket?: UpgradeWebSocket;

	/**
	 * WebSocket endpoint specs — single source of truth for both surface
	 * generation *and* live dispatch. Each entry is auto-mounted via
	 * `register_action_ws` against the assembled Hono app on every
	 * runtime, so consumers don't call `register_action_ws` themselves.
	 *
	 * An entry that omits `actions` serves the actions of the sole
	 * `rpc_endpoints` entry (`to_ws_actions`: the protocol actions first, then
	 * the RPC set), so one action set runs on both transports; assembly throws
	 * unless exactly one RPC endpoint resolves.
	 *
	 * Accepts either an array (evaluated eagerly) or a factory
	 * `(ctx: AppServerContext) => ReadonlyArray<WsEndpointSpec>`
	 * (evaluated after the server context is assembled). Use the factory
	 * form when action lists depend on `ctx.deps` — e.g. when spreading
	 * `create_standard_rpc_actions(ctx.deps)` over WS.
	 *
	 * When non-empty, `upgrade_websocket` must be supplied (throws
	 * otherwise). A factory returning `[]` does NOT trip the check —
	 * feature-flag gated WS surfaces stay safe.
	 *
	 * Every mount gets what the HTTP surface gets: the auth middleware (a
	 * path outside `AUTH_MIDDLEWARE_PATH` throws at assembly, like
	 * `rpc_endpoints`), the server's `allowed_origins` unless the spec
	 * narrows them (a spec's own list gets the same wildcard check,
	 * `allow_origin_wildcards`), and the same `action_ip_rate_limiter` /
	 * `action_account_rate_limiter` instances the RPC endpoints charge — one
	 * budget per action across both transports. The upgrade routes register
	 * after the route specs and before `post_route_middleware` and
	 * `static_serving`, so neither runs ahead of an upgrade.
	 *
	 * Duplicate `path` values across two `WsEndpointSpec`s, and a `path` a
	 * GET `RouteSpec` already claims, throw at assembly before any endpoint
	 * mounts (Hono would silently shadow them otherwise).
	 *
	 * Every mounted connection registry is added to `deps.connection_closer`, so
	 * the revocation handlers' post-commit closes reach its sockets, and so
	 * does the one revocation guard `create_app_server` registers on that
	 * closer (`create_revocation_guard`) when it mounts a WS endpoint or the
	 * audit stream. Each is added to `deps.notification_sender` too, so a
	 * notification any action handler sends — over HTTP RPC or a socket —
	 * reaches the account's sockets on every mounted registry, once per
	 * registry however many endpoints share it. `AppServer.close` removes
	 * both memberships again.
	 */
	ws_endpoints?:
		ReadonlyArray<WsEndpointSpec> | ((context: AppServerContext) => ReadonlyArray<WsEndpointSpec>);

	/**
	 * Env schema for surface generation, a `@fuzdev/fuz_schema` object
	 * schema. Defaults to `BaseServerEnv` — pass an extended schema
	 * (typically `object({...BaseServerEnv.def, ...})`) when the consumer
	 * adds app-specific env vars.
	 */
	env_schema?: AnySchema;

	/** Middleware applied after routes, before static serving. Included in surface. */
	post_route_middleware?: Array<MiddlewareSpec>;

	/** Static file serving. Omit if not serving static files. */
	static_serving?: {
		serve_static: ServeStaticFactory;
		/** Root directory for static files. Default `'./build'`. */
		root?: string;
		/** Optional SPA fallback path served for client-side routes. */
		spa_fallback?: string;
		/**
		 * Predicate deciding which paths receive the SPA fallback.
		 * Default: every path that is not under `/api/`. Only consulted
		 * when `spa_fallback` is set.
		 */
		is_spa_route?: (path: string) => boolean;
	};

	/**
	 * Await all pending fire-and-forget effects before returning the response.
	 * Use in tests so audit log assertions don't need polling.
	 * Default `false` (production: true fire-and-forget).
	 */
	await_pending_effects?: boolean;

	/**
	 * How long `AppServer.close` waits for the work still in flight — each
	 * HTTP request and WS message accepted, until its handler has returned and
	 * its effect queues (failure audit rows, API token usage, post-commit
	 * thunks) have flushed, and every pool write of `deps.audit` — before it
	 * closes the database. What is still running then is given up on and
	 * logged. Default `DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS`; must be a positive
	 * number of ms.
	 */
	shutdown_drain_timeout_ms?: number;

	/**
	 * Called when an eager pending effect rejects, on HTTP requests and on the
	 * frames of every WS endpoint the server mounts, in either
	 * `await_pending_effects` mode. Use for monitoring, metrics, or alerting.
	 */
	on_effect_error?: (error: unknown, context: EffectErrorContext) => void;

	/** Env values for startup summary logging. */
	env_values?: Record<string, unknown>;
}

/** Result of `create_app_server()`. */
export interface AppServer {
	app: Hono;
	/** Surface spec — serializable surface + raw specs that produced it. */
	surface_spec: AppSurfaceSpec;
	bootstrap_status: BootstrapStatus;
	/** Migration results from `create_app_backend` (auth + any `migration_namespaces` passed there). */
	migration_results: ReadonlyArray<MigrationResult>;
	/**
	 * Factory-managed audit log SSE. Non-null when the `audit_log_sse`
	 * option was passed to `create_app_server`, `null` when omitted.
	 * Use `require_audit_sse(server)` to assert the invariant.
	 */
	audit_sse: AuditLogSse | null;
	/**
	 * Path-keyed map of mounted WS endpoints. Each value is the
	 * `ConnectionRegistry` `create_app_server` registered
	 * connections against — supplied via `WsEndpointSpec.registry` or
	 * auto-created when omitted. Retain for broadcast / fan-out:
	 *
	 * ```ts
	 * app_server.ws_endpoints['/api/ws'].send_to_account(account_id, msg);
	 * ```
	 *
	 * Empty when no `ws_endpoints` were mounted.
	 */
	ws_endpoints: Readonly<Record<string, ConnectionRegistry>>;
	/**
	 * Shut the server's resources down, in order:
	 *
	 * 1. stop the auth cleanup schedule when the `auth_cleanup` option started
	 *    one, waiting for a pass in progress — that wait has no bound of its
	 *    own, so a shutdown with a deadline races it
	 * 2. close every live connection on `deps.connection_closer`
	 *    (`close_all_connections`) — each WebSocket with `WS_CLOSE_GOING_AWAY`, each
	 *    audit stream — including registries supplied through
	 *    `WsEndpointSpec.registry` or added by hand, since they are registered
	 *    on the backend's closer and the backend is going away; a close that
	 *    throws is logged and the shutdown goes on. Each connection and SSE registry
	 *    is left closing, so an upgrade or stream that registers afterward is
	 *    born closed — refused at once rather than outliving the server — and
	 *    a closed registry hosts no other server
	 * 3. wait for the work still in flight on `deps.request_tracker` and
	 *    `deps.audit`: every HTTP request and WS message accepted, until its
	 *    handler has returned and its effect queues have flushed (failure
	 *    audit rows, API token usage, post-commit thunks; production holds no
	 *    HTTP response for them, and a WS reply is sent before its flush), and
	 *    every pool write of the emitter — a handler still running when the
	 *    close starts is waited for, then its flush. A WS handler's socket is
	 *    closed in step 2, which aborts its `signal`; one that runs on is still
	 *    waited for. Bounded by `shutdown_drain_timeout_ms`, logging what it
	 *    gives up on. From here a request that arrives is refused — HTTP with
	 *    503 `service_unavailable`, and a WS message, on a socket step 2
	 *    didn't end (a hand mount), with the `service_unavailable` JSON-RPC
	 *    error — never run against the closing database. The Rust
	 *    spine waits the same way for an HTTP request already dispatched, but
	 *    drops a WS message's dispatch still in its handler with its socket
	 *    loop, which rolls back; one whose commit has started finishes, its
	 *    post-commit effects included
	 * 4. release what assembly acquired, last acquired first: remove the
	 *    audit listeners `create_app_server` registered on `deps.audit` (the
	 *    revocation guard, the audit-log SSE listener), the members it added
	 *    to `deps.connection_closer` (each mounted connection registry, the
	 *    audit stream registry) and to `deps.notification_sender` (each
	 *    mounted connection registry), and `dispose` the rate limiters it
	 *    built for omitted options — never one passed in, which its caller
	 *    owns. A release that throws is logged and the rest still run. The
	 *    backend's emitter, closer and notification sender are left as they
	 *    were before assembly, so a failed assembly can be retried on the same
	 *    backend, and a backend whose `close` you own (a test harness) can
	 *    host another server
	 * 5. close the database connection (`AppBackend.close`)
	 *
	 * Idempotent: a second call settles with the first one's outcome (a failed
	 * close is not retried), and concurrent calls share one shutdown. Never
	 * await it from a handler: its own request is held, so the drain waits on
	 * it until `shutdown_drain_timeout_ms`.
	 *
	 * Stop accepting new HTTP connections first — without awaiting the
	 * listener's full drain, since live WebSockets hold it open until `close`
	 * ends them — so no new request reaches a closed database. A request the
	 * app already accepted is waited for in step 3.
	 */
	close: () => Promise<void>;
}

/**
 * Assert that `audit_sse` was wired by `create_app_server` and return it
 * as a non-null `AuditLogSse`. Throws a labelled error when the
 * `audit_log_sse` option was not passed to `create_app_server`.
 *
 * Use in route factories that depend on factory-managed audit SSE:
 *
 * ```ts
 * create_route_specs: (ctx) => create_audit_log_route_specs({
 *   stream: require_audit_sse(ctx),
 * }),
 * ```
 *
 * Preferred over `ctx.audit_sse!` — `!` lies to the type system and
 * produces a downstream cannot-read-property crash if a consumer wires
 * the route without enabling the option.
 */
export const require_audit_sse = (source: { audit_sse: AuditLogSse | null }): AuditLogSse => {
	if (!source.audit_sse) {
		throw new Error(
			'audit_sse is null — pass `audit_log_sse: true` (or `{role}`) in `AppServerOptions`'
		);
	}
	return source.audit_sse;
};

/**
 * Default maximum request body size: 1 MiB. Twin of the Rust spine's
 * `fuz_http` `DEFAULT_BODY_LIMIT_BYTES`.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Default bound on `AppServer.close`'s wait for the effects still in flight
 * (`AppServerOptions.shutdown_drain_timeout_ms`). Twin of the Rust spine's
 * `DEFAULT_DRAIN_TIMEOUT`.
 */
export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Each `AppServerOptions` rate-limiter field, with the defaults an omitted one
 * is built from under `rate_limiters: 'enforced'` and the name its
 * explicitly-null diagnostic uses. Insertion order is the order limiters are
 * built and their diagnostics are listed.
 */
const rate_limiter_slots = {
	login_ip_rate_limiter: { label: 'login IP', defaults: default_login_ip_rate_limit },
	signup_ip_rate_limiter: { label: 'signup IP', defaults: default_login_ip_rate_limit },
	bootstrap_ip_rate_limiter: { label: 'bootstrap IP', defaults: default_login_ip_rate_limit },
	login_account_rate_limiter: {
		label: 'login account',
		defaults: default_login_account_rate_limit
	},
	signup_account_rate_limiter: {
		label: 'signup account',
		defaults: default_login_account_rate_limit
	},
	action_ip_rate_limiter: { label: 'action IP', defaults: default_action_ip_rate_limit },
	action_account_rate_limiter: {
		label: 'action account',
		defaults: default_action_account_rate_limit
	}
} as const satisfies Record<string, { label: string; defaults: RateLimiterOptions }>;

/**
 * Name of an `AppServerOptions` rate-limiter field — also the
 * `AppServerContext` field its resolved limiter lands on.
 *
 * @internal
 */
export type AppServerRateLimiterKey = keyof typeof rate_limiter_slots;

/**
 * Every `AppServerOptions` rate-limiter field, in build order.
 *
 * @internal
 */
export const APP_SERVER_RATE_LIMITER_KEYS = Object.keys(
	rate_limiter_slots
) as ReadonlyArray<AppServerRateLimiterKey>;

/**
 * The rate limiters `create_app_server` resolved from its options.
 *
 * @internal
 */
export interface ResolvedRateLimiters {
	/** The `rate_limiters` mode, defaulted to `'enforced'`. */
	mode: RateLimiterMode;
	/** Each limiter by option name — `null` when off. */
	limiters: Record<AppServerRateLimiterKey, RateLimiter | null>;
	/**
	 * The limiters built here for omitted options, in build order — the
	 * server's to dispose. Never one passed in, which its caller owns.
	 */
	built: Array<RateLimiter>;
}

/**
 * Resolve each rate-limiter option: an explicit option (instance or `null`)
 * wins; an omitted one is a default instance under `'enforced'` and `null`
 * under `'disabled_for_testing'`, which also announces the mode on stderr
 * (`announce_rate_limiters_disabled`). One instance per surface — see
 * `AppServerOptions.login_ip_rate_limiter` for why these are not a single
 * shared bucket.
 *
 * @param options - the rate-limiter fields and `rate_limiters` mode of `AppServerOptions`
 * @internal
 */
export const resolve_rate_limiters = (
	options: Pick<AppServerOptions, AppServerRateLimiterKey | 'rate_limiters'>
): ResolvedRateLimiters => {
	const mode: RateLimiterMode = options.rate_limiters ?? 'enforced';
	const limiters = {} as Record<AppServerRateLimiterKey, RateLimiter | null>;
	const built: Array<RateLimiter> = [];
	for (const key of APP_SERVER_RATE_LIMITER_KEYS) {
		const option = options[key];
		if (option !== undefined) {
			limiters[key] = option;
		} else if (mode === 'disabled_for_testing') {
			announce_rate_limiters_disabled();
			limiters[key] = null;
		} else {
			const limiter = new RateLimiter({ ...rate_limiter_slots[key].defaults });
			built.push(limiter);
			limiters[key] = limiter;
		}
	}
	return { mode, limiters, built };
};

/**
 * Inputs to `collect_config_diagnostics`.
 *
 * @internal
 */
export interface ConfigDiagnosticsInput {
	/** The `rate_limiters` mode, defaulted. */
	rate_limiter_mode: RateLimiterMode;
	/** The resolved limiters, from `resolve_rate_limiters`. */
	rate_limiters: Record<AppServerRateLimiterKey, RateLimiter | null>;
	/** `AppServerOptions.max_body_size` as passed; `null` disables the body size limit. */
	max_body_size: number | null | undefined;
}

/**
 * The config-level diagnostics `create_app_server` appends to the surface's
 * spec-level ones: an open rate-limited
 * surface — one warning for `'disabled_for_testing'`, otherwise one per
 * explicitly-null limiter, so a deployment that disables login's limiter but
 * keeps signup's reads differently from one that disables both — and a
 * disabled request body size limit (`max_body_size: null`).
 *
 * @internal
 */
export const collect_config_diagnostics = (
	input: ConfigDiagnosticsInput
): Array<AppSurfaceDiagnostic> => {
	const diagnostics: Array<AppSurfaceDiagnostic> = [];
	if (input.rate_limiter_mode === 'disabled_for_testing') {
		// one warning for the mode rather than one per limiter it nulled
		diagnostics.push({
			level: 'warning',
			category: 'security',
			message:
				"rate limiters disabled for testing (rate_limiters: 'disabled_for_testing') — " +
				'every limiter not passed explicitly is off; never use in production'
		});
	} else {
		for (const key of APP_SERVER_RATE_LIMITER_KEYS) {
			if (input.rate_limiters[key] === null) {
				diagnostics.push({
					level: 'warning',
					category: 'security',
					message: `${rate_limiter_slots[key].label} rate limiter explicitly disabled (null)`
				});
			}
		}
	}
	if (input.max_body_size === null) {
		diagnostics.push({
			level: 'warning',
			category: 'security',
			message:
				'request body size limit explicitly disabled (max_body_size: null) — ' +
				'every route must cap its own body'
		});
	}
	return diagnostics;
};

/**
 * Create a fully assembled Hono app with auth, middleware, and routes.
 *
 * Handles the assembly lifecycle: rate limiters → audit SSE → proxy
 * middleware → auth middleware → bootstrap status → route specs (consumer,
 * bootstrap, RPC endpoints, surface) → surface generation → Hono app assembly
 * (routes, then WS endpoints) → post-route middleware → static serving → the
 * unmatched-route handler → the auth cleanup schedule. Database migrations
 * belong to the backend lifecycle — pass `migration_namespaces` to
 * `create_app_backend`.
 *
 * The app routes on the raw request path (`get_request_path`), as the Rust
 * spine's router does, and answers a request no route serves from
 * `create_unmatched_route_handler`: a method its path doesn't serve is a 405
 * with `Allow`, a path no route serves a 404, JSON under the auth scope.
 *
 * When `audit_log_sse` is set, the SSE registry's listener is registered via
 * `backend.deps.audit.add_listener` — no shallow-copy of `AppDeps`. That
 * registry and every WebSocket connection registry mounted from `ws_endpoints` are added
 * to `backend.deps.connection_closer`, so the revocation handlers built from
 * `ctx.deps` close their connections with no further wiring, and — when the
 * server mounts either — one `create_revocation_guard` listener on that closer
 * repeats each close on the audit row. Each WebSocket connection registry is
 * added to `backend.deps.notification_sender` as well, the sender every
 * mounted RPC and WebSocket dispatcher puts on its handler contexts, so an
 * action's notification reaches the account's sockets with no wiring either.
 * The
 * `audit_sse` field on the returned `AppServer` (and the
 * `AppServerContext` passed to `create_route_specs`) is non-null in that
 * case; consumers can call `require_audit_sse(ctx)` / `require_audit_sse(server)`
 * to assert the invariant.
 *
 * Assembly acquires a few things that outlive it — the rate limiters it
 * builds, the listeners it registers on `deps.audit`, the members it adds to
 * `deps.connection_closer` and `deps.notification_sender` — and records a
 * release for each as it goes. When assembly throws, every release recorded
 * so far runs, last acquired first (one that throws is logged and the rest
 * still run), and the original error is rethrown: a failed assembly leaves
 * the backend's emitter, closer and notification sender as it found them and
 * no limiter timer running. When `auth_cleanup` is set, the
 * auth cleanup schedule starts as the last step of assembly — nothing after
 * it can throw, so an assembly that throws leaves no schedule running.
 *
 * The returned `close` owns shutdown: it stops that schedule, closes every
 * live connection on the backend's closer, runs the same releases, and
 * closes the database (`AppServer.close`).
 *
 * @returns the assembled Hono app with its surface, bootstrap status, migration results,
 *   audit SSE, mounted WS registries, and `close`
 * @throws Error from any assembly step, after releasing what assembly acquired
 */
export const create_app_server = async (options: AppServerOptions): Promise<AppServer> => {
	const releases: Array<() => void> = [];
	try {
		return await assemble_app_server(options, releases);
	} catch (error) {
		run_releases(releases, options.backend.deps.log, 'a failed assembly');
		throw error;
	}
};

/**
 * What `drain_effects_on_shutdown` gave up on at its bound, each counted on
 * its own: a request still waiting on its audit writes has those writes
 * counted in `audit_writes` too, so the two are not summed.
 */
export interface ShutdownDrainGivenUp {
	/**
	 * Requests still held — HTTP requests and WS messages alike, each with its
	 * handler or its effect flush still running.
	 */
	requests: number;
	/** Pool writes of the audit emitter still in flight. */
	audit_writes: number;
}

/**
 * Wait for the requests held (HTTP requests and WS messages, one tracker —
 * each until its handler has returned and its flush settled) and then the
 * audit emitter's pool writes, until none is left or `timeout_ms` passes —
 * then log an error naming what was given up on. Never rejects.
 *
 * @returns what was given up on, both counts `0` when everything settled
 */
export const drain_effects_on_shutdown = async (
	requests: Pick<RequestTracker, 'drain_inflight' | 'inflight_count'>,
	audit: Pick<AuditEmitter, 'drain_inflight' | 'inflight_count'>,
	timeout_ms: number,
	log: Logger
): Promise<ShutdownDrainGivenUp> => {
	const drain = async (): Promise<void> => {
		// until both are empty: a flush's post-commit thunk can start an audit
		// write, and a request accepted meanwhile is held too
		do {
			await requests.drain_inflight();
			await audit.drain_inflight();
		} while (requests.inflight_count() > 0 || audit.inflight_count() > 0);
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timed_out = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeout_ms);
	});
	try {
		await Promise.race([drain(), timed_out]);
	} finally {
		clearTimeout(timer);
	}
	const given_up: ShutdownDrainGivenUp = {
		requests: requests.inflight_count(),
		audit_writes: audit.inflight_count()
	};
	if (given_up.requests === 0 && given_up.audit_writes === 0) return given_up;
	log.error(
		`create_app_server: shutdown gave up after ${timeout_ms}ms on work still running — ${given_up.requests} request(s) (handler or effect flush), ${given_up.audit_writes} audit row write(s)`
	);
	return given_up;
};

/**
 * Run `releases` last-first and empty it. Each runs in its own `try`, so one
 * that throws is logged and the rest still run.
 */
const run_releases = (releases: Array<() => void>, log: Logger, during: string): void => {
	for (const release of releases.splice(0).reverse()) {
		try {
			release();
		} catch (error) {
			log.error(`create_app_server: a release during ${during} failed:`, error);
		}
	}
};

/**
 * The body of `create_app_server`. Every acquisition that outlives assembly
 * pushes its release onto `releases` as it happens, so a throw at any later
 * step unwinds exactly what was acquired.
 */
const assemble_app_server = async (
	options: AppServerOptions,
	releases: Array<() => void>
): Promise<AppServer> => {
	const { backend } = options;
	const { deps } = backend;
	const { log } = deps;

	// option checks first, before anything is acquired
	if (!is_cookie_name(options.session_cookie_name)) {
		// a name the `Cookie` grammar cannot carry would be written as a header
		// that reads back differently — refused here rather than at the first
		// mint, which for bootstrap comes after its one-shot token is spent
		throw new Error(
			`create_app_server: session cookie name ${JSON.stringify(
				options.session_cookie_name
			)} is not an RFC 6265 cookie-name`
		);
	}
	if (options.allowed_origins.length === 0) {
		throw new Error(
			'create_app_server: allowed_origins is empty — list at least one origin pattern ' +
				'(an empty list refuses every browser request)'
		);
	}
	const host_gate = options.host_gate ?? true;
	const wildcards = admit_origin_wildcards(
		options.allowed_origins,
		options.allow_origin_wildcards ?? false,
		ALLOWED_ORIGINS_VAR,
		{ host_gate }
	);
	if (!wildcards.ok) throw new Error(`create_app_server: ${wildcards.message}`);
	for (const { entry, warning } of wildcards.wildcards) {
		log.warn(`${ALLOWED_ORIGINS_VAR}: ${warning} (origin ${entry})`);
	}
	// body size limit — rejects oversized payloads before auth/validation; the
	// middleware throws on a cap that is not a safe integer 0 or more. A spec,
	// so the surface and each route's error map declare its 413 and 400.
	const body_limit_spec: MiddlewareSpec | null =
		options.max_body_size === null
			? null
			: create_body_limit_middleware_spec(options.max_body_size ?? DEFAULT_BODY_LIMIT_BYTES);

	const shutdown_drain_timeout_ms =
		options.shutdown_drain_timeout_ms ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
	if (!(shutdown_drain_timeout_ms > 0 && Number.isFinite(shutdown_drain_timeout_ms))) {
		throw new Error(
			`create_app_server: shutdown_drain_timeout_ms must be a positive number of ms, got ${shutdown_drain_timeout_ms}`
		);
	}

	// Rate limiters — the ones built here are the server's to dispose, on
	// close or when assembly fails.
	const {
		mode: rate_limiter_mode,
		limiters: rate_limiters,
		built: built_rate_limiters
	} = resolve_rate_limiters(options);
	for (const limiter of built_rate_limiters) {
		releases.push(() => limiter.dispose());
	}
	const { bootstrap_ip_rate_limiter, action_ip_rate_limiter, action_account_rate_limiter } =
		rate_limiters;

	// Factory-managed audit SSE — registers a listener on the bound emitter
	// so SSE fan-out runs alongside the consumer's `on_audit_event`
	// without rebuilding `AppDeps`, and adds the registry to the backend's
	// closer so revocations close its streams. The closer membership is added
	// here rather than through `create_audit_log_sse`'s option, so its remover
	// is the server's.
	const audit_sse: AuditLogSse | null = options.audit_log_sse
		? create_audit_log_sse({
				log,
				...(typeof options.audit_log_sse === 'object'
					? { role: options.audit_log_sse.role, keep_alive_ms: options.audit_log_sse.keep_alive_ms }
					: null),
				connection_closer: null
			})
		: null;
	if (audit_sse) {
		releases.push(
			deps.connection_closer.add(
				create_sse_connection_closer(audit_sse.registry, audit_sse.required_role)
			)
		);
		releases.push(deps.audit.add_listener(audit_sse.on_audit_event));
	}

	// Host gate — ahead of everything but the body cap, as on the Rust stack
	const host_spec: MiddlewareSpec | null = host_gate
		? create_host_gate_middleware_spec({ allowed_origins: options.allowed_origins, log })
		: null;

	// Proxy middleware
	const proxy_spec = create_proxy_middleware_spec({ ...options.proxy, log });

	// Auth middleware
	const auth_middleware = await create_auth_middleware_specs(deps, {
		allowed_origins: options.allowed_origins,
		session_cookie_name: options.session_cookie_name,
		daemon_token_state: options.daemon_token_state,
		origin_carve_outs: options.origin_carve_outs
	});
	const stack_specs: Array<MiddlewareSpec> = [
		...(host_spec ? [host_spec] : []),
		proxy_spec,
		...auth_middleware
	];
	let middleware_specs = stack_specs;
	if (options.transform_middleware) {
		// the transform gets copies in a fresh array, so mutating what it was
		// handed can't rewrite the originals the check matches against
		middleware_specs = options.transform_middleware(stack_specs.map((spec) => ({ ...spec })));
		assert_middleware_stack_mounted(stack_specs, middleware_specs);
	}

	// The daemon-token keeper, after the migrations and before the bootstrap
	// check, as the Rust spine's boot runs `resolve_keeper_into`: a live
	// bootstrap sets it on a fresh database once it commits, and this covers
	// one already bootstrapped. Best-effort, as there: a failed read leaves it
	// unset, and a keeper-less state authenticates no daemon token (the warn
	// below has no twin; the Rust spine's failed read is silent).
	const daemon_token_state = options.daemon_token_state;
	if (daemon_token_state && daemon_token_state.keeper_account_id === null) {
		try {
			const keeper_account_id = await resolve_keeper_account_id(deps);
			if (keeper_account_id !== null) {
				daemon_token_state.keeper_account_id = keeper_account_id;
				log.info('daemon token: keeper account resolved', { account_id: keeper_account_id });
			}
		} catch (error) {
			log.warn('daemon token: resolving the keeper account failed', error);
		}
	}

	// Bootstrap status
	// - undefined / 'disabled': no route mounted; placeholder status.
	// - 'surface_only': route mounted but permanently unavailable; status placeholder.
	// - 'live': real disk + lock check via `is_bootstrap_available`.
	const bootstrap_status: BootstrapStatus =
		options.bootstrap?.mode === 'live'
			? {
					available: await is_bootstrap_available(deps, {
						token_store: options.bootstrap.token_store
					})
				}
			: { available: false };

	// Surface route ref — factory manages the circular ref
	const surface_ref: SurfaceRouteOptions = {
		surface: {
			middleware: [],
			routes: [],
			rpc_endpoints: [],
			ws_endpoints: [],
			env: [],
			events: [],
			diagnostics: []
		}
	};

	// Route specs (consumer routes + factory-managed routes)
	const context: AppServerContext = {
		deps,
		backend,
		bootstrap_status,
		session_cookie_name: options.session_cookie_name,
		...rate_limiters,
		audit_sse
	};
	const consumer_routes = options.create_route_specs(context);

	// Factory-managed routes appended after consumer routes
	const factory_routes: Array<RouteSpec> = [];

	// Bootstrap routes — mounted for 'surface_only' and 'live'; omitted for
	// 'disabled' / undefined. The route handler short-circuits to 403 when
	// `bootstrap_status.available === false`, which is the steady state for
	// 'surface_only' and the post-bootstrap state for 'live'.
	if (options.bootstrap && options.bootstrap.mode !== 'disabled') {
		const bootstrap_routes = create_bootstrap_route_specs(deps, {
			session_cookie_name: options.session_cookie_name,
			bootstrap_status,
			token_store: options.bootstrap.mode === 'live' ? options.bootstrap.token_store : null,
			// a successful bootstrap sets its keeper here, after its commit
			daemon_token_state: options.daemon_token_state ?? null,
			bootstrap_ip_rate_limiter
		});
		const prefix = options.bootstrap.route_prefix ?? '/api/account';
		const prefixed = prefix_route_specs(prefix, bootstrap_routes);
		for (const route of prefixed) {
			assert_endpoint_in_auth_scope('bootstrap.route_prefix', route.path);
		}
		factory_routes.push(...prefixed);
	}

	// RPC endpoint auto-mount — resolve specs then append their routes so
	// surface generation and live dispatch share one source of truth.
	const resolved_rpc_endpoints =
		typeof options.rpc_endpoints === 'function'
			? options.rpc_endpoints(context)
			: options.rpc_endpoints;
	if (resolved_rpc_endpoints) {
		for (const endpoint of resolved_rpc_endpoints) {
			assert_endpoint_in_auth_scope('rpc_endpoints', endpoint.path);
			factory_routes.push(
				...create_rpc_endpoint({
					path: endpoint.path,
					actions: endpoint.actions,
					log,
					action_ip_rate_limiter,
					action_account_rate_limiter,
					notification_sender: deps.notification_sender
				})
			);
		}
	}

	// WS endpoint resolution — done here (alongside RPC) so the captured
	// array threads into surface generation below. Actual mount happens
	// after `apply_route_specs` because `register_action_ws` mutates the
	// live Hono `app` (the `app.get(path, ...)` upgrade route with its
	// origin / auth / scope / authorization / role chain), and `app` does not
	// exist until the assembly phase below.
	// A spec without `allowed_origins` takes the server's list, and one without
	// `actions` the sole RPC endpoint's — resolved here, once, so the mount and
	// the surface read the same values.
	const resolved_ws_endpoints = resolve_ws_endpoints(
		typeof options.ws_endpoints === 'function'
			? options.ws_endpoints(context)
			: options.ws_endpoints,
		{ allowed_origins: options.allowed_origins, rpc_endpoints: resolved_rpc_endpoints }
	);
	// the endpoints to mount and the adapter helper they need — null when none resolve
	let ws_mount: {
		endpoints: Array<ResolvedWsEndpointSpec>;
		upgrade_websocket: UpgradeWebSocket;
	} | null = null;
	if (resolved_ws_endpoints?.length) {
		const upgrade_websocket = options.upgrade_websocket;
		if (upgrade_websocket === undefined) {
			throw new Error(
				'create_app_server: ws_endpoints resolved non-empty but upgrade_websocket is missing. ' +
					"Pass the Hono adapter's upgradeWebSocket helper."
			);
		}
		for (const endpoint of resolved_ws_endpoints) {
			assert_endpoint_in_auth_scope('ws_endpoints', endpoint.path);
		}
		ws_mount = { endpoints: resolved_ws_endpoints, upgrade_websocket };
	}

	// The one revocation listener, registered when a WS endpoint or the audit
	// stream is mounted — on the backend's closer, so it reaches every member:
	// each WS connection registry the mount below adds, the audit stream registry, and any
	// the consumer added by hand. After the audit stream's listener, so a
	// revocation's row reaches the stream before the guard can close it.
	if (audit_sse || ws_mount) {
		releases.push(deps.audit.add_listener(create_revocation_guard(deps.connection_closer, log)));
	}

	// Surface route (opt-in)
	if (options.surface_route) {
		factory_routes.push(create_surface_route_spec(surface_ref));
	}

	const route_specs = [...consumer_routes, ...factory_routes];
	// a route that reads or mints a credential outside the auth scope would
	// skip session parsing or fall under an origin carve-out — consumer
	// prefixes included (account and signup specs are relative)
	assert_credential_routes_in_auth_scope(route_specs);

	// WS path checks — pure data, so they run before anything mounts.
	// `register_action_ws` mounts a `GET path` upgrade route: a duplicate
	// path, or one a `RouteSpec` already registered as `GET path`, would be
	// silently shadowed by Hono's last-wins semantics — fail fast instead. An
	// endpoint's own empty `allowed_origins` would refuse every browser upgrade.
	if (ws_mount) {
		const route_spec_get_paths: Set<string> = new Set();
		for (const r of route_specs) {
			if (r.method === 'GET') route_spec_get_paths.add(r.path);
		}
		const seen_paths: Set<string> = new Set();
		for (const endpoint of ws_mount.endpoints) {
			if (seen_paths.has(endpoint.path)) {
				throw new Error(`create_app_server: duplicate ws_endpoints path: ${endpoint.path}`);
			}
			if (route_spec_get_paths.has(endpoint.path)) {
				throw new Error(
					`create_app_server: ws_endpoints path collides with a GET RouteSpec: ${endpoint.path}`
				);
			}
			if (endpoint.allowed_origins.length === 0) {
				throw new Error(
					`create_app_server: ws_endpoints allowed_origins is empty for ${endpoint.path} — ` +
						'list at least one origin pattern, or omit it to take the server list ' +
						'(an empty list refuses every browser upgrade)'
				);
			}
			// an endpoint's own list gets the server list's wildcard check (one
			// that took the server list was checked above)
			if (endpoint.allowed_origins !== options.allowed_origins) {
				const label = `ws_endpoints allowed_origins for ${endpoint.path}`;
				// the host gate reads the server list, not this one
				const endpoint_wildcards = admit_origin_wildcards(
					endpoint.allowed_origins,
					options.allow_origin_wildcards ?? false,
					label,
					{ host_gate: false }
				);
				if (!endpoint_wildcards.ok) {
					throw new Error(`create_app_server: ${endpoint_wildcards.message}`);
				}
				for (const { entry, warning } of endpoint_wildcards.wildcards) {
					log.warn(`${label}: ${warning} (origin ${entry})`);
				}
			}
			seen_paths.add(endpoint.path);
		}
	}

	// Surface + logging — the body limit first, where it runs, ahead of the
	// middleware specs
	const surface_middleware = [
		...(body_limit_spec ? [body_limit_spec] : []),
		...middleware_specs,
		...(options.post_route_middleware ?? [])
	];
	const all_event_specs = [
		...(options.event_specs ?? []),
		...(audit_sse ? audit_log_event_specs : [])
	];
	const surface_spec = create_app_surface_spec({
		middleware_specs: surface_middleware,
		route_specs,
		env_schema: options.env_schema ?? BaseServerEnv,
		event_specs: all_event_specs,
		rpc_endpoints: resolved_rpc_endpoints,
		ws_endpoints: resolved_ws_endpoints
	});

	// Config-level diagnostics (concatenated after spec-level from generate_app_surface)
	const config_diagnostics = collect_config_diagnostics({
		rate_limiter_mode,
		rate_limiters,
		max_body_size: options.max_body_size
	});
	if (config_diagnostics.length) {
		surface_spec.surface.diagnostics = [...surface_spec.surface.diagnostics, ...config_diagnostics];
	}

	// Backfill the surface ref — factory owns this lifecycle
	surface_ref.surface = surface_spec.surface;
	log_startup_summary(surface_spec.surface, log, options.env_values);

	// Hono app assembly, routing on the raw path: nothing is percent-decoded
	// before the router, so every path-keyed layer reads the spelling it matched
	const app = new Hono({ getPath: get_request_path });
	// A throw that escapes every route catch — a credential leg's failed read
	// above all — answers here: 503 for a failed pool checkout, Hono's default
	// 500 for anything else.
	app.onError(create_app_error_handler(log));

	// DEV only, and outermost, so it sees what every layer answers: logs a JSON
	// error at a status its route's error map doesn't declare, or off its schema
	const dev_route_error_check = create_dev_route_error_check({
		route_specs,
		route_error_maps: surface_spec.route_error_maps,
		log
	});
	if (dev_route_error_check) app.use('*', dev_route_error_check);
	// DEV only, beside it: logs a response that does not lead with the
	// `Set-Cookie` line the session middleware put on the context — one built
	// past the context, by a layer the route system doesn't own
	const dev_set_cookie_check = create_dev_set_cookie_check({ log });
	if (dev_set_cookie_check) app.use('*', dev_set_cookie_check);

	// Two-queue side-effect flush. `pending_effects` collects eager
	// fire-and-forget promises (audit emits, api-token usage). `post_commit_effects` collects deferred thunks pushed via
	// `emit_after_commit` (WS notifications, anything that must observe a
	// committed transaction). Both queues drain here, after the handler
	// (and any wrapping `db.transaction`) returns, through the flush the WS
	// dispatcher shares (`flush_request_effects`). In test mode the flush is
	// awaited before the response returns; in production it runs
	// fire-and-forget. Either way eager rejections reach `on_effect_error`,
	// and the deferred thunks are invoked without waiting for the eager
	// writes to settle — a revocation's connection close must not sit behind
	// a slow audit INSERT.
	const on_effect_error = options.on_effect_error;
	// Every request, HTTP and WS, is held on the backend's tracker from
	// acceptance until its handler has returned and its flush settled — what
	// shutdown waits on before the database closes. The WS endpoints mounted
	// below hold their messages there too. Through this server's own view, so
	// its shutdown refuses what arrives after it starts draining and leaves
	// the backend's tracker open for a later server.
	const request_tracker = create_request_tracker_view(deps.request_tracker);
	app.use('*', async (c, next) => {
		const accepted = request_tracker.accept();
		// the server is shutting down: refused, never run against a closing
		// database — the shape of a failed pool checkout (`app_error_handler.ts`)
		if (!accepted) return c.json({ error: ERROR_SERVICE_UNAVAILABLE }, 503);
		c.set('pending_effects', []);
		c.set('post_commit_effects', []);
		let flushed: Promise<void> | null = null;
		try {
			await next();
		} finally {
			const eager = c.var.pending_effects;
			const deferred = c.var.post_commit_effects;
			if (eager.length || deferred.length) {
				const error_ctx: EffectErrorContext = {
					transport: 'http',
					method: c.req.method,
					path: c.req.path
				};
				flushed = flush_request_effects(
					eager,
					deferred,
					log,
					on_effect_error ? (reason) => on_effect_error(reason, error_ctx) : undefined
				);
			}
			accepted.finish(flushed);
			if (flushed && options.await_pending_effects) await flushed;
		}
		return;
	});

	if (log.level !== 'off') {
		app.use(logger((msg) => log.info(msg)));
	}

	// body size limit, built with the option checks above
	if (body_limit_spec) {
		apply_middleware_specs(app, [body_limit_spec]);
	}

	apply_middleware_specs(app, middleware_specs);
	const authorize = create_fuz_authorization_handler({ db: deps.db });
	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, deps.db, {
		authorize,
		open_sse: create_sse_stream
	});

	// WS endpoint auto-mount — must run after `app` exists and
	// `apply_route_specs` has registered the request routes. Each spec
	// becomes a `register_action_ws` call. `post_route_middleware` and static
	// serving register after this loop, so WS upgrade routes sit
	// adjacent to the consumer routes and ahead of the static fallback —
	// matches the "WS mount is route registration" mental model.
	const mounted_ws_endpoints: Record<string, ConnectionRegistry> = {};
	if (ws_mount) {
		const { upgrade_websocket } = ws_mount;
		for (const endpoint of ws_mount.endpoints) {
			const { registry: endpoint_registry } = register_action_ws({
				app,
				path: endpoint.path,
				upgradeWebSocket: upgrade_websocket,
				allowed_origins: endpoint.allowed_origins,
				db: deps.db,
				actions: endpoint.actions,
				registry: endpoint.registry,
				// added below instead, so the remover is the server's
				connection_closer: null,
				max_connections_per_account: endpoint.max_connections_per_account,
				outbound_queue_bytes: endpoint.outbound_queue_bytes,
				receive_timeout: endpoint.receive_timeout,
				max_message_bytes: endpoint.max_message_bytes,
				on_socket_open: endpoint.on_socket_open,
				on_socket_close: endpoint.on_socket_close,
				log,
				required_roles: endpoint.required_roles,
				action_ip_rate_limiter,
				action_account_rate_limiter,
				notification_sender: deps.notification_sender,
				on_effect_error,
				request_tracker
			});
			mounted_ws_endpoints[endpoint.path] = endpoint_registry;
			// every revocation's close — the handlers' and the guard's — reaches
			// this registry
			releases.push(deps.connection_closer.add(endpoint_registry));
			// and so does every action's notification, from either transport; a
			// registry two endpoints share is one member, so no socket hears a
			// notification twice
			releases.push(deps.notification_sender.add(endpoint_registry));
		}
	}

	// Post-route middleware (before static serving)
	if (options.post_route_middleware) {
		apply_middleware_specs(app, options.post_route_middleware);
	}

	// Static file serving
	if (options.static_serving) {
		const { serve_static, root, spa_fallback, is_spa_route } = options.static_serving;
		for (const mw of create_static_middleware(serve_static, { root, spa_fallback, is_spa_route })) {
			app.use('/*', mw);
		}
	}

	// What no route answers: a 405 where the path serves another method, else
	// the 404 — read from the app's own router, so every route registered on
	// it counts, one added after assembly included
	app.notFound(create_unmatched_route_handler(app.router));

	// Auth cleanup — opt-in, and last: nothing after it can throw, so a failed
	// assembly never leaves a schedule running. Its own throw (an invalid
	// `interval_ms`) comes before any pass starts, and unwinds `releases` like
	// any other. Its closes go through `deps.connection_closer`, which the
	// mounts above have filled.
	const auth_cleanup = options.auth_cleanup
		? start_auth_cleanup(deps, options.auth_cleanup === true ? undefined : options.auth_cleanup)
		: null;

	// One shutdown, shared by every call — see `AppServer.close` for the order.
	let closing: Promise<void> | null = null;
	const shutdown = async (): Promise<void> => {
		// the schedule first, so a pass in progress finishes on a live pool
		if (auth_cleanup) await auth_cleanup.stop();
		// then the connections, so none outlives the server — a failure here
		// must not keep the database open
		try {
			deps.connection_closer.close_all_connections();
		} catch (error) {
			log.error('create_app_server: closing live connections on shutdown failed:', error);
		}
		// then the work still in flight, refusing any request that arrives from
		// here, so a handler still running, and the failure row, token-usage
		// touch or post-commit thunk a request or WS message started, is not cut
		// off by the closing pool — bounded. The Rust spine's drain waits for an
		// HTTP request already dispatched too, but drops a WS message's dispatch
		// still in its handler (`http/CLAUDE.md` §Pending Effects)
		request_tracker.close();
		await drain_effects_on_shutdown(request_tracker, deps.audit, shutdown_drain_timeout_ms, log);
		// then what assembly acquired — the audit listeners and closer members
		// this server added, and the limiters it built
		run_releases(releases, log, 'shutdown');
		await backend.close();
	};

	return {
		app,
		surface_spec,
		bootstrap_status,
		migration_results: backend.migration_results,
		audit_sse,
		ws_endpoints: mounted_ws_endpoints,
		close: () => (closing ??= shutdown())
	};
};
