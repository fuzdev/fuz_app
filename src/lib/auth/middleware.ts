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
import type { MiddlewareCarveOut, MiddlewareSpec } from '../http/middleware_spec.ts';
import type { RouteSpec } from '../http/route_spec.ts';
import { ApiError } from '../http/error_schemas.ts';
import { middleware_applies, middleware_paths_overlap } from '../http/schema_helpers.ts';

/**
 * The Hono path pattern the origin check mounts on — every path. A request to
 * any route, the static fallback included, carrying a foreign `Origin` is
 * refused; one with no `Origin` (a probe, a CLI client) passes. The only way
 * out is a named carve-out with a reason (`AuthMiddlewareOptions.origin_carve_outs`).
 * The Rust spine's `fuz_http::compose_stack` checks every route group the
 * same way.
 */
export const ORIGIN_MIDDLEWARE_PATH = '*';

/**
 * The Hono path pattern the auth middleware stack mounts on by default —
 * session parsing, request context, bearer and daemon token auth all run for
 * the paths it matches, and no others (the origin check runs on every path,
 * `ORIGIN_MIDDLEWARE_PATH`).
 *
 * `create_app_server` mounts the stack here, and refuses at assembly (via
 * `assert_endpoint_in_auth_scope`, which `create_test_app_surface_spec` also
 * runs) an `rpc_endpoints`, `ws_endpoints`, or bootstrap path the pattern does
 * not match (tested with `middleware_applies`, which follows Hono: `'/api/*'`
 * matches `/api` and everything under `/api/`): an endpoint outside it would
 * get no session or bearer parsing, so every call or upgrade would be
 * unauthenticated.
 */
export const AUTH_MIDDLEWARE_PATH = '/api/*';

/**
 * Throw when an endpoint path sits outside the auth middleware's scope
 * (`AUTH_MIDDLEWARE_PATH`) — there it would get no session or bearer
 * parsing, so every call or upgrade would be unauthenticated.
 * `middleware_applies` matches the way Hono matches the middleware's pattern.
 *
 * `create_app_server` calls it for every `rpc_endpoints` and `ws_endpoints`
 * path and the bootstrap route at assembly, and `create_test_app_surface_spec`
 * does the same, so a surface snapshot never records an endpoint the real
 * server refuses.
 *
 * @param option - the option the path came from, named in the error
 * @param path - the endpoint path to check
 * @throws Error when `path` is outside `AUTH_MIDDLEWARE_PATH`
 */
export const assert_endpoint_in_auth_scope = (
	option: 'rpc_endpoints' | 'ws_endpoints' | 'bootstrap.route_prefix',
	path: string
): void => {
	if (!middleware_applies(AUTH_MIDDLEWARE_PATH, path)) {
		throw new Error(
			`${option} path ${path} is outside the auth middleware's scope ` +
				`(${AUTH_MIDDLEWARE_PATH}) — it would see every caller as unauthenticated — ` +
				`mount it under /api/`
		);
	}
};

/**
 * Throw when a route that reads or mints a credential sits outside the auth
 * middleware's scope (`AUTH_MIDDLEWARE_PATH`). A route reads one when its
 * `auth.account` is not `'none'`, or when it is marked `reads_credential` (a
 * handler that reads the resolved account behind no gate: account status) —
 * outside the scope no session or bearer parsing runs, so it would answer
 * every caller as unauthenticated. A route
 * mints one when it is marked `mints_credential` (login, signup, bootstrap) —
 * outside the scope an origin carve-out could cover it
 * (`assert_origin_carve_outs_valid` refuses one only inside), and a forged
 * cross-site request to it is login CSRF.
 *
 * Account and signup route specs are relative and the consumer prefixes them,
 * so this is what holds them inside the scope whatever prefix they get.
 * `create_app_server` runs it over every route it registers, consumer and
 * factory alike, and `create_test_app_surface_spec` does the same.
 *
 * @param route_specs - every route the server registers
 * @throws Error naming the first route that reads or mints a credential outside `AUTH_MIDDLEWARE_PATH`
 */
export const assert_credential_routes_in_auth_scope = (
	route_specs: ReadonlyArray<RouteSpec>
): void => {
	for (const spec of route_specs) {
		const reads = spec.auth.account !== 'none' || spec.reads_credential === true;
		if (!reads && !spec.mints_credential) continue;
		if (middleware_applies(AUTH_MIDDLEWARE_PATH, spec.path)) continue;
		throw new Error(
			`route ${spec.method} ${spec.path} ${reads ? 'reads' : 'mints'} a credential but is ` +
				`outside the auth middleware's scope (${AUTH_MIDDLEWARE_PATH}) — ` +
				(reads
					? 'it would see every caller as unauthenticated'
					: 'an origin carve-out could leave it open to cross-site requests') +
				' — mount it under /api/'
		);
	}
};

/**
 * Throw unless every origin carve-out names a path and a reason, and stays
 * off the auth middleware's scope: a path that starts with `/` (a Hono pattern
 * like `/hooks/*` or `/health`), a non-blank reason — a carve-out is an
 * argument someone wrote down, never an empty placeholder — and a pattern that
 * matches nothing under `auth_path` (`middleware_paths_overlap`).
 *
 * The scope rule is what keeps a carve-out off every credentialed route.
 * Assembly holds every route that reads a credential (`auth.account` not
 * `'none'`, or `reads_credential`) or mints one (`mints_credential`: login,
 * signup, bootstrap) inside
 * `AUTH_MIDDLEWARE_PATH` (`assert_credential_routes_in_auth_scope`), and every
 * RPC, WS, and bootstrap endpoint besides (`assert_endpoint_in_auth_scope`).
 * The minting routes declare no auth but are what a forged cross-site request
 * targets, so refusing by route `auth` would miss them; refusing by scope
 * catches them. A route outside the scope reads no credential the auth
 * middleware parses, and mints none, so a carve-out there removes no
 * credentialed check.
 *
 * @param carve_outs - the carve-outs to check
 * @param auth_path - the auth middleware's path pattern (default `AUTH_MIDDLEWARE_PATH`)
 * @throws Error naming the first carve-out with no path, no reason, or a pattern overlapping `auth_path`
 */
export const assert_origin_carve_outs_valid = (
	carve_outs: ReadonlyArray<MiddlewareCarveOut>,
	auth_path: string = AUTH_MIDDLEWARE_PATH
): void => {
	for (const carve_out of carve_outs) {
		if (!carve_out.path.startsWith('/')) {
			throw new Error(
				`origin carve-out path ${JSON.stringify(carve_out.path)} must start with / ` +
					'(a Hono pattern like /hooks/* or /health)'
			);
		}
		if (carve_out.reason.trim() === '') {
			throw new Error(
				`origin carve-out ${carve_out.path} needs a reason — say why the paths are safe ` +
					'without the origin check'
			);
		}
		if (middleware_paths_overlap(carve_out.path, auth_path)) {
			throw new Error(
				`origin carve-out ${carve_out.path} overlaps the auth middleware's scope ` +
					`(${auth_path}) — the routes there read or mint credentials and always take ` +
					'the origin check; carve out a path outside it'
			);
		}
	}
};

/**
 * Copy origin carve-outs into a frozen array of frozen `{path, reason}`
 * records, so a caller that mutates its own array or objects after assembly
 * cannot change what was validated or what the check skips.
 *
 * @param carve_outs - the caller's carve-outs
 * @returns the frozen copy
 */
export const freeze_origin_carve_outs = (
	carve_outs: ReadonlyArray<MiddlewareCarveOut>
): ReadonlyArray<MiddlewareCarveOut> =>
	Object.freeze(carve_outs.map(({ path, reason }) => Object.freeze({ path, reason })));

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
	/**
	 * Path pattern for the session, request-context, bearer, and daemon-token
	 * layers (default: `AUTH_MIDDLEWARE_PATH`, `'/api/*'`). The origin check
	 * always mounts on every path (`ORIGIN_MIDDLEWARE_PATH`).
	 */
	path?: string;
	/**
	 * Paths the origin check skips, each with its reason (default none). Copied
	 * at assembly (`freeze_origin_carve_outs`), then checked by
	 * `assert_origin_carve_outs_valid` — none may overlap `path`; recorded on
	 * the origin spec, so the generated surface leaves the check's `403` off
	 * the carved-out routes.
	 */
	origin_carve_outs?: ReadonlyArray<MiddlewareCarveOut>;
	/** Daemon token state for keeper auth. Omit to disable daemon token middleware. */
	daemon_token_state?: DaemonTokenState;
}

/**
 * Create the auth middleware stack.
 *
 * Returns `[origin, session, request_context, bearer_auth]` middleware specs:
 * the origin check on every path less its carve-outs, the rest for the given
 * path pattern. When `daemon_token_state` is provided, appends
 * a `daemon_token` layer. Apps can append extra entries for non-standard
 * paths (e.g., tx's `/tx` binary endpoint).
 *
 * @param deps - stateless capabilities (keyring, db)
 * @param options - middleware configuration (allowed_origins, session_options, path, daemon_token_state, origin_carve_outs)
 * @throws Error when an origin carve-out has no path or no reason, or overlaps `path`
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
	// copied before it is checked, so what is checked is what runs
	const origin_carve_outs = freeze_origin_carve_outs(options.origin_carve_outs ?? []);
	assert_origin_carve_outs_valid(origin_carve_outs, path);

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
			path: ORIGIN_MIDDLEWARE_PATH,
			handler: verify_request_source(allowed_origins, origin_carve_outs),
			errors: { 403: ApiError },
			...(origin_carve_outs.length > 0 && { carve_outs: origin_carve_outs })
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
