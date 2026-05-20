import './assert_dev_env.js';

/**
 * Stub factories for auth surface testing.
 *
 * Provides throwing stubs (catch unexpected access), no-op stubs (allow access
 * without side effects), and pre-built bundles for `AppDeps`.
 *
 * @module
 */

import {Logger} from '@fuzdev/fuz_util/log.js';

import type {z} from 'zod';

import type {SessionOptions} from '../auth/session_cookie.js';
import type {MiddlewareSpec} from '../http/middleware_spec.js';
import {ApiError, RateLimitError} from '../http/error_schemas.js';
import type {AppDeps} from '../auth/deps.js';
import type {AuditEmitter} from '../auth/audit_emitter.js';
import type {AuditLogEvent} from '../auth/audit_log_schema.js';
import type {AppServerContext, BootstrapServerOptions} from '../server/app_server.js';
import {Db} from '../db/db.js';
import {prefix_route_specs, type RouteSpec} from '../http/route_spec.js';
import {create_bootstrap_route_specs} from '../auth/bootstrap_routes.js';
import {create_rpc_endpoint} from '../actions/action_rpc.js';
import {
	create_app_surface_spec,
	type AppSurfaceSpec,
	type RpcEndpointSpec,
} from '../http/surface.js';
import type {WsEndpointSpec} from '../actions/ws_endpoint_spec.js';
import type {EventSpec, SseNotification} from '../realtime/sse.js';
import {AUDIT_LOG_SSE_MAX_PER_SCOPE, type AuditLogSse} from '../realtime/sse_auth_guard.js';
import {SubscriberRegistry} from '../realtime/subscriber_registry.js';
import {BaseServerEnv} from '../server/env.js';

/**
 * Create a Proxy that throws descriptive errors on any property access or method call.
 *
 * Use for deps that should never be reached during a test. If a test accidentally
 * calls through to a throwing stub, the error message identifies exactly which stub
 * was hit, catching test bugs that would silently pass with `{} as any`.
 *
 * JS-internal probes (`Symbol`, `then`, `constructor`, `$$typeof`) return
 * `undefined` so the proxy doesn't crash framework-level identity checks;
 * `toJSON` returns `"[throwing_stub:label]"` so accidental serialization
 * surfaces the stub's identity in console output rather than silent `"{}"`.
 *
 * @param label - descriptive name for error messages (e.g. `'keyring'`, `'db'`)
 * @throws Error on any non-internal property access, labeled with the stub
 *   name and the offending property.
 */
export const create_throwing_stub = <T = any>(label: string): T =>
	new Proxy({} as any, {
		get: (_target, prop) => {
			// allow JS internals that runtime/test frameworks probe
			if (
				typeof prop === 'symbol' ||
				prop === 'then' ||
				prop === 'constructor' ||
				prop === '$$typeof'
			)
				return undefined;
			// Return a sentinel for JSON serialization so accidental serialization
			// is visible in output (e.g. "[throwing_stub:keyring]") rather than
			// silently producing "{}". Does not throw — avoids crashing vitest
			// assertion diffs and console.log output that contain stubs.
			if (prop === 'toJSON') return () => `[throwing_stub:${label}]`;
			throw new Error(
				`Throwing stub '${label}' — unexpected access to '${prop}'. ` +
					`This dep should not be reached in this test.`,
			);
		},
	}) as T;

/**
 * Create a Proxy where every method access returns a no-op async function.
 *
 * Use for deps that may be reached during "correct auth passes guard" tests
 * but whose return values don't matter. Unlike the explicit method listing,
 * this auto-updates when interfaces change.
 *
 * @param label - descriptive name for debug purposes
 * @param overrides - explicit properties to set (e.g. `{db: stub_db}`)
 */
export const create_noop_stub = <T = any>(_label: string, overrides?: Record<string, unknown>): T =>
	new Proxy({...(overrides ?? {})} as any, {
		get: (target, prop) => {
			if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
			if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
			return async () => undefined;
		},
	}) as T;

/** Throwing stub — use for deps that should never be reached. */
export const stub: any = create_throwing_stub('stub');

/**
 * Create a stub `Db` for handler tests that use `apply_route_specs` with declarative transactions.
 *
 * Returns a real `Db` instance with:
 * - `query` returns empty rows (safety net for unmocked query functions)
 * - `query_one` returns undefined
 * - `transaction(fn)` calls `fn(db)` synchronously (no real transaction)
 */
export const create_stub_db = (): Db =>
	new Db({
		client: {query: async () => ({rows: []})},
		transaction: async (fn) => fn(create_stub_db()),
	});

/** Stub handler that returns a 200 response. */
export const stub_handler = (): Response => new Response('stub');

/** Stub middleware that passes through. */
export const stub_mw = async (_c: any, next: any): Promise<void> => next();

const stub_db = create_noop_stub('stub_db');

/**
 * Build a no-op `AuditEmitter` for tests that don't assert on audit fan-out.
 *
 * `emit` / `emit_role_grant_target` are no-ops; `emit_pool` resolves
 * immediately; `notify` is a no-op; `on_event_chain` is a frozen empty
 * array — pushing onto it throws at runtime, so a test that wires a
 * listener fails loudly instead of silently never firing. Tests asserting
 * on real audit-row persistence (or on listener fan-out) build a real
 * emitter via `create_audit_emitter` against a stub or real DB —
 * `create_test_app` already does this on the test backend.
 */
export const create_test_audit_emitter = (): AuditEmitter => ({
	emit: () => {},
	emit_role_grant_target: () => {},
	emit_pool: async () => {},
	notify: () => {},
	on_event_chain: Object.freeze([]) as unknown as Array<(event: AuditLogEvent) => void>,
});

/**
 * Build a no-op `AuditLogSse` for tests that wire `audit_sse` into the
 * surface helper but don't assert on SSE fan-out or subscriber state.
 *
 * `subscribe` returns a no-op cleanup; `on_audit_event` is a no-op; the
 * `registry` is a fresh `SubscriberRegistry` instance (call sites that
 * inspect `.size` or call `.close_*` see a real registry, so writes are
 * isolated per test). Tests that need real SSE plumbing build it via
 * `create_audit_log_sse` against `create_test_app`.
 */
export const create_stub_audit_sse = (): AuditLogSse => {
	const registry = new SubscriberRegistry<SseNotification>({
		max_per_scope: AUDIT_LOG_SSE_MAX_PER_SCOPE,
	});
	return {
		subscribe: () => () => {},
		log: new Logger('test:audit_sse', {level: 'off'}),
		on_audit_event: () => {},
		registry,
	};
};

/** Stub `AppDeps` for auth surface tests — throws on any method access. */
export const stub_app_deps: AppDeps = {
	stat: create_throwing_stub('stat'),
	read_text_file: create_throwing_stub('read_text_file'),
	delete_file: create_throwing_stub('delete_file'),
	keyring: create_throwing_stub('keyring'),
	password: create_throwing_stub('password'),
	db: create_throwing_stub('db'),
	log: create_throwing_stub('log'),
	audit: create_test_audit_emitter(),
};

/**
 * Create no-op `AppDeps` for auth surface testing.
 */
export const create_stub_app_deps = (): AppDeps => ({
	stat: async () => null,
	read_text_file: async () => '',
	delete_file: async (_path: string) => {},
	keyring: create_noop_stub('keyring'),
	password: create_noop_stub('password'),
	db: stub_db,
	log: new Logger('test', {level: 'off'}),
	audit: create_test_audit_emitter(),
});

/** Create the API middleware stub array matching `create_auth_middleware_specs` output. */
export const create_stub_api_middleware = (options?: {
	/** Include the daemon_token middleware layer. */
	include_daemon_token?: boolean;
}): Array<MiddlewareSpec> => {
	const specs: Array<MiddlewareSpec> = [
		{name: 'origin', path: '/api/*', handler: stub_mw, errors: {403: ApiError}},
		{name: 'session', path: '/api/*', handler: stub_mw},
		{name: 'request_context', path: '/api/*', handler: stub_mw},
		{
			name: 'bearer_auth',
			path: '/api/*',
			handler: stub_mw,
			errors: {401: ApiError, 403: ApiError, 429: RateLimitError},
		},
	];
	if (options?.include_daemon_token) {
		specs.push({
			name: 'daemon_token',
			path: '/api/*',
			handler: stub_mw,
			errors: {401: ApiError, 500: ApiError, 503: ApiError},
		});
	}
	return specs;
};

/**
 * Create a stub `AppServerContext` for attack surface testing.
 *
 * Provides sensible defaults for all fields. Pass `session_options` since
 * it varies per consumer; other fields use stubs/nulls.
 *
 * @param session_options - consumer's session config (required — varies per app)
 */
export const create_stub_app_server_context = (
	session_options: SessionOptions<string>,
): AppServerContext => {
	const deps = create_stub_app_deps();
	return {
		deps,
		backend: {
			deps,
			db_type: 'pglite-memory' as any,
			db_name: 'test',
			migration_results: [],
			close: async () => {},
		},
		bootstrap_status: {available: false, token_path: null},
		session_options,
		ip_rate_limiter: null,
		login_account_rate_limiter: null,
		signup_account_rate_limiter: null,
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		app_settings: {open_signup: false, updated_at: null, updated_by: null},
		audit_sse: null,
	};
};

/** Options for `create_test_app_surface_spec`. */
export interface CreateTestAppSurfaceSpecOptions {
	/** Consumer's session config (required — varies per app). */
	session_options: SessionOptions<string>;
	/** Consumer's route factory — receives the same `AppServerContext` as production. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/** Env schema for surface generation (default: `BaseServerEnv`). */
	env_schema?: z.ZodObject;
	/** SSE event specs for surface generation. */
	event_specs?: Array<EventSpec>;
	/**
	 * RPC endpoint specs for surface generation.
	 *
	 * Accepts either an array (eager) or a factory
	 * `(ctx: AppServerContext) => Array<RpcEndpointSpec>` — symmetric with
	 * `create_app_server`'s `rpc_endpoints` option, so consumers can pass
	 * the same factory to both entry points. The factory runs once against
	 * the stub `AppServerContext` this helper already builds.
	 */
	rpc_endpoints?: Array<RpcEndpointSpec> | ((ctx: AppServerContext) => Array<RpcEndpointSpec>);
	/**
	 * WebSocket endpoint specs for surface generation. Symmetric with
	 * `create_app_server`'s `ws_endpoints` option — pass the same value
	 * to both entry points so the attack surface tests see the same WS
	 * endpoints production auto-mounts. The factory runs once against
	 * the stub `AppServerContext` this helper already builds. No
	 * `upgradeWebSocket` needed — this helper produces an `AppSurfaceSpec`
	 * only, never mounts.
	 */
	ws_endpoints?:
		| ReadonlyArray<WsEndpointSpec>
		| ((ctx: AppServerContext) => ReadonlyArray<WsEndpointSpec>);
	/** Transform middleware array (e.g., tx's `extend_middleware_for_tx_binary`). */
	transform_middleware?: (specs: Array<MiddlewareSpec>) => Array<MiddlewareSpec>;
	/**
	 * Bootstrap config — symmetric with `AppServerOptions.bootstrap`. Discriminated
	 * by `mode`: `'disabled'` skips the route (same as omission), `'surface_only'`
	 * mounts the route shape, `'live'` accepts a `token_path` for production
	 * symmetry (surface assembly only uses it for shape symmetry; the value is a
	 * live-execution concern handled by `create_test_app` → `create_app_server`).
	 *
	 * Surface assembly only reads `route_prefix` (default `'/api/account'`).
	 */
	bootstrap?: BootstrapServerOptions;
}

/**
 * Create an `AppSurfaceSpec` for the standard testing suites.
 *
 * Used by both in-process and cross-process tests as the schema source —
 * the cross-process-ness lives in the transport + per-test fixture, not
 * here. The on-disk `*_attack_surface.json` snapshot is observability
 * (gen-time drift detection via `assert_surface_matches_snapshot`); the
 * suites consume the spec object this function returns, not the JSON
 * file.
 *
 * Mirrors `create_app_server`'s route assembly: consumer routes +
 * factory-managed bootstrap routes + surface generation. If
 * `create_app_server` changes how it wires routes, update this helper
 * to stay in sync (single source of truth for all consumers).
 *
 * @param options - surface spec options
 * @returns the surface spec for the standard suites
 */
export const create_test_app_surface_spec = (
	options: CreateTestAppSurfaceSpecOptions,
): AppSurfaceSpec => {
	const ctx = create_stub_app_server_context(options.session_options);
	const consumer_routes = options.create_route_specs(ctx);

	// Auto-mount rpc endpoints (mirrors create_app_server) so consumer
	// `create_route_specs` does not need to call `create_rpc_endpoint`.
	const resolved_rpc_endpoints =
		typeof options.rpc_endpoints === 'function'
			? options.rpc_endpoints(ctx)
			: options.rpc_endpoints;
	const rpc_route_specs: Array<RouteSpec> =
		resolved_rpc_endpoints?.flatMap((endpoint) =>
			create_rpc_endpoint({
				path: endpoint.path,
				actions: endpoint.actions,
				log: ctx.deps.log,
			}),
		) ?? [];
	// Resolve ws endpoints (mirrors create_app_server). Surface-only —
	// no `register_ws_endpoint` call here, so no `upgradeWebSocket` needed.
	const resolved_ws_endpoints =
		typeof options.ws_endpoints === 'function' ? options.ws_endpoints(ctx) : options.ws_endpoints;
	// Bootstrap routes mirror `create_app_server`: mounted for `surface_only`
	// and `live` modes; omitted for `disabled` / undefined. Surface generation
	// uses an `available: false` placeholder regardless of mode — the handler
	// short-circuits to 403 ALREADY_BOOTSTRAPPED, which is what surface tests
	// assert on. Live token_path is passed through for shape symmetry only.
	const bootstrap_route_specs: Array<RouteSpec> =
		options.bootstrap && options.bootstrap.mode !== 'disabled'
			? prefix_route_specs(
					options.bootstrap.route_prefix ?? '/api/account',
					create_bootstrap_route_specs(ctx.deps, {
						session_options: options.session_options,
						bootstrap_status: {
							available: false,
							token_path: options.bootstrap.mode === 'live' ? options.bootstrap.token_path : null,
						},
						ip_rate_limiter: null,
					}),
				)
			: [];
	const route_specs = [...consumer_routes, ...rpc_route_specs, ...bootstrap_route_specs];

	let middleware_specs = create_stub_api_middleware();
	if (options.transform_middleware) {
		middleware_specs = options.transform_middleware(middleware_specs);
	}

	return create_app_surface_spec({
		middleware_specs,
		route_specs,
		env_schema: options.env_schema ?? BaseServerEnv,
		event_specs: options.event_specs,
		rpc_endpoints: resolved_rpc_endpoints,
		ws_endpoints: resolved_ws_endpoints,
	});
};
