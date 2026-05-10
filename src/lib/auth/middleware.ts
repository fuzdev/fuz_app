/**
 * Auth middleware stack factory.
 *
 * Creates the standard middleware layers (origin, session, request_context,
 * bearer_auth, optional daemon_token) from configuration.
 *
 * @module
 */

import type {SessionOptions} from './session_cookie.js';
import type {AppDeps} from './deps.js';
import type {DaemonTokenState} from './daemon_token.js';
import type {RateLimiter} from '../rate_limiter.js';
import type {MiddlewareSpec} from '../http/middleware_spec.js';
import {ApiError, RateLimitError} from '../http/error_schemas.js';

/**
 * Per-factory configuration for the standard auth middleware stack.
 */
export interface AuthMiddlewareOptions {
	allowed_origins: Array<RegExp>;
	session_options: SessionOptions<string>;
	/** Path pattern for middleware (default: `'/api/*'`). */
	path?: string;
	/** Daemon token state for keeper auth. Omit to disable daemon token middleware. */
	daemon_token_state?: DaemonTokenState;
	/** Rate limiter for bearer token auth attempts (per-IP). Pass `null` to disable. */
	bearer_ip_rate_limiter: RateLimiter | null;
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
	options: AuthMiddlewareOptions,
): Promise<Array<MiddlewareSpec>> => {
	const {keyring, db} = deps;
	const {
		allowed_origins,
		session_options,
		path = '/api/*',
		daemon_token_state,
		bearer_ip_rate_limiter,
	} = options;

	const query_deps = {db};

	// Dynamic imports preserve the bundle-split for type-only consumers of
	// this module (`MiddlewareSpec`, `AuthMiddlewareOptions`, etc.). The
	// runtime chain is wider since the session_lifecycle fold (v0.56.0) —
	// loading session_middleware.js now transitively pulls session_queries
	// + blake3 — but type-only imports are erased at compile time and stay
	// free.
	const [
		{verify_request_source},
		{create_session_middleware},
		{create_request_context_middleware},
		{create_bearer_auth_middleware},
	] = await Promise.all([
		import('../http/origin.js'),
		import('./session_middleware.js'),
		import('./request_context.js'),
		import('./bearer_auth.js'),
	]);

	const session_middleware = create_session_middleware(keyring, session_options);
	const request_context_middleware = create_request_context_middleware(query_deps, deps.log);
	const bearer_auth_middleware = create_bearer_auth_middleware(
		query_deps,
		bearer_ip_rate_limiter,
		deps.log,
	);

	const specs: Array<MiddlewareSpec> = [
		{
			name: 'origin',
			path,
			handler: verify_request_source(allowed_origins),
			errors: {403: ApiError},
		},
		{name: 'session', path, handler: session_middleware},
		{name: 'request_context', path, handler: request_context_middleware},
		{
			name: 'bearer_auth',
			path,
			handler: bearer_auth_middleware,
			// Bearer middleware soft-fails for invalid/expired tokens (calls next()
			// without setting context). Only 429 is a hard-fail from this layer.
			// Auth enforcement (401/403) happens downstream — the RPC dispatcher's
			// pre-validation / post-authorization auth gates, or `require_auth` /
			// `require_role` on REST — producing consistent JSON-RPC or
			// route-level errors.
			errors: {429: RateLimitError},
		},
	];

	if (daemon_token_state) {
		const {create_daemon_token_middleware} = await import('./daemon_token_middleware.js');
		const daemon_token_middleware = create_daemon_token_middleware(daemon_token_state, query_deps);
		specs.push({
			name: 'daemon_token',
			path,
			handler: daemon_token_middleware,
			errors: {401: ApiError, 500: ApiError, 503: ApiError},
		});
	}

	return specs;
};
