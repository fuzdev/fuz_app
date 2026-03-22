/**
 * Server assembly factory.
 *
 * `create_app_server()` eliminates the ~100 lines of duplicated server assembly
 * shared by tx, visiones, and mageguild. Consumers provide a pre-initialized
 * `AppBackend` and options (session, origins, routes); the factory handles
 * middleware, bootstrap status, surface generation, and Hono app assembly.
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
import type {SseEventSpec} from '../realtime/sse.js';
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
	type RateLimiter,
} from '../rate_limiter.js';
import type {DaemonTokenState} from '../auth/daemon_token.js';
import {run_migrations, type MigrationNamespace, type MigrationResult} from '../db/migrate.js';
import {AUTH_MIGRATION_NAMESPACE} from '../auth/migrations.js';
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
import {create_auth_middleware_specs} from '../auth/middleware.js';
import {fuz_auth_guard_resolver} from '../auth/route_guards.js';
import {ERROR_PAYLOAD_TOO_LARGE} from '../http/error_schemas.js';

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

	/** Consumer migration namespaces — run after auth migrations during init. */
	migration_namespaces?: Array<MigrationNamespace>;

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
	 * When truthy, creates an `AuditLogSse` instance internally, wires `on_audit_event`
	 * on the backend deps (composing with any existing callback), and auto-includes
	 * `AUDIT_LOG_EVENT_SPECS` in the surface. The result is exposed on `AppServerContext`
	 * (for route factories) and `AppServer` (for the caller).
	 *
	 * Pass `true` for defaults (admin role), or `{role: 'custom'}` for a custom role.
	 * Omit to wire audit SSE manually.
	 */
	audit_log_sse?: true | {role?: string};

	/** SSE event specs for surface generation. Defaults to `[]` (no SSE events). */
	event_specs?: Array<SseEventSpec>;

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
	/** Combined migration results — auth migrations from `create_app_backend` plus consumer migrations. */
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
 * Handles the full lifecycle: consumer migrations → proxy middleware →
 * auth middleware → bootstrap status → route specs → surface generation →
 * Hono app assembly → static serving.
 *
 * @param options - server configuration
 * @returns assembled Hono app, backend, surface build, and bootstrap status
 */
export const create_app_server = async (options: AppServerOptions): Promise<AppServer> => {
	const {backend} = options;
	const {log} = backend.deps;

	// 1. Consumer migrations
	let all_migration_results: ReadonlyArray<MigrationResult> = backend.migration_results;
	if (options.migration_namespaces?.length) {
		// guard against namespace collision with fuz_app's internal migrations
		for (const ns of options.migration_namespaces) {
			if (ns.namespace === AUTH_MIGRATION_NAMESPACE) {
				throw new Error(
					`Migration namespace "${AUTH_MIGRATION_NAMESPACE}" is reserved by fuz_app — choose a different namespace`,
				);
			}
		}
		const consumer_results = await run_migrations(backend.deps.db, options.migration_namespaces);
		all_migration_results = [...backend.migration_results, ...consumer_results];
	}

	// 2. Rate limiter defaults (undefined = default, null = disable)
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

	// 3. Factory-managed audit SSE (shallow copy deps, no mutation of backend.deps)
	const audit_sse: AuditLogSse | null = options.audit_log_sse
		? create_audit_log_sse({
				log,
				role: typeof options.audit_log_sse === 'object' ? options.audit_log_sse.role : undefined,
			})
		: null;

	const deps: AppDeps = audit_sse
		? {
				...backend.deps,
				on_audit_event: (event) => {
					audit_sse.on_audit_event(event);
					backend.deps.on_audit_event(event);
				},
			}
		: backend.deps;

	// 4. Proxy middleware
	const proxy_spec = create_proxy_middleware_spec({...options.proxy, log});

	// 5. Auth middleware
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

	// 6. Bootstrap status + app settings
	const bootstrap_status: BootstrapStatus = options.bootstrap
		? await check_bootstrap_status(deps, {token_path: options.bootstrap.token_path})
		: {available: false, token_path: null};

	const app_settings: AppSettings = await query_app_settings_load({db: deps.db});

	// 7. Surface route ref — factory manages the circular ref
	const surface_ref: SurfaceRouteOptions = {
		surface: {middleware: [], routes: [], env: [], events: [], diagnostics: []},
	};

	// 8. Route specs (consumer routes + factory-managed routes)
	const context: AppServerContext = {
		deps,
		backend,
		bootstrap_status,
		session_options: options.session_options,
		ip_rate_limiter,
		login_account_rate_limiter,
		signup_account_rate_limiter,
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

	// Surface route (default: enabled)
	if (options.surface_route !== false) {
		factory_routes.push(create_surface_route_spec(surface_ref));
	}

	const route_specs = [...consumer_routes, ...factory_routes];

	// 9. Surface + logging
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

	// 10. Hono app assembly
	const app = new Hono();

	// Pending effects — collects fire-and-forget promises (audit logs, usage tracking).
	// In test mode, effects are awaited before the response returns.
	// In production, rejected effects are reported via on_effect_error.
	app.use('*', async (c, next) => {
		c.set('pending_effects', []);
		try {
			await next();
		} finally {
			const effects = c.var.pending_effects;
			if (effects.length) {
				if (options.await_pending_effects) {
					await Promise.allSettled(effects);
				} else {
					const ctx: EffectErrorContext = {method: c.req.method, path: c.req.path};
					const callback = options.on_effect_error;
					void Promise.allSettled(effects).then((results) => {
						for (const result of results) {
							if (result.status === 'rejected') {
								log.error('Pending effect rejected:', result.reason, ctx);
								callback?.(result.reason, ctx);
							}
						}
					});
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
	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, deps.db);

	// 11. Post-route middleware (before static serving)
	if (options.post_route_middleware) {
		apply_middleware_specs(app, options.post_route_middleware);
	}

	// 12. Static file serving
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
		migration_results: all_migration_results,
		audit_sse,
		close: backend.close,
	};
};
