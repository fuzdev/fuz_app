/**
 * Auth middleware stack factory.
 *
 * Creates the standard middleware layers (origin, session, request_context,
 * bearer_auth, optional daemon_token) from configuration.
 *
 * @module
 */

import type { SessionOptions } from './session_cookie.ts';
import type { AppDeps } from './deps.ts';
import type { DaemonTokenState } from './daemon_token.ts';
import type { MiddlewareSpec } from '../http/middleware_spec.ts';
import { ApiError } from '../http/error_schemas.ts';
import { middleware_applies } from '../http/schema_helpers.ts';

/**
 * The Hono path pattern the auth middleware stack mounts on by default —
 * origin verification, session parsing, request context, bearer and daemon
 * token auth all run for the paths it matches, and no others.
 *
 * `create_app_server` mounts the stack here, and refuses at assembly (via
 * `assert_endpoint_in_auth_scope`, which `create_test_app_surface_spec` also
 * runs) an `rpc_endpoints` or `ws_endpoints` path the pattern does not match (tested
 * with `middleware_applies`, which follows Hono: `'/api/*'` matches `/api`
 * and everything under `/api/`): an endpoint outside it would get no
 * session parsing, so every call or upgrade would be unauthenticated.
 */
export const AUTH_MIDDLEWARE_PATH = '/api/*';

/**
 * Throw when an endpoint path sits outside the auth middleware's scope
 * (`AUTH_MIDDLEWARE_PATH`) — there it would get no session or bearer
 * parsing, so every call or upgrade would be unauthenticated.
 * `middleware_applies` matches the way Hono matches the middleware's pattern.
 *
 * `create_app_server` calls it for every `rpc_endpoints` and `ws_endpoints`
 * path at assembly, and `create_test_app_surface_spec` does the same, so a
 * surface snapshot never records an endpoint the real server refuses.
 *
 * @param option - the option the path came from, named in the error
 * @param path - the endpoint path to check
 * @throws Error when `path` is outside `AUTH_MIDDLEWARE_PATH`
 */
export const assert_endpoint_in_auth_scope = (
	option: 'rpc_endpoints' | 'ws_endpoints',
	path: string
): void => {
	if (!middleware_applies(AUTH_MIDDLEWARE_PATH, path)) {
		throw new Error(
			`${option} path ${path} is outside the auth middleware's scope ` +
				`(${AUTH_MIDDLEWARE_PATH}) — it would see every caller as unauthenticated — mount it under /api/`
		);
	}
};

/**
 * Throw unless a middleware list still mounts every spec of the stack it was
 * built from — the trusted-proxy spec and the auth middleware — exactly once,
 * at its original path, in its original order.
 *
 * `create_app_server` and `create_test_app_surface_spec` run it on the list
 * a `transform_middleware` option returns, against the stack they handed it
 * (`[proxy, ...auth]`). The endpoint auth-scope check
 * (`assert_endpoint_in_auth_scope`) assumes the auth stack is mounted at
 * `AUTH_MIDDLEWARE_PATH`, and every IP-keyed rate limiter assumes the proxy
 * spec ran first — without it `get_client_ip` answers `'unknown'` for every
 * caller, collapsing each limiter into one shared bucket. So a transform that
 * moves, drops, duplicates, reorders, wraps, or replaces a stack layer is
 * refused. Other specs may sit anywhere, including before the proxy spec and
 * between the auth layers. The check pins where the stack's layers sit, not
 * what added layers do — a layer you add runs with full context access.
 *
 * Each stack spec is matched by its `handler` — the closure its factory built
 * — not by `name`, which any spec can carry, so a same-named replacement or a
 * wrapped handler counts as missing. A spread copy (`{...spec}`) keeps the
 * handler and still matches. Its path is compared with the original's, so
 * pass specs the transform could not reach: the assemblies hand the transform
 * shallow copies in a fresh array and keep the originals here.
 *
 * @param stack_specs - the stack the transform was built from, in mount order
 * @param middleware_specs - the middleware list the transform returned
 * @throws Error when a stack spec is missing, mounted more than once, mounted
 *   at another path, or out of order
 */
export const assert_middleware_stack_mounted = (
	stack_specs: ReadonlyArray<MiddlewareSpec>,
	middleware_specs: ReadonlyArray<MiddlewareSpec>
): void => {
	let previous_index = -1;
	for (const stack_spec of stack_specs) {
		let index = -1;
		let count = 0;
		for (let i = 0; i < middleware_specs.length; i++) {
			if (middleware_specs[i]!.handler === stack_spec.handler) {
				if (count === 0) index = i;
				count++;
			}
		}
		const found =
			count === 0
				? 'missing'
				: count > 1
					? `mounted ${count} times`
					: middleware_specs[index]!.path !== stack_spec.path
						? `mounted at ${middleware_specs[index]!.path}`
						: index < previous_index
							? 'out of order'
							: null;
		if (found) {
			throw new Error(
				`transform_middleware must keep the middleware '${stack_spec.name}' mounted once ` +
					`at ${stack_spec.path} in its original order (${found}) — endpoint auth-scope checks ` +
					'and client-IP rate limiting assume it; add layers around the stack, ' +
					"don't move, drop, wrap, or replace it"
			);
		}
		previous_index = index;
	}
};

/**
 * Per-factory configuration for the standard auth middleware stack.
 */
export interface AuthMiddlewareOptions {
	allowed_origins: Array<RegExp>;
	session_options: SessionOptions<string>;
	/** Path pattern for middleware (default: `AUTH_MIDDLEWARE_PATH`, `'/api/*'`). */
	path?: string;
	/** Daemon token state for keeper auth. Omit to disable daemon token middleware. */
	daemon_token_state?: DaemonTokenState;
}

/**
 * Create the auth middleware stack.
 *
 * Returns `[origin, session, request_context, bearer_auth]` middleware specs
 * for the given path pattern. When `daemon_token_state` is provided, appends
 * a 5th `daemon_token` layer. Apps can append extra entries for non-standard
 * paths (e.g., tx's `/tx` binary endpoint).
 *
 * @param deps - stateless capabilities (keyring, db)
 * @param options - middleware configuration (allowed_origins, session_options, path, daemon_token_state)
 * @returns the middleware spec array
 */
export const create_auth_middleware_specs = async (
	deps: AppDeps,
	options: AuthMiddlewareOptions
): Promise<Array<MiddlewareSpec>> => {
	const { keyring, db } = deps;
	const {
		allowed_origins,
		session_options,
		path = AUTH_MIDDLEWARE_PATH,
		daemon_token_state
	} = options;

	const query_deps = { db };

	// Dynamic imports preserve the bundle-split for type-only consumers of
	// this module (`MiddlewareSpec`, `AuthMiddlewareOptions`, etc.). The
	// runtime chain pulls session_queries + blake3 transitively via
	// session_middleware.js, but type-only imports are erased at compile
	// time and stay free.
	const [
		{ verify_request_source },
		{ create_session_middleware },
		{ create_request_context_middleware },
		{ create_bearer_auth_middleware }
	] = await Promise.all([
		import('../http/origin.ts'),
		import('./session_middleware.ts'),
		import('./request_context.ts'),
		import('./bearer_auth.ts')
	]);

	const session_middleware = create_session_middleware(keyring, session_options);
	const request_context_middleware = create_request_context_middleware(query_deps);
	const bearer_auth_middleware = create_bearer_auth_middleware(query_deps, deps.log);

	const specs: Array<MiddlewareSpec> = [
		{
			name: 'origin',
			path,
			handler: verify_request_source(allowed_origins),
			errors: { 403: ApiError }
		},
		{ name: 'session', path, handler: session_middleware },
		{ name: 'request_context', path, handler: request_context_middleware },
		{
			name: 'bearer_auth',
			path,
			handler: bearer_auth_middleware,
			// Soft-fails on every non-success path — browser context, malformed,
			// invalid, and expired tokens all `next()` through without setting
			// context. The layer returns no error response of its own (it carries
			// no rate limiter, so not even a 429). Auth enforcement (401/403)
			// happens downstream — the RPC dispatcher's pre-authorization /
			// post-authorization auth gates, or `require_auth` / `require_role` on
			// REST — producing consistent JSON-RPC or route-level errors.
			errors: {}
		}
	];

	if (daemon_token_state) {
		const { create_daemon_token_middleware } = await import('./daemon_token_middleware.ts');
		const daemon_token_middleware = create_daemon_token_middleware(
			daemon_token_state,
			query_deps,
			deps.log
		);
		specs.push({
			name: 'daemon_token',
			path,
			handler: daemon_token_middleware,
			// Soft-fails (discards) on every non-success path — browser context,
			// malformed/invalid token, and no-keeper all `next()` through to the
			// dispatcher's credential gate (matching the Rust spine's `None`). The
			// layer returns no error response of its own.
			errors: {}
		});
	}

	return specs;
};
