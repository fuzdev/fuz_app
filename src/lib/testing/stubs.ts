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
import type {AppServerContext} from '../server/app_server.js';
import {Db} from '../db/db.js';
import {prefix_route_specs, type RouteSpec} from '../http/route_spec.js';
import {create_bootstrap_route_specs} from '../auth/bootstrap_routes.js';
import {create_app_surface_spec, type AppSurfaceSpec} from '../http/surface.js';
import type {SseEventSpec} from '../realtime/sse.js';
import {BaseServerEnv} from '../server/env.js';

/* eslint-disable @typescript-eslint/require-await */

/**
 * Create a Proxy that throws descriptive errors on any property access or method call.
 *
 * Use for deps that should never be reached during a test. If a test accidentally
 * calls through to a throwing stub, the error message identifies exactly which stub
 * was hit, catching test bugs that would silently pass with `{} as any`.
 *
 * @param label - descriptive name for error messages (e.g. `'keyring'`, `'db'`)
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

/** Stub `AppDeps` for auth surface tests — throws on any method access. */
export const stub_app_deps: AppDeps = {
	stat: create_throwing_stub('stat'),
	read_file: create_throwing_stub('read_file'),
	delete_file: create_throwing_stub('delete_file'),
	keyring: create_throwing_stub('keyring'),
	password: create_throwing_stub('password'),
	db: create_throwing_stub('db'),
	log: create_throwing_stub('log'),
	on_audit_event: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
};

/**
 * Create no-op app deps for auth surface testing.
 *
 * @returns an `AppDeps`-shaped object with no-op deps
 */
export const create_stub_app_deps = (): AppDeps => ({
	stat: async () => null,
	read_file: async () => '',
	delete_file: async (_path: string) => {}, // eslint-disable-line @typescript-eslint/no-empty-function
	keyring: create_noop_stub('keyring'),
	password: create_noop_stub('password'),
	db: stub_db,
	log: new Logger('test', {level: 'off'}),
	on_audit_event: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
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
			close: async () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
		},
		bootstrap_status: {available: false, token_path: null},
		session_options,
		ip_rate_limiter: null,
		login_account_rate_limiter: null,
		signup_account_rate_limiter: null,
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
	event_specs?: Array<SseEventSpec>;
	/** Transform middleware array (e.g., tx's `extend_middleware_for_tx_binary`). */
	transform_middleware?: (specs: Array<MiddlewareSpec>) => Array<MiddlewareSpec>;
	/** Bootstrap route prefix (default: `'/api/account'`). */
	bootstrap_route_prefix?: string;
}

/**
 * Create an `AppSurfaceSpec` for attack surface testing.
 *
 * Mirrors `create_app_server`'s route assembly: consumer routes +
 * factory-managed bootstrap routes + surface generation. If
 * `create_app_server` changes how it wires routes, update this helper
 * to stay in sync (single source of truth for all consumers).
 *
 * @param options - surface spec options
 * @returns the surface spec for snapshot and adversarial testing
 */
export const create_test_app_surface_spec = (
	options: CreateTestAppSurfaceSpecOptions,
): AppSurfaceSpec => {
	const ctx = create_stub_app_server_context(options.session_options);
	const consumer_routes = options.create_route_specs(ctx);

	// Mirror create_app_server's factory-managed route assembly
	const bootstrap_routes = create_bootstrap_route_specs(ctx.deps, {
		session_options: options.session_options,
		bootstrap_status: {available: false, token_path: null},
		ip_rate_limiter: null,
	});
	const prefix = options.bootstrap_route_prefix ?? '/api/account';
	const route_specs = [...consumer_routes, ...prefix_route_specs(prefix, bootstrap_routes)];

	let middleware_specs = create_stub_api_middleware();
	if (options.transform_middleware) {
		middleware_specs = options.transform_middleware(middleware_specs);
	}

	return create_app_surface_spec({
		middleware_specs,
		route_specs,
		env_schema: options.env_schema ?? BaseServerEnv,
		event_specs: options.event_specs,
	});
};
