import './assert_dev_env.ts';

/**
 * Stub factories for auth surface testing.
 *
 * Provides throwing stubs (catch unexpected access), no-op stubs (allow access
 * without side effects), and pre-built bundles for `AppDeps`.
 *
 * @module
 */

import { Logger } from '@fuzdev/fuz_util/log.ts';

import type { z } from 'zod';

import type { SessionOptions } from '../auth/session_cookie.ts';
import type { MiddlewareSpec } from '../http/middleware_spec.ts';
import { ApiError } from '../http/error_schemas.ts';
import type { AppDeps } from '../auth/deps.ts';
import type { AuditEmitter } from '../auth/audit_emitter.ts';
import { create_realtime_closer } from '../actions/connection_closer.ts';
import type { BootstrapServerOptions } from '../server/app_server.ts';
import type { AppServerContext } from '../server/app_server_context.ts';
import { Db } from '../db/db.ts';
import { prefix_route_specs, type RouteSpec } from '../http/route_spec.ts';
import { bootstrap_route_shape } from '../auth/bootstrap_route_schema.ts';
import { create_rpc_endpoint } from '../actions/action_rpc.ts';
import { create_surface_route_spec, type SurfaceRouteOptions } from '../server/surface_route.ts';
import {
	create_app_surface_spec,
	type AppSurfaceSpec,
	type RpcEndpointSpec
} from '../http/surface.ts';
import {
	resolve_ws_endpoints,
	type ResolvedWsEndpointSpec,
	type WsEndpointSpec
} from '../actions/ws_endpoint_spec.ts';
import type { EventSpec, SseNotification } from '../realtime/sse.ts';
import { AUDIT_LOG_SSE_MAX_PER_SCOPE, type AuditLogSse } from '../realtime/sse_auth_guard.ts';
import { SubscriberRegistry } from '../realtime/subscriber_registry.ts';
import { BaseServerEnv } from '../server/env.ts';
import {
	AUTH_MIDDLEWARE_PATH,
	assert_endpoint_in_auth_scope,
	assert_middleware_stack_mounted
} from '../auth/middleware.ts';

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
					`This dep should not be reached in this test.`
			);
		}
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
	new Proxy({ ...(overrides ?? {}) } as any, {
		get: (target, prop) => {
			if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
			if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
			return async () => undefined;
		}
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
		client: { query: async () => ({ rows: [] }) },
		transaction: async (fn) => fn(create_stub_db())
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
 * immediately; `notify` is a no-op; `add_listener` throws, so a test that
 * wires a listener fails loudly instead of silently never firing
 * (`create_recording_audit_emitter` accepts listeners); `listener_count`
 * returns 0; `drain_inflight` resolves immediately, since nothing is ever
 * written. Tests asserting on real audit-row persistence (or on listener
 * fan-out) build a real emitter via `create_audit_emitter` against a stub or
 * real DB — `create_test_app` already does this on the test backend.
 */
export const create_test_audit_emitter = (): AuditEmitter => ({
	emit: () => {},
	emit_role_grant_target: () => {},
	emit_pool: async () => {},
	notify: () => {},
	add_listener: () => {
		throw new Error(
			'create_test_audit_emitter accepts no listeners — use create_recording_audit_emitter'
		);
	},
	listener_count: () => 0,
	drain_inflight: async () => {}
});

/**
 * Build a no-op `AuditLogSse` for tests that wire `audit_sse` into the
 * surface helper but don't assert on SSE fan-out or subscriber state.
 *
 * `on_audit_event` is a no-op, so nothing is broadcast; the
 * `registry` is a fresh `SubscriberRegistry` instance (call sites that
 * inspect `.size` or call `.close_*` see a real registry, so writes are
 * isolated per test). Tests that need real SSE plumbing build it via
 * `create_audit_log_sse` against `create_test_app`.
 */
export const create_stub_audit_sse = (): AuditLogSse => {
	const registry = new SubscriberRegistry<SseNotification>({
		max_per_scope: AUDIT_LOG_SSE_MAX_PER_SCOPE
	});
	return {
		log: new Logger('test:audit_sse', { level: 'off' }),
		on_audit_event: () => {},
		registry
	};
};

/**
 * Create no-op `AppDeps` for auth surface testing.
 */
export const create_stub_app_deps = (): AppDeps => ({
	read_secure_file: async (path: string) => {
		throw new Error(`ENOENT: no such file or directory: ${path}`);
	},
	delete_file: async (_path: string) => {},
	keyring: create_noop_stub('keyring'),
	password: create_noop_stub('password'),
	db: stub_db,
	log: new Logger('test', { level: 'off' }),
	audit: create_test_audit_emitter(),
	connection_closer: create_realtime_closer()
});

/** A fresh pass-through middleware — a distinct handler per call, unlike the shared `stub_mw`. */
const create_stub_mw = (): MiddlewareSpec['handler'] => async (_c, next) => next();

/**
 * Create the API middleware stub array matching `create_auth_middleware_specs`
 * output — the same names, paths, order, and declared `errors` (the surface
 * merges middleware errors into every route under the path, so a stub that
 * declared more than the real stack would widen the test surface). Like the
 * real factory's, each spec gets its own pass-through handler, so
 * `assert_middleware_stack_mounted` can tell the layers apart by identity.
 */
export const create_stub_api_middleware = (options?: {
	/** Include the daemon_token middleware layer. */
	include_daemon_token?: boolean;
}): Array<MiddlewareSpec> => {
	const specs: Array<MiddlewareSpec> = [
		{
			name: 'origin',
			path: AUTH_MIDDLEWARE_PATH,
			handler: create_stub_mw(),
			errors: { 403: ApiError }
		},
		{ name: 'session', path: AUTH_MIDDLEWARE_PATH, handler: create_stub_mw() },
		{ name: 'request_context', path: AUTH_MIDDLEWARE_PATH, handler: create_stub_mw() },
		{
			name: 'bearer_auth',
			path: AUTH_MIDDLEWARE_PATH,
			handler: create_stub_mw(),
			errors: {}
		}
	];
	if (options?.include_daemon_token) {
		specs.push({
			name: 'daemon_token',
			path: AUTH_MIDDLEWARE_PATH,
			handler: create_stub_mw(),
			errors: {}
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
	session_options: SessionOptions<string>
): AppServerContext => {
	const deps = create_stub_app_deps();
	return {
		deps,
		backend: {
			deps,
			db_type: 'pglite-memory' as any,
			db_name: 'test',
			migration_results: [],
			close: async () => {}
		},
		bootstrap_status: { available: false, token_path: null },
		session_options,
		login_ip_rate_limiter: null,
		signup_ip_rate_limiter: null,
		bootstrap_ip_rate_limiter: null,
		login_account_rate_limiter: null,
		signup_account_rate_limiter: null,
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		audit_sse: null
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
	 * `create_upgrade_websocket` needed — this helper produces an
	 * `AppSurfaceSpec` only, never mounts.
	 */
	ws_endpoints?:
		ReadonlyArray<WsEndpointSpec> | ((ctx: AppServerContext) => ReadonlyArray<WsEndpointSpec>);
	/**
	 * The server's origin allowlist — `AppServerOptions.allowed_origins`.
	 * Read only as the default for a `ws_endpoints` spec that declares no
	 * `allowed_origins`, as `create_app_server` does; required when any spec
	 * omits its own — without it, such a spec throws, since the surface records
	 * the exact patterns the upgrade gate matches.
	 */
	allowed_origins?: ReadonlyArray<RegExp>;
	/**
	 * Transform middleware array — `AppServerOptions.transform_middleware`.
	 * Receives shallow copies of a stub `trusted_proxy` spec (at `'*'`)
	 * followed by the stub auth stack, in a fresh array, as
	 * `create_app_server` passes the real ones. Throws, like
	 * `create_app_server`, if the result doesn't keep each of those specs
	 * mounted once at its original path in its original order
	 * (`assert_middleware_stack_mounted`).
	 */
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
	/**
	 * Symmetric with `AppServerOptions.surface_route` — `true` lists the
	 * admin-only `GET /api/surface`, which `create_app_server` mounts only when
	 * opted in. Pass the same value to both entry points so the surface tests
	 * probe the route exactly when the live server serves it.
	 *
	 * @default false
	 */
	surface_route?: boolean;
	/**
	 * List the `daemon_token` middleware layer, as `create_app_server` mounts
	 * it when given a `daemon_token_state`. Pass `true` exactly when the live
	 * server gets one — `create_test_app` always passes one.
	 *
	 * @default false
	 */
	daemon_token?: boolean;
}

/**
 * Narrow a WS endpoint spec that carries its own `allowed_origins` — the only
 * way it resolves when no server list is given to default from.
 *
 * @throws Error when the spec declares no `allowed_origins`
 */
const to_self_resolved_ws_endpoint = (endpoint: WsEndpointSpec): ResolvedWsEndpointSpec => {
	const { allowed_origins } = endpoint;
	if (!allowed_origins) {
		throw new Error(
			`create_test_app_surface_spec: ws endpoint ${endpoint.path} has no allowed_origins — ` +
				"pass the server's list as create_test_app_surface_spec's allowed_origins option, " +
				'or set allowed_origins on the spec'
		);
	}
	return { ...endpoint, allowed_origins };
};

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
 * Mirrors `create_app_server`'s route assembly, in its order: consumer
 * routes, then the factory-managed bootstrap routes, RPC endpoint routes, and
 * `GET /api/surface` (with `surface_route: true`), then surface
 * generation — including its
 * refusal of an `rpc_endpoints` or `ws_endpoints` path outside the auth
 * middleware's scope (`assert_endpoint_in_auth_scope`) and of a
 * `transform_middleware` that doesn't keep the proxy and auth stack mounted
 * (`assert_middleware_stack_mounted`). The middleware list mirrors the real
 * one: a stub `trusted_proxy` spec at `'*'`, then the stub auth stack (with
 * `daemon_token` when `options.daemon_token` is set). If
 * `create_app_server` changes how it wires routes, update this helper
 * to stay in sync (single source of truth for all consumers).
 *
 * @param options - surface spec options
 * @returns the surface spec for the standard suites
 * @throws Error when an endpoint path is outside `AUTH_MIDDLEWARE_PATH`, a
 *   `ws_endpoints` spec declares no `allowed_origins` and no `allowed_origins`
 *   option is given, or `transform_middleware` moves, drops, duplicates,
 *   reorders, wraps, or replaces the stub proxy spec or a stub auth spec
 */
export const create_test_app_surface_spec = (
	options: CreateTestAppSurfaceSpecOptions
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
		resolved_rpc_endpoints?.flatMap((endpoint) => {
			assert_endpoint_in_auth_scope('rpc_endpoints', endpoint.path);
			return create_rpc_endpoint({
				path: endpoint.path,
				actions: endpoint.actions,
				log: ctx.deps.log,
				action_ip_rate_limiter: ctx.action_ip_rate_limiter,
				action_account_rate_limiter: ctx.action_account_rate_limiter
			});
		}) ?? [];
	// Resolve ws endpoints (mirrors create_app_server). Surface-only —
	// no `register_ws_endpoint` call here, so no `create_upgrade_websocket` needed.
	const declared_ws_endpoints =
		typeof options.ws_endpoints === 'function' ? options.ws_endpoints(ctx) : options.ws_endpoints;
	const resolved_ws_endpoints = options.allowed_origins
		? resolve_ws_endpoints(declared_ws_endpoints, options.allowed_origins)
		: declared_ws_endpoints?.map(to_self_resolved_ws_endpoint);
	for (const endpoint of resolved_ws_endpoints ?? []) {
		assert_endpoint_in_auth_scope('ws_endpoints', endpoint.path);
	}
	// Bootstrap routes mirror `create_app_server`: mounted for `surface_only`
	// and `live` modes; omitted for `disabled` / undefined. Surface generation
	// uses an `available: false` placeholder regardless of mode — the handler
	// short-circuits to 403 ALREADY_BOOTSTRAPPED, which is what surface tests
	// assert on. Live token_path is passed through for shape symmetry only.
	const bootstrap_route_specs: Array<RouteSpec> =
		options.bootstrap && options.bootstrap.mode !== 'disabled'
			? prefix_route_specs(options.bootstrap.route_prefix ?? '/api/account', [
					// Surface generation reads the route shape only — the live hono
					// handler never runs here, so a stub satisfies the RouteSpec type
					// without pulling the in-process Hono app onto cross-process consumers.
					{ ...bootstrap_route_shape, handler: stub_handler }
				])
			: [];
	// the surface route mirrors `create_app_server`'s opt-in mount — its handler
	// serves the surface generated below, backfilled into the same ref
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
	const surface_route_specs: Array<RouteSpec> = options.surface_route
		? [create_surface_route_spec(surface_ref)]
		: [];
	// `create_app_server`'s order: consumer routes, then the factory routes
	const route_specs = [
		...consumer_routes,
		...bootstrap_route_specs,
		...rpc_route_specs,
		...surface_route_specs
	];

	// mirrors `create_app_server`'s `[proxy_spec, ...auth_middleware]`
	const stack_specs: Array<MiddlewareSpec> = [
		{ name: 'trusted_proxy', path: '*', handler: create_stub_mw() },
		...create_stub_api_middleware({ include_daemon_token: options.daemon_token })
	];
	let middleware_specs = stack_specs;
	if (options.transform_middleware) {
		// the transform gets copies in a fresh array, so mutating what it was
		// handed can't rewrite the originals the check matches against
		middleware_specs = options.transform_middleware(stack_specs.map((spec) => ({ ...spec })));
		assert_middleware_stack_mounted(stack_specs, middleware_specs);
	}

	const surface_spec = create_app_surface_spec({
		middleware_specs,
		route_specs,
		env_schema: options.env_schema ?? BaseServerEnv,
		event_specs: options.event_specs,
		rpc_endpoints: resolved_rpc_endpoints,
		ws_endpoints: resolved_ws_endpoints
	});
	surface_ref.surface = surface_spec.surface;
	return surface_spec;
};
