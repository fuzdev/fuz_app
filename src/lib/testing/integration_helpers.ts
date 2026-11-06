import './assert_dev_env.ts';

/**
 * Integration test helpers — route lookup, response validation, and cookie utilities.
 *
 * @module
 */

import { assert } from 'vitest';

import type { RouteSpec, RouteMethod } from '../http/route_spec.ts';
import { get_route_errors, is_null_schema, type RouteErrors } from '../http/schema_helpers.ts';
import { is_public_auth, type RouteAuth } from '../http/auth_shape.ts';
import { ERROR_AUTHENTICATION_REQUIRED } from '../http/error_schemas.ts';
import { ROLE_ADMIN } from '../auth/role_schema.ts';
import type { TestAccount } from './app_server.ts';
import { create_test_request_headers } from './test_origin.ts';
import { parse_any } from '../schema_issues.ts';
import {
	check_route_error,
	find_mounted_route,
	format_route_error_check,
	is_error_status,
	is_json_response,
	to_mounted_routes,
	type MountedRoute
} from '../http/route_error_check.ts';

/** Each spec list's compiled routes, so a list is compiled once. */
const mounted_routes_cache: WeakMap<
	ReadonlyArray<RouteSpec>,
	Array<MountedRoute<RouteSpec>>
> = new WeakMap();

/**
 * A request path as Hono reads it: the URL's pathname (a query string
 * dropped, `.` and `..` segments resolved), percent-decoded by `decodeURI`
 * with `%25` kept, or the raw path when decoding fails.
 */
const to_hono_path = (path: string): string => {
	let pathname = new URL(path, 'http://localhost').pathname;
	if (pathname.includes('%')) {
		try {
			pathname = decodeURI(pathname.replaceAll('%25', '%2525'));
		} catch {
			// a malformed escape: Hono matches the raw path
		}
	}
	return pathname;
};

/**
 * Find the route spec a request reaches: the first in list (mount) order
 * whose method and path template match it, `HEAD` read as `GET` — the order
 * Hono dispatches by, which the DEV error check reads through Hono's own
 * router (`create_route_lookup`). This lookup is hono-free
 * (`find_mounted_route`), pinned against Hono by the route-lookup tests. The
 * path is read as Hono reads it: its pathname, percent-decoded.
 *
 * A path template passed as the path (`/api/things/:id`, a segment that is
 * `*` or starts with `:`) finds its own spec first, outranking mount order.
 *
 * @param specs - the route specs, in mount order
 * @param method - the request method
 * @param path - request path, concrete or a route's own template
 */
export const find_route_spec = (
	specs: Array<RouteSpec>,
	method: string,
	path: string
): RouteSpec | undefined => {
	// a template names its own spec; only a whole param or wildcard segment
	// makes one, as a concrete path can hold a `:` mid-segment
	if (path.split('/').some((segment) => segment === '*' || segment.startsWith(':'))) {
		const read_method = method === 'HEAD' ? 'GET' : method;
		const own = specs.find((s) => s.method === read_method && s.path === path);
		if (own) return own;
	}
	let routes = mounted_routes_cache.get(specs);
	if (!routes) {
		routes = to_mounted_routes(specs, (spec) => spec);
		mounted_routes_cache.set(specs, routes);
	}
	return find_mounted_route(routes, method, to_hono_path(path));
};

/**
 * REST auth route suffixes on the account/bootstrap surface — the only
 * routes still REST. `find_auth_route` rejects any other suffix at runtime;
 * session/token CRUD, admin operations, and role_grant flows live on the RPC
 * surface and should be reached via `rpc_call`.
 */
export const rest_auth_route_suffixes = [
	'/login',
	'/logout',
	'/password',
	'/verify',
	'/signup',
	'/bootstrap'
] as const;
export type RestAuthRouteSuffix = (typeof rest_auth_route_suffixes)[number];

/**
 * Find a REST auth route by suffix and method.
 *
 * Decouples tests from consumer route prefix (`/api/account/login`,
 * `/api/auth/login`, etc.). `suffix` must be one of
 * `rest_auth_route_suffixes` — throws otherwise so an RPC-only method
 * path (e.g. `/sessions/revoke-all`) fails loudly at the call site
 * instead of silently returning `undefined`.
 *
 * @throws Error if `suffix` is not in `rest_auth_route_suffixes`.
 */
export const find_auth_route = (
	specs: Array<RouteSpec>,
	suffix: RestAuthRouteSuffix,
	method: RouteMethod
): RouteSpec | undefined => {
	if (!rest_auth_route_suffixes.includes(suffix)) {
		throw new Error(
			`find_auth_route: unknown suffix ${JSON.stringify(
				suffix
			)} — expected one of ${rest_auth_route_suffixes.join(', ')}. Use rpc_call for RPC methods.`
		);
	}
	return specs.find((s) => s.method === method && s.path.endsWith(suffix));
};

/**
 * Validate a response body against the route spec's declared schemas.
 *
 * For 2xx responses, validates against `spec.output`. For an error response
 * (400 and up), checks it against the route's error map
 * (`resolve_route_errors`) — the one in `route_errors`, an `AppSurfaceSpec`'s,
 * built with the app's middleware, or without one the route's own — by the
 * rule the DEV error check runs (`check_route_error`): the status must be
 * declared and the body must parse against it. A 500 `internal_error` and a
 * 503 `service_unavailable` are always accepted, and on a `jsonrpc` route (the
 * RPC endpoint's) a JSON-RPC error envelope is not a REST error body; on any
 * other route it is checked like any error body.
 *
 * The route is the one `find_route_spec` finds, the request's as Hono
 * dispatches it. A failure reads as the DEV check logs it
 * (`format_route_error_check`), then `: ` and the issues or the body as JSON.
 *
 * Only a JSON response, by its `Content-Type` (`is_json_response`, the DEV
 * check's gate), has a body to check. A non-JSON response passes only where
 * no schema applies: a 2xx on a route with a null output, or an error status
 * the map doesn't declare.
 *
 * @param route_errors - each route's error map, keyed `METHOD path` (`AppSurfaceSpec.route_errors`)
 * @throws Error if no route spec matches `method` + `path`, if the body fails
 *   its output schema, if a JSON error is at a status the route's map lacks or
 *   off its schema, or if the response is non-JSON despite a declared schema
 *   for its status.
 */
export const assert_response_matches_spec = async (
	route_specs: Array<RouteSpec>,
	method: string,
	path: string,
	response: Response,
	route_errors?: ReadonlyMap<string, RouteErrors> | null
): Promise<void> => {
	const spec = find_route_spec(route_specs, method, path);
	if (!spec) {
		throw new Error(`No route spec found for ${method} ${path}`);
	}

	// the DEV error check's gate: only a JSON response has a body to check
	let body: unknown;
	let parsed = false;
	if (is_json_response(response)) {
		try {
			body = await response.clone().json();
			parsed = true;
		} catch {
			// a body claiming JSON that isn't — read as non-JSON below
		}
	}
	if (!parsed) {
		// Non-JSON response — only acceptable when no schema applies.
		// If the spec declares an output or error schema for this status,
		// getting non-JSON is a real bug.
		if (response.ok && !is_null_schema(spec.output)) {
			throw new Error(
				`${method} ${path} (${response.status}) returned non-JSON but has output schema`
			);
		}
		if (!response.ok) {
			if (get_route_errors(route_errors, spec).schemas[response.status]) {
				throw new Error(
					`${method} ${path} (${
						response.status
					}) returned non-JSON but has error schema for status ${response.status}`
				);
			}
		}
		return;
	}

	if (response.ok) {
		const result = parse_any(spec.output, body);
		if (!result.ok) {
			throw new Error(
				`Output schema mismatch for ${method} ${path} (${response.status}): ${JSON.stringify(
					result.issues
				)}`
			);
		}
	} else if (is_error_status(response.status)) {
		const check = check_route_error(
			get_route_errors(route_errors, spec),
			response.status,
			body,
			spec.jsonrpc ?? false
		);
		if (!check.ok) {
			throw new Error(
				`${format_route_error_check(check, response.status, `${method} ${path}`)}: ${JSON.stringify(
					check.kind === 'schema_mismatch' ? check.issues : body
				)}`
			);
		}
	}
};

/** Fields in error responses that indicate information leakage. */
const LEAKY_FIELD_PATTERNS = [
	'stack',
	'trace',
	'sql',
	'query',
	'internal',
	'password',
	'hash',
	'secret',
	'token'
];

/**
 * Assert that an error response contains no leaky field values.
 *
 * Checks both field names and string values for patterns indicating
 * stack traces, SQL, or internal paths. Accepts `unknown` so callers
 * pass response bodies / nested envelope fields directly without
 * intermediate `as` casts; non-object bodies skip the field-name check.
 *
 * @param context - description for error messages
 */
export const assert_no_error_info_leakage = (body: unknown, context: string): void => {
	const body_str = JSON.stringify(body);
	if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
		for (const pattern of LEAKY_FIELD_PATTERNS) {
			// check field names (not values — 'error' legitimately contains error codes)
			for (const key of Object.keys(body)) {
				assert.ok(
					!key.toLowerCase().includes(pattern),
					`${context}: error response field '${key}' matches leaky pattern '${pattern}'`
				);
			}
		}
	}
	// check for stack traces and file paths in values
	assert.ok(
		!body_str.includes('node_modules'),
		`${context}: error response contains node_modules path`
	);
	assert.ok(!body_str.includes('at '), `${context}: error response contains stack trace`);
	assert.ok(!/\.ts:\d+/.test(body_str), `${context}: error response contains .ts file reference`);
};

/**
 * Assert that a 429 response includes a valid `Retry-After` header
 * matching the JSON body's `retry_after` field.
 */
export const assert_rate_limit_retry_after_header = (
	response: Response,
	body: { retry_after: number }
): void => {
	const header = response.headers.get('Retry-After');
	assert.ok(header, 'Missing Retry-After header on 429 response');
	const header_value = Number(header);
	assert.ok(!Number.isNaN(header_value), `Retry-After header is not a number: ${header}`);
	assert.strictEqual(
		header_value,
		Math.ceil(body.retry_after),
		`Retry-After header (${header_value}) should equal ceil(retry_after) (${Math.ceil(
			body.retry_after
		)})`
	);
};

// --- Data exposure helpers ---

/** Field names that must never appear in any HTTP response body. */
export const sensitive_field_blocklist: ReadonlyArray<string> = ['password_hash', 'token_hash'];

/** Field names that must not appear in non-admin HTTP response bodies. */
export const admin_only_field_blocklist: ReadonlyArray<string> = ['updated_by', 'created_by'];

/**
 * Recursively collect all key names from a parsed JSON value.
 *
 * Walks objects and arrays to find every property name at any nesting depth.
 */
export const collect_json_keys_recursive = (value: unknown): Set<string> => {
	const keys = new Set<string>();
	const walk = (v: unknown): void => {
		if (v === null || v === undefined || typeof v !== 'object') return;
		if (Array.isArray(v)) {
			for (const item of v) walk(item);
			return;
		}
		for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
			keys.add(key);
			walk(val);
		}
	};
	walk(value);
	return keys;
};

/**
 * Assert that a parsed JSON body contains no fields from the given blocklist.
 *
 * @param context - description for error messages
 */
export const assert_no_sensitive_fields_in_json = (
	body: unknown,
	blocklist: ReadonlyArray<string>,
	context: string
): void => {
	const keys = collect_json_keys_recursive(body);
	for (const field of blocklist) {
		assert.ok(!keys.has(field), `${context}: response contains blocklisted field '${field}'`);
	}
};

/**
 * Header-builder triple shared by `TestApp` (in-process) and `TestFixture`
 * (cross-backend fixture protocol). Both satisfy this shape structurally —
 * `pick_auth_headers` accepts either without a cast.
 */
export interface KeeperHeaderProvider {
	create_session_headers: (extra?: Record<string, string>) => Record<string, string>;
	create_bearer_headers: (extra?: Record<string, string>) => Record<string, string>;
	create_daemon_token_headers: (extra?: Record<string, string>) => Record<string, string>;
}

/**
 * Who a generated request calls as, picked from the declared auth: no
 * credential for a public route or method, else the keeper's daemon token
 * (`credential_types` names it), the admin account's session (an
 * admin-gated one), the keeper's session (another role), or the authed
 * account's session.
 */
export type AuthPrincipal = 'public' | 'daemon_token' | 'admin' | 'keeper' | 'authed';

/**
 * Pick the principal a generated request calls as, from its declared auth.
 * Shared by the REST and RPC round-trips (`pick_auth_headers`,
 * `pick_rpc_auth`), so both call each auth shape as the same principal.
 *
 * Every principal but `'public'` carries a live credential of the kind the
 * auth names, so the backend must authenticate it; a role mismatch (a keeper
 * session on a role the keeper lacks) still refuses as 403, after
 * authentication.
 */
export const pick_auth_principal = (auth: RouteAuth): AuthPrincipal => {
	if (is_public_auth(auth)) return 'public';
	if (auth.credential_types?.includes('daemon_token')) return 'daemon_token';
	if (auth.roles?.length) return auth.roles.includes(ROLE_ADMIN) ? 'admin' : 'keeper';
	return 'authed';
};

/**
 * The request headers carrying a principal's credential.
 *
 * @param principal - the principal `pick_auth_principal` chose
 * @param keeper - the keeper's header builders
 * @param authed_account - the account the `'authed'` principal calls as
 * @param admin_account - the account the `'admin'` principal calls as
 */
export const to_principal_headers = (
	principal: AuthPrincipal,
	keeper: KeeperHeaderProvider,
	authed_account: TestAccount,
	admin_account: TestAccount
): Record<string, string> => {
	switch (principal) {
		case 'public':
			return create_test_request_headers();
		case 'daemon_token':
			return keeper.create_daemon_token_headers();
		case 'admin':
			return admin_account.create_session_headers();
		case 'keeper':
			return keeper.create_session_headers();
		case 'authed':
			return authed_account.create_session_headers();
	}
};

/**
 * Pick request headers matching a route spec's auth requirement
 * (`pick_auth_principal`, then `to_principal_headers`):
 * - `none` — origin headers only
 * - `authenticated` — the authed account's session cookie
 * - `role: admin` — the admin account's session cookie
 * - `role: <other>` — the keeper provider's session
 * - `keeper` — the keeper provider's daemon token
 */
export const pick_auth_headers = (
	spec: RouteSpec,
	keeper: KeeperHeaderProvider,
	authed_account: TestAccount,
	admin_account: TestAccount
): Record<string, string> =>
	to_principal_headers(pick_auth_principal(spec.auth), keeper, authed_account, admin_account);

/**
 * Whether a round-trip sends a request as a fresh account rather than the
 * shared authed one: a side-effecting request picked for the `'authed'`
 * principal. Generated input omits optional fields, and an omitted target on
 * a self-service action is the caller — `account_delete` deletes it,
 * `account_session_revoke_all`, a logout or a password change end its
 * session — so any side-effecting call may destroy the credential it was sent
 * with, and on a shared account every later call would refuse as
 * unauthenticated. Keyed on the request's own side-effect signal (an action's
 * `side_effects`, a route's non-`GET` method) rather than a list of known
 * destroyers, so a consumer's self-targeting action is covered without
 * registering it. The other principals stay shared: the keeper and its daemon
 * token are one per fixture, and an admin-gated request with generated nil ids
 * targets no existing account. A credential they lose still fails the
 * round-trip on its 401 check (`is_unauthenticated_refusal`).
 *
 * @param principal - the principal `pick_auth_principal` chose
 * @param side_effects - whether the request can change state
 */
export const round_trip_uses_fresh_account = (
	principal: AuthPrincipal,
	side_effects: boolean
): boolean => principal === 'authed' && side_effects;

/**
 * Whether a response says the request carried no valid credential: a 401
 * whose reason is `authentication_required`, or that names no reason. A 401
 * naming another reason is a handler's own answer to an authenticated call —
 * `invalid_credentials` for a wrong current password — and is not this.
 *
 * @param status - the HTTP status
 * @param reason - the refusal's reason: a REST body's `error`, a JSON-RPC
 *   error's `data.reason`
 */
export const is_unauthenticated_refusal = (status: number, reason: unknown): boolean =>
	status === 401 && (reason === undefined || reason === ERROR_AUTHENTICATION_REQUIRED);
