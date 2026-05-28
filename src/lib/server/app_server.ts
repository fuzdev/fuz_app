/**
 * Server assembly factory.
 *
 * Consumers provide a pre-initialized `AppBackend` and options (session,
 * origins, routes); `create_app_server()` handles middleware, bootstrap
 * status, surface generation, and Hono app assembly.
 *
 * @module
 */

import {Hono, type Context} from 'hono';
import {logger} from 'hono/logger';
import {bodyLimit} from 'hono/body-limit';
import type {UpgradeWebSocket} from 'hono/ws';
import {z} from 'zod';

import {
	session_cookie_options,
	type SessionOptions,
	type SessionCookieOptions,
} from '../auth/session_cookie.js';
import type {BootstrapAccountSuccess} from '../auth/bootstrap_account.js';
import type {EventSpec} from '../realtime/sse.js';
import {
	create_audit_log_sse,
	audit_log_event_specs,
	type AuditLogSse,
} from '../realtime/sse_auth_guard.js';
import {BaseServerEnv} from './env.js';
import {
	create_rate_limiter,
	default_login_account_rate_limit,
	default_action_account_rate_limit,
	default_action_ip_rate_limit,
	type RateLimiter,
} from '../rate_limiter.js';
import type {DaemonTokenState} from '../auth/daemon_token.js';
import type {MigrationResult} from '../db/migrate.js';
import type {AppDeps} from '../auth/deps.js';
import type {AppBackend} from './app_backend.js';
// Side-effect import: augments Hono's ContextVariableMap so consumers
// that import app_server get type-safe c.get('auth_session_id') etc.
import '../hono_context.js';
import {create_proxy_middleware_spec} from '../http/proxy.js';
import {create_static_middleware, type ServeStaticFactory} from './static.js';
import {log_startup_summary} from './startup.js';
import {
	create_app_surface_spec,
	type AppSurfaceSpec,
	type AppSurfaceDiagnostic,
	type RpcEndpointSpec,
} from '../http/surface.js';
import {
	apply_middleware_specs,
	apply_route_specs,
	prefix_route_specs,
	type RouteSpec,
} from '../http/route_spec.js';
import type {MiddlewareSpec} from '../http/middleware_spec.js';
import {
	check_bootstrap_status,
	create_bootstrap_route_specs,
	type BootstrapStatus,
} from '../auth/bootstrap_routes.js';
import {create_surface_route_spec, type SurfaceRouteOptions} from '../http/common_routes.js';
import {flush_pending_effects, flush_post_commit_effects} from '../http/pending_effects.js';
import {create_auth_middleware_specs} from '../auth/middleware.js';
import {fuz_auth_guard_resolver} from '../auth/auth_guard_resolver.js';
import {create_fuz_authorization_handler} from '../auth/request_context.js';
import {ERROR_PAYLOAD_TOO_LARGE} from '../http/error_schemas.js';
import {create_rpc_endpoint} from '../actions/action_rpc.js';
import {register_ws_endpoint} from '../actions/register_ws_endpoint.js';
import type {WsEndpointSpec} from '../actions/ws_endpoint_spec.js';
import {
	create_ws_auth_guard,
	create_ws_logout_closer,
} from '../actions/transports_ws_auth_guard.js';
import {BackendWebsocketTransport} from '../actions/transports_ws_backend.js';

/**
 * Context passed to `on_effect_error` when a pending effect rejects.
 */
export interface EffectErrorContext {
	/** HTTP method of the request that spawned the effect. */
	method: string;
	/** URL path of the request that spawned the effect. */
	path: string;
}

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
 *   `check_bootstrap_status`. For tests asserting on the
 *   disabled-but-present wire shape.
 * - `live` — route mounted, real token verification. Success path
 *   reachable. `token_path` is required (non-nullable).
 */
export type BootstrapServerOptions =
	| BootstrapDisabledOptions
	| BootstrapSurfaceOnlyOptions
	| BootstrapLiveOptions;

export interface BootstrapDisabledOptions {
	mode: 'disabled';
}

export interface BootstrapSurfaceOnlyOptions {
	mode: 'surface_only';
	/** Route prefix for surface generation. Default `'/api/account'`. */
	route_prefix?: string;
}

export interface BootstrapLiveOptions {
	mode: 'live';
	token_path: string;
	/** Route prefix for bootstrap routes. Default `'/api/account'`. */
	route_prefix?: string;
	/**
	 * Called after successful bootstrap (account + session created).
	 * Use for app-specific post-bootstrap work like generating API tokens.
	 */
	on_bootstrap?: (result: BootstrapAccountSuccess, c: Context) => Promise<void>;
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
	/** Session options for cookie-based auth. */
	session_options: SessionOptions<string>;
	/** Parsed allowed origin patterns. */
	allowed_origins: Array<RegExp>;

	/** Trusted proxy options. */
	proxy: {
		trusted_proxies: Array<string>;
		get_connection_ip: (c: Context) => string | undefined;
	};

	/**
	 * Shared IP rate limiter for login, bootstrap, and bearer auth.
	 * Omit or `undefined` to use a default limiter (5 attempts per 15 minutes).
	 * Pass `null` to explicitly disable rate limiting.
	 * Also available on `AppServerContext` for route factory callbacks.
	 */
	ip_rate_limiter?: RateLimiter | null;
	/**
	 * Per-account rate limiter for login attempts.
	 * Omit or `undefined` to use a default limiter (10 attempts per 30 minutes).
	 * Pass `null` to explicitly disable rate limiting.
	 * Also available on `AppServerContext` for route factory callbacks.
	 */
	login_account_rate_limiter?: RateLimiter | null;
	/**
	 * Per-account rate limiter for signup attempts, keyed by submitted username.
	 * Omit or `undefined` to use a default limiter (10 attempts per 30 minutes).
	 * Pass `null` to explicitly disable rate limiting.
	 * Also available on `AppServerContext` for route factory callbacks.
	 */
	signup_account_rate_limiter?: RateLimiter | null;
	/**
	 * Rate limiter for bearer token auth attempts (per-IP).
	 * Omit or `undefined` to use a default limiter (5 attempts per 15 minutes).
	 * Pass `null` to explicitly disable rate limiting.
	 */
	bearer_ip_rate_limiter?: RateLimiter | null;
	/**
	 * Per-IP rate limiter for the action dispatchers (HTTP RPC + WebSocket).
	 * Consulted for actions whose spec declares `rate_limit: 'ip'` or `'both'`.
	 * Same limiter applies across transports — one budget per action.
	 * Omit or `undefined` to use a default limiter (600 attempts per
	 * 15 minutes — permissive). Pass `null` to explicitly disable.
	 * Also available on `AppServerContext` for consumers wiring
	 * `register_action_ws`.
	 */
	action_ip_rate_limiter?: RateLimiter | null;
	/**
	 * Per-actor rate limiter for the action dispatchers (HTTP RPC + WebSocket).
	 * Consulted for actions whose spec declares `rate_limit: 'account'` or
	 * `'both'`. Keyed on `request_context.actor.id` (post-auth).
	 * Omit or `undefined` to use a default limiter (1200 attempts per
	 * 15 minutes — permissive). Pass `null` to explicitly disable.
	 * Also available on `AppServerContext` for consumers wiring
	 * `register_action_ws`.
	 */
	action_account_rate_limiter?: RateLimiter | null;
	/**
	 * Maximum allowed request body size in bytes.
	 * Omit or `undefined` to use the default (1 MiB).
	 * Pass `null` to explicitly disable body size limiting.
	 */
	max_body_size?: number | null;
	/** Daemon token state for keeper auth. Omit to disable. */
	daemon_token_state?: DaemonTokenState;

	/** Bootstrap options. Omit to skip bootstrap status check and routes. */
	bootstrap?: BootstrapServerOptions;

	/**
	 * Set to `false` to disable the auto-created surface route (`GET /api/surface`).
	 * Default: auto-created (authenticated).
	 */
	surface_route?: false;

	/**
	 * Build route specs from the initialized backend.
	 * Called after all middleware is ready.
	 */
	create_route_specs: (context: AppServerContext) => Array<RouteSpec>;

	/** Optional: transform middleware specs before applying. */
	transform_middleware?: (specs: Array<MiddlewareSpec>) => Array<MiddlewareSpec>;

	/**
	 * Enable factory-managed audit log SSE.
	 *
	 * When truthy, creates an `AuditLogSse` instance internally, appends the SSE
	 * listener to `backend.deps.audit.on_event_chain` (composing with the
	 * consumer's `on_audit_event` callback rather than rebuilding `AppDeps`), and
	 * auto-includes `audit_log_event_specs` in the surface. The result is exposed
	 * on `AppServerContext` (for route factories) and `AppServer` (for the caller),
	 * always typed as `AuditLogSse | null` — when this option is set, the field
	 * is non-null. Use `require_audit_sse(ctx)` to assert the invariant in
	 * route factories that depend on it.
	 *
	 * Pass `true` for defaults (admin role), or `{role: 'custom'}` for a custom role.
	 * Omit to wire audit SSE manually.
	 */
	audit_log_sse?: true | {role?: string};

	/** SSE event specs for surface generation. Defaults to `[]` (no SSE events). */
	event_specs?: Array<EventSpec>;

	/**
	 * RPC endpoint specs — single source of truth for both surface generation
	 * *and* live dispatch. Each entry is mounted via `create_rpc_endpoint`
	 * against the assembled Hono app, so consumers no longer call
	 * `create_rpc_endpoint` themselves inside `create_route_specs`.
	 *
	 * Accepts either an array (evaluated eagerly) or a factory
	 * `(ctx: AppServerContext) => Array<RpcEndpointSpec>` (evaluated after the
	 * server context is assembled). Use the factory form when action lists
	 * depend on `ctx.deps` — e.g. `create_standard_rpc_actions(ctx.deps)`.
	 */
	rpc_endpoints?: Array<RpcEndpointSpec> | ((context: AppServerContext) => Array<RpcEndpointSpec>);

	/**
	 * Hono adapter's `upgradeWebSocket` helper. Required whenever
	 * `ws_endpoints` resolves to a non-empty array — `create_app_server`
	 * throws at assembly otherwise. Omit (along with `ws_endpoints`)
	 * when the consumer doesn't mount any WS endpoints. The same
	 * adapter helper services every `WsEndpointSpec` mounted from
	 * `ws_endpoints` — one adapter per app.
	 *
	 * For Node, `import {upgradeWebSocket} from '@hono/node-ws'`. For
	 * Deno, `import {upgradeWebSocket} from 'hono/deno'`. Test harnesses
	 * use `create_stub_upgrade` from `$lib/testing/ws_round_trip.ts`.
	 */
	upgradeWebSocket?: UpgradeWebSocket;

	/**
	 * WebSocket endpoint specs — single source of truth for both surface
	 * generation *and* live dispatch. Each entry is auto-mounted via
	 * `register_ws_endpoint` against the assembled Hono app, so
	 * consumers no longer call `register_ws_endpoint` themselves.
	 *
	 * Accepts either an array (evaluated eagerly) or a factory
	 * `(ctx: AppServerContext) => ReadonlyArray<WsEndpointSpec>`
	 * (evaluated after the server context is assembled). Use the factory
	 * form when action lists depend on `ctx.deps` /
	 * `ctx.action_*_rate_limiter` — e.g. when spreading
	 * `create_standard_rpc_actions(ctx.deps, ...)` over WS.
	 *
	 * When non-empty, `upgradeWebSocket` must be supplied (throws
	 * otherwise). A factory returning `[]` does NOT trip the check —
	 * feature-flag gated WS surfaces stay safe.
	 *
	 * Duplicate `path` values across two `WsEndpointSpec`s throw at
	 * mount time (Hono would silently shadow them otherwise).
	 *
	 * Each spec's `auth_guard?` defaults to `true` — the factory
	 * composes `create_ws_auth_guard` + `create_ws_logout_closer`
	 * against the mounted transport and appends them to
	 * `deps.audit.on_event_chain`. Wiring is deduped by transport
	 * **reference identity** so two specs sharing one
	 * `BackendWebsocketTransport` instance get a single pair of
	 * listeners; wrapped / proxied transports dedupe as separate
	 * entries (set `auth_guard: false` on duplicates and compose
	 * against the underlying transport once).
	 */
	ws_endpoints?:
		| ReadonlyArray<WsEndpointSpec>
		| ((context: AppServerContext) => ReadonlyArray<WsEndpointSpec>);

	/**
	 * Env schema for surface generation. Defaults to `BaseServerEnv` —
	 * pass an extended schema (typically `BaseServerEnv.extend({...})`)
	 * when the consumer adds app-specific env vars.
	 */
	env_schema?: z.ZodObject;

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
	 * Called when a pending effect rejects.
	 * Use for monitoring, metrics, or alerting in production.
	 * Only called when `await_pending_effects` is `false` (production mode).
	 */
	on_effect_error?: (error: unknown, context: EffectErrorContext) => void;

	/** Env values for startup summary logging. */
	env_values?: Record<string, unknown>;
}

/** Context passed to `create_route_specs`. */
export interface AppServerContext {
	deps: AppDeps;
	backend: AppBackend;
	bootstrap_status: BootstrapStatus;
	session_options: SessionOptions<string>;
	/** Shared IP rate limiter (from options). `null` when not configured. */
	ip_rate_limiter: RateLimiter | null;
	/** Per-account login rate limiter (from options). `null` when not configured. */
	login_account_rate_limiter: RateLimiter | null;
	/** Per-account signup rate limiter (from options). `null` when not configured. */
	signup_account_rate_limiter: RateLimiter | null;
	/** Per-IP action-dispatcher rate limiter — shared across HTTP RPC + WS. `null` when not configured. */
	action_ip_rate_limiter: RateLimiter | null;
	/** Per-actor action-dispatcher rate limiter — shared across HTTP RPC + WS. `null` when not configured. */
	action_account_rate_limiter: RateLimiter | null;
	/**
	 * Factory-managed audit log SSE. Non-null when the `audit_log_sse`
	 * option was passed to `create_app_server`, `null` when omitted.
	 * Use `require_audit_sse(ctx)` to assert the invariant.
	 */
	audit_sse: AuditLogSse | null;
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
	 * `BackendWebsocketTransport` `create_app_server` registered
	 * connections against — supplied via `WsEndpointSpec.transport` or
	 * auto-created when omitted. Retain for broadcast / fan-out:
	 *
	 * ```ts
	 * app_server.ws_endpoints['/api/ws'].send_to_account(account_id, msg);
	 * ```
	 *
	 * Empty when no `ws_endpoints` were mounted.
	 */
	ws_endpoints: Readonly<Record<string, BackendWebsocketTransport>>;
	/** Close the database connection. Propagated from `AppBackend`. */
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
export const require_audit_sse = (source: {audit_sse: AuditLogSse | null}): AuditLogSse => {
	if (!source.audit_sse) {
		throw new Error(
			'audit_sse is null — pass `audit_log_sse: true` (or `{role}`) in `AppServerOptions`',
		);
	}
	return source.audit_sse;
};

/** Default maximum request body size: 1 MiB. */
export const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;

/**
 * Create a fully assembled Hono app with auth, middleware, and routes.
 *
 * Handles the assembly lifecycle: proxy middleware → auth middleware →
 * bootstrap status → route specs → surface generation → Hono app assembly →
 * static serving. Database migrations belong to the backend lifecycle —
 * pass `migration_namespaces` to `create_app_backend`.
 *
 * When `audit_log_sse` is set, the SSE registry's listener is appended to
 * `backend.deps.audit.on_event_chain` — no shallow-copy of `AppDeps`. The
 * `audit_sse` field on the returned `AppServer` (and the
 * `AppServerContext` passed to `create_route_specs`) is non-null in that
 * case; consumers can call `require_audit_sse(ctx)` / `require_audit_sse(server)`
 * to assert the invariant.
 *
 * @returns assembled Hono app, backend, surface build, and bootstrap status
 */
export const create_app_server = async (options: AppServerOptions): Promise<AppServer> => {
	const {backend} = options;
	const {deps} = backend;
	const {log} = deps;

	// Rate limiter defaults (undefined = default, null = disable)
	const ip_rate_limiter =
		options.ip_rate_limiter === undefined ? create_rate_limiter() : options.ip_rate_limiter;
	const login_account_rate_limiter =
		options.login_account_rate_limiter === undefined
			? create_rate_limiter(default_login_account_rate_limit)
			: options.login_account_rate_limiter;
	const signup_account_rate_limiter =
		options.signup_account_rate_limiter === undefined
			? create_rate_limiter(default_login_account_rate_limit)
			: options.signup_account_rate_limiter;
	const bearer_ip_rate_limiter =
		options.bearer_ip_rate_limiter === undefined
			? create_rate_limiter()
			: options.bearer_ip_rate_limiter;
	const action_ip_rate_limiter =
		options.action_ip_rate_limiter === undefined
			? create_rate_limiter(default_action_ip_rate_limit)
			: options.action_ip_rate_limiter;
	const action_account_rate_limiter =
		options.action_account_rate_limiter === undefined
			? create_rate_limiter(default_action_account_rate_limit)
			: options.action_account_rate_limiter;

	// Factory-managed audit SSE — appends a listener to the bound emitter's
	// chain so SSE fan-out runs alongside the consumer's `on_audit_event`
	// without rebuilding `AppDeps`.
	const audit_sse: AuditLogSse | null = options.audit_log_sse
		? create_audit_log_sse({
				log,
				role: typeof options.audit_log_sse === 'object' ? options.audit_log_sse.role : undefined,
			})
		: null;
	if (audit_sse) {
		deps.audit.on_event_chain.push(audit_sse.on_audit_event);
	}

	// Proxy middleware
	const proxy_spec = create_proxy_middleware_spec({...options.proxy, log});

	// Auth middleware
	const auth_middleware = await create_auth_middleware_specs(deps, {
		allowed_origins: options.allowed_origins,
		session_options: options.session_options,
		bearer_ip_rate_limiter,
		daemon_token_state: options.daemon_token_state,
	});
	let middleware_specs: Array<MiddlewareSpec> = [proxy_spec, ...auth_middleware];
	if (options.transform_middleware) {
		middleware_specs = options.transform_middleware(middleware_specs);
	}

	// Bootstrap status
	// - undefined / 'disabled': no route mounted; placeholder status.
	// - 'surface_only': route mounted but permanently unavailable; status placeholder.
	// - 'live': real disk + lock check via `check_bootstrap_status`.
	const bootstrap_status: BootstrapStatus =
		options.bootstrap?.mode === 'live'
			? await check_bootstrap_status(deps, {token_path: options.bootstrap.token_path})
			: {available: false, token_path: null};

	// Surface route ref — factory manages the circular ref
	const surface_ref: SurfaceRouteOptions = {
		surface: {
			middleware: [],
			routes: [],
			rpc_endpoints: [],
			ws_endpoints: [],
			env: [],
			events: [],
			diagnostics: [],
		},
	};

	// Route specs (consumer routes + factory-managed routes)
	const context: AppServerContext = {
		deps,
		backend,
		bootstrap_status,
		session_options: options.session_options,
		ip_rate_limiter,
		login_account_rate_limiter,
		signup_account_rate_limiter,
		action_ip_rate_limiter,
		action_account_rate_limiter,
		audit_sse,
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
			session_options: options.session_options,
			bootstrap_status,
			on_bootstrap: options.bootstrap.mode === 'live' ? options.bootstrap.on_bootstrap : undefined,
			ip_rate_limiter,
		});
		const prefix = options.bootstrap.route_prefix ?? '/api/account';
		factory_routes.push(...prefix_route_specs(prefix, bootstrap_routes));
	}

	// RPC endpoint auto-mount — resolve specs then append their routes so
	// surface generation and live dispatch share one source of truth.
	const resolved_rpc_endpoints =
		typeof options.rpc_endpoints === 'function'
			? options.rpc_endpoints(context)
			: options.rpc_endpoints;
	if (resolved_rpc_endpoints) {
		for (const endpoint of resolved_rpc_endpoints) {
			factory_routes.push(
				...create_rpc_endpoint({
					path: endpoint.path,
					actions: endpoint.actions,
					log,
					action_ip_rate_limiter,
					action_account_rate_limiter,
				}),
			);
		}
	}

	// WS endpoint resolution — done here (alongside RPC) so the captured
	// array threads into surface generation below. Actual mount happens
	// after `apply_route_specs` because `register_ws_endpoint` mutates the
	// live Hono `app` (origin / auth / role / authorization middleware +
	// the `app.get(path, ...)` upgrade route), and `app` does not exist
	// until the assembly phase below.
	const resolved_ws_endpoints: ReadonlyArray<WsEndpointSpec> | undefined =
		typeof options.ws_endpoints === 'function'
			? options.ws_endpoints(context)
			: options.ws_endpoints;

	// Surface route (default: enabled)
	if (options.surface_route !== false) {
		factory_routes.push(create_surface_route_spec(surface_ref));
	}

	const route_specs = [...consumer_routes, ...factory_routes];

	// Surface + logging
	const surface_middleware = options.post_route_middleware
		? [...middleware_specs, ...options.post_route_middleware]
		: middleware_specs;
	const all_event_specs = [
		...(options.event_specs ?? []),
		...(audit_sse ? audit_log_event_specs : []),
	];
	const surface_spec = create_app_surface_spec({
		middleware_specs: surface_middleware,
		route_specs,
		env_schema: options.env_schema ?? BaseServerEnv,
		event_specs: all_event_specs,
		rpc_endpoints: resolved_rpc_endpoints,
		ws_endpoints: resolved_ws_endpoints,
	});

	// Config-level diagnostics (concatenated after spec-level from generate_app_surface)
	const config_diagnostics: Array<AppSurfaceDiagnostic> = [];
	const cookie_opts: Partial<SessionCookieOptions> | undefined =
		options.session_options.cookie_options;
	if (cookie_opts) {
		if (cookie_opts.secure === false) {
			config_diagnostics.push({
				level: 'warning',
				category: 'security',
				message: 'Session cookie secure=false — cookies sent over HTTP',
			});
		}
		if (cookie_opts.sameSite && cookie_opts.sameSite !== session_cookie_options.sameSite) {
			config_diagnostics.push({
				level: 'warning',
				category: 'security',
				message: `Session cookie sameSite='${cookie_opts.sameSite}' — weakened from default '${session_cookie_options.sameSite}'`,
			});
		}
		if (cookie_opts.httpOnly === false) {
			config_diagnostics.push({
				level: 'warning',
				category: 'security',
				message: 'Session cookie httpOnly=false — cookie accessible to JS',
			});
		}
	}
	if (ip_rate_limiter === null) {
		config_diagnostics.push({
			level: 'warning',
			category: 'config',
			message: 'IP rate limiter explicitly disabled (null)',
		});
	}
	if (bearer_ip_rate_limiter === null) {
		config_diagnostics.push({
			level: 'warning',
			category: 'config',
			message: 'Bearer IP rate limiter explicitly disabled (null)',
		});
	}
	if (config_diagnostics.length) {
		surface_spec.surface.diagnostics = [...surface_spec.surface.diagnostics, ...config_diagnostics];
	}

	// Backfill the surface ref — factory owns this lifecycle
	surface_ref.surface = surface_spec.surface;
	log_startup_summary(surface_spec.surface, log, options.env_values);

	// Hono app assembly
	const app = new Hono();

	// Two-queue side-effect flush. `pending_effects` collects eager
	// fire-and-forget promises (audit emits, session touch, api-token
	// usage). `post_commit_effects` collects deferred thunks pushed via
	// `emit_after_commit` (WS notifications, anything that must observe a
	// committed transaction). Both queues drain here, after the handler
	// (and any wrapping `db.transaction`) returns. In test mode both are
	// awaited before the response returns; in production, eager-queue
	// rejections are reported via `on_effect_error`.
	app.use('*', async (c, next) => {
		c.set('pending_effects', []);
		c.set('post_commit_effects', []);
		try {
			await next();
		} finally {
			const eager = c.var.pending_effects;
			const deferred = c.var.post_commit_effects;
			if (eager.length || deferred.length) {
				if (options.await_pending_effects) {
					await flush_pending_effects(eager, log);
					await flush_post_commit_effects(deferred, log);
				} else {
					const error_ctx: EffectErrorContext = {method: c.req.method, path: c.req.path};
					const callback = options.on_effect_error;
					void flush_pending_effects(
						eager,
						log,
						callback ? (reason) => callback(reason, error_ctx) : undefined,
					);
					// `flush_post_commit_effects` is non-throwing: per-thunk
					// errors are routed through `log.error` inside the helper,
					// so production fire-and-forget skips the `on_effect_error`
					// fan-out (deferred thunks are wrapped end-to-end already).
					void flush_post_commit_effects(deferred, log);
				}
			}
		}
	});

	if (log.level !== 'off') {
		app.use(logger((msg) => log.info(msg)));
	}

	// Body size limit — rejects oversized payloads before auth/validation.
	// Default 1 MiB; pass null to disable.
	if (options.max_body_size !== null) {
		const max_size = options.max_body_size ?? DEFAULT_MAX_BODY_SIZE;
		app.use(
			bodyLimit({
				maxSize: max_size,
				onError: (c) => c.json({error: ERROR_PAYLOAD_TOO_LARGE}, 413),
			}),
		);
	}

	apply_middleware_specs(app, middleware_specs);
	const authorize = create_fuz_authorization_handler({db: deps.db});
	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, deps.db, authorize);

	// WS endpoint auto-mount — must run after `app` exists and
	// `apply_route_specs` has registered the request routes. Each spec
	// becomes a `register_ws_endpoint` call, plus optional `auth_guard`
	// wiring onto the audit chain. `post_route_middleware` and static
	// serving register after this loop, so WS upgrade routes sit
	// adjacent to the consumer routes and ahead of the static fallback —
	// matches the "WS mount is route registration" mental model.
	const mounted_ws_endpoints: Record<string, BackendWebsocketTransport> = {};
	if (resolved_ws_endpoints?.length) {
		if (options.upgradeWebSocket === undefined) {
			throw new Error(
				'create_app_server: ws_endpoints resolved non-empty but upgradeWebSocket is missing. ' +
					"Pass the Hono adapter's upgradeWebSocket helper as a top-level option.",
			);
		}
		// Cross-surface collision: `register_ws_endpoint` mounts a `GET path`
		// upgrade route. If a `RouteSpec` already registered `GET path`,
		// Hono's last-wins semantics would silently shadow the consumer's
		// GET route — fail fast instead.
		const route_spec_get_paths: Set<string> = new Set();
		for (const r of route_specs) {
			if (r.method === 'GET') route_spec_get_paths.add(r.path);
		}
		const seen_paths: Set<string> = new Set();
		// Dedupe `auth_guard` wiring by transport reference — two specs
		// sharing one transport instance get a single pair of listeners,
		// otherwise revocation events would fire `close_sockets_for_*`
		// twice per event (idempotent on the transport but log-spammy).
		// Cross-spec OR-semantics: any spec with `auth_guard !== false`
		// wires the guard for that transport; once wired, sibling specs
		// (even with explicit `auth_guard: false`) cannot opt out. To
		// disable, every spec sharing the transport must pass `auth_guard: false`.
		const guarded_transports: WeakSet<BackendWebsocketTransport> = new WeakSet();
		for (const endpoint of resolved_ws_endpoints) {
			if (seen_paths.has(endpoint.path)) {
				throw new Error(`create_app_server: duplicate ws_endpoints path: ${endpoint.path}`);
			}
			if (route_spec_get_paths.has(endpoint.path)) {
				throw new Error(
					`create_app_server: ws_endpoints path collides with a GET RouteSpec: ${endpoint.path}`,
				);
			}
			seen_paths.add(endpoint.path);

			const endpoint_transport = endpoint.transport ?? new BackendWebsocketTransport();
			register_ws_endpoint({
				app,
				path: endpoint.path,
				upgradeWebSocket: options.upgradeWebSocket,
				allowed_origins: endpoint.allowed_origins,
				db: deps.db,
				actions: endpoint.actions,
				transport: endpoint_transport,
				heartbeat: endpoint.heartbeat,
				artificial_delay: endpoint.artificial_delay,
				on_socket_open: endpoint.on_socket_open,
				on_socket_close: endpoint.on_socket_close,
				log,
				required_roles: endpoint.required_roles,
				action_ip_rate_limiter,
				action_account_rate_limiter,
			});
			mounted_ws_endpoints[endpoint.path] = endpoint_transport;

			if (endpoint.auth_guard !== false && !guarded_transports.has(endpoint_transport)) {
				guarded_transports.add(endpoint_transport);
				deps.audit.on_event_chain.push(create_ws_auth_guard(endpoint_transport, log));
				deps.audit.on_event_chain.push(create_ws_logout_closer(endpoint_transport, log));
			}
			if (endpoint.extra_audit_handlers?.length) {
				for (const handler of endpoint.extra_audit_handlers) {
					deps.audit.on_event_chain.push(handler);
				}
			}
		}
	}

	// Post-route middleware (before static serving)
	if (options.post_route_middleware) {
		apply_middleware_specs(app, options.post_route_middleware);
	}

	// Static file serving
	if (options.static_serving) {
		const {serve_static, root, spa_fallback, is_spa_route} = options.static_serving;
		for (const mw of create_static_middleware(serve_static, {root, spa_fallback, is_spa_route})) {
			app.use('/*', mw);
		}
	}

	return {
		app,
		surface_spec,
		bootstrap_status,
		migration_results: backend.migration_results,
		audit_sse,
		ws_endpoints: mounted_ws_endpoints,
		close: backend.close,
	};
};
