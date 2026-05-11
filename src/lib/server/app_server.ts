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
import {z} from 'zod';

import {
	SESSION_COOKIE_OPTIONS,
	type SessionOptions,
	type SessionCookieOptions,
} from '../auth/session_cookie.js';
import type {BootstrapAccountSuccess} from '../auth/bootstrap_account.js';
import type {EventSpec} from '../realtime/sse.js';
import {
	create_audit_log_sse,
	AUDIT_LOG_EVENT_SPECS,
	type AuditLogSse,
} from '../realtime/sse_auth_guard.js';
import type {AppSettings} from '../auth/app_settings_schema.js';
import {query_app_settings_load} from '../auth/app_settings_queries.js';
import {
	create_rate_limiter,
	DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT,
	DEFAULT_ACTION_ACCOUNT_RATE_LIMIT,
	DEFAULT_ACTION_IP_RATE_LIMIT,
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
import {fuz_auth_guard_resolver} from '../auth/route_guards.js';
import {create_fuz_authorization_handler} from '../auth/request_context.js';
import {ERROR_PAYLOAD_TOO_LARGE} from '../http/error_schemas.js';
import {create_rpc_endpoint} from '../actions/action_rpc.js';

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
	bootstrap?: {
		token_path: string | null;
		/** Route prefix for bootstrap routes. Default `'/api/account'`. */
		route_prefix?: string;
		/**
		 * Called after successful bootstrap (account + session created).
		 * Use for app-specific post-bootstrap work like generating API tokens.
		 */
		on_bootstrap?: (result: BootstrapAccountSuccess, c: Context) => Promise<void>;
	};

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
	 * auto-includes `AUDIT_LOG_EVENT_SPECS` in the surface. The result is exposed
	 * on `AppServerContext` (for route factories) and `AppServer` (for the caller).
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
	 * depend on `ctx.deps` / `ctx.app_settings` — e.g.
	 * `create_standard_rpc_actions(ctx.deps, {app_settings: ctx.app_settings})`.
	 */
	rpc_endpoints?: Array<RpcEndpointSpec> | ((context: AppServerContext) => Array<RpcEndpointSpec>);

	/** Env schema for surface generation. Pass `z.object({})` when there are no env vars beyond `BaseServerEnv`. */
	env_schema: z.ZodObject;

	/** Middleware applied after routes, before static serving. Included in surface. */
	post_route_middleware?: Array<MiddlewareSpec>;

	/** Static file serving. Omit if not serving static files. */
	static_serving?: {
		serve_static: ServeStaticFactory;
		spa_fallback?: string;
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
	/** Global app settings (mutable ref — mutated by settings admin route). */
	app_settings: AppSettings;
	/** Factory-managed audit log SSE. `null` when `audit_log_sse` option is not set. */
	audit_sse: AuditLogSse | null;
}

/** Result of `create_app_server()`. */
export interface AppServer {
	app: Hono;
	/** Surface spec — serializable surface + raw specs that produced it. */
	surface_spec: AppSurfaceSpec;
	bootstrap_status: BootstrapStatus;
	/** Global app settings (mutable ref — mutated by settings admin route). */
	app_settings: AppSettings;
	/** Migration results from `create_app_backend` (auth + any `migration_namespaces` passed there). */
	migration_results: ReadonlyArray<MigrationResult>;
	/** Factory-managed audit log SSE. `null` when `audit_log_sse` option is not set. */
	audit_sse: AuditLogSse | null;
	/** Close the database connection. Propagated from `AppBackend`. */
	close: () => Promise<void>;
}

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
 * `backend.deps.audit.on_event_chain` — no shallow-copy of `AppDeps`.
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
			? create_rate_limiter(DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT)
			: options.login_account_rate_limiter;
	const signup_account_rate_limiter =
		options.signup_account_rate_limiter === undefined
			? create_rate_limiter(DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT)
			: options.signup_account_rate_limiter;
	const bearer_ip_rate_limiter =
		options.bearer_ip_rate_limiter === undefined
			? create_rate_limiter()
			: options.bearer_ip_rate_limiter;
	const action_ip_rate_limiter =
		options.action_ip_rate_limiter === undefined
			? create_rate_limiter(DEFAULT_ACTION_IP_RATE_LIMIT)
			: options.action_ip_rate_limiter;
	const action_account_rate_limiter =
		options.action_account_rate_limiter === undefined
			? create_rate_limiter(DEFAULT_ACTION_ACCOUNT_RATE_LIMIT)
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

	// Bootstrap status + app settings
	const bootstrap_status: BootstrapStatus = options.bootstrap
		? await check_bootstrap_status(deps, {token_path: options.bootstrap.token_path})
		: {available: false, token_path: null};

	const app_settings: AppSettings = await query_app_settings_load({db: deps.db});

	// Surface route ref — factory manages the circular ref
	const surface_ref: SurfaceRouteOptions = {
		surface: {middleware: [], routes: [], rpc_endpoints: [], env: [], events: [], diagnostics: []},
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
		app_settings,
		audit_sse,
	};
	const consumer_routes = options.create_route_specs(context);

	// Factory-managed routes appended after consumer routes
	const factory_routes: Array<RouteSpec> = [];

	// Bootstrap routes
	if (options.bootstrap) {
		const bootstrap_routes = create_bootstrap_route_specs(deps, {
			session_options: options.session_options,
			bootstrap_status,
			on_bootstrap: options.bootstrap.on_bootstrap,
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
		...(audit_sse ? AUDIT_LOG_EVENT_SPECS : []),
	];
	const surface_spec = create_app_surface_spec({
		middleware_specs: surface_middleware,
		route_specs,
		env_schema: options.env_schema,
		event_specs: all_event_specs,
		rpc_endpoints: resolved_rpc_endpoints,
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
		if (cookie_opts.sameSite && cookie_opts.sameSite !== SESSION_COOKIE_OPTIONS.sameSite) {
			config_diagnostics.push({
				level: 'warning',
				category: 'security',
				message: `Session cookie sameSite='${cookie_opts.sameSite}' — weakened from default '${SESSION_COOKIE_OPTIONS.sameSite}'`,
			});
		}
		if (cookie_opts.httpOnly === false) {
			config_diagnostics.push({
				level: 'warning',
				category: 'security',
				message: 'Session cookie httpOnly=false — cookie accessible to JavaScript',
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

	// Post-route middleware (before static serving)
	if (options.post_route_middleware) {
		apply_middleware_specs(app, options.post_route_middleware);
	}

	// Static file serving
	if (options.static_serving) {
		const {serve_static, spa_fallback} = options.static_serving;
		for (const mw of create_static_middleware(serve_static, {spa_fallback})) {
			app.use('/*', mw);
		}
	}

	return {
		app,
		surface_spec,
		bootstrap_status,
		app_settings,
		migration_results: backend.migration_results,
		audit_sse,
		close: backend.close,
	};
};
