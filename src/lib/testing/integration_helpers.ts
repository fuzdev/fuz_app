import './assert_dev_env.ts';

/**
 * Integration test helpers — route lookup, response validation, and cookie utilities.
 *
 * @module
 */

import { assert } from 'vitest';

import type { RouteSpec, RouteMethod } from '../http/route_spec.ts';
import { is_null_schema, merge_error_schemas } from '../http/schema_helpers.ts';
import { is_public_auth } from '../http/auth_shape.ts';
import type { Keyring } from '../auth/keyring.ts';
import { create_session_cookie_value, type SessionOptions } from '../auth/session_cookie.ts';
import { ROLE_ADMIN } from '../auth/role_schema.ts';
import type { TestAccount } from './app_server.ts';

/**
 * Find a route spec matching the given method and path.
 *
 * Supports both exact matches and parameterized paths (`:param` segments).
 *
 * @param path - request path (exact or with concrete param values)
 */
export const find_route_spec = (
	specs: Array<RouteSpec>,
	method: string,
	path: string
): RouteSpec | undefined => {
	// exact match first
	const exact = specs.find((s) => s.method === method && s.path === path);
	if (exact) return exact;

	// parameterized match — `:param` segments match any value
	return specs.find((s) => {
		if (s.method !== method) return false;
		const spec_parts = s.path.split('/');
		const path_parts = path.split('/');
		if (spec_parts.length !== path_parts.length) return false;
		return spec_parts.every((sp, i) => sp.startsWith(':') || sp === path_parts[i]);
	});
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
 * For 2xx responses, validates against `spec.output`.
 * For error responses, validates against the merged error schema for that status code.
 *
 * @throws Error if no route spec matches `method` + `path`, if the response
 *   body fails to parse against the declared output / error schema, or if the
 *   response is non-JSON despite a declared schema for that status.
 */
export const assert_response_matches_spec = async (
	route_specs: Array<RouteSpec>,
	method: string,
	path: string,
	response: Response
): Promise<void> => {
	const spec = find_route_spec(route_specs, method, path);
	if (!spec) {
		throw new Error(`No route spec found for ${method} ${path}`);
	}

	const cloned = response.clone();
	let body: unknown;
	try {
		body = await cloned.json();
	} catch {
		// Non-JSON response — only acceptable when no schema applies.
		// If the spec declares an output or error schema for this status,
		// getting non-JSON is a real bug.
		if (response.ok && !is_null_schema(spec.output)) {
			throw new Error(
				`${method} ${path} (${response.status}) returned non-JSON but has output schema`
			);
		}
		if (!response.ok) {
			const merged = merge_error_schemas(spec);
			if (merged?.[response.status]) {
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
		const result = spec.output.safeParse(body);
		if (!result.success) {
			throw new Error(
				`Output schema mismatch for ${method} ${path} (${response.status}): ${JSON.stringify(
					result.error.issues
				)}`
			);
		}
	} else {
		const merged = merge_error_schemas(spec);
		if (merged) {
			const status_schema = merged[response.status];
			if (status_schema) {
				const result = status_schema.safeParse(body);
				if (!result.success) {
					throw new Error(
						`Error schema mismatch for ${method} ${path} (${response.status}): ${JSON.stringify(
							result.error.issues
						)}`
					);
				}
			}
		}
	}
};

/**
 * Create an expired test cookie — validly signed but with an expiry timestamp in 1970.
 */
export const create_expired_test_cookie = async (
	keyring: Keyring,
	session_options: SessionOptions<string>
): Promise<string> => {
	// now_seconds=1 puts the expiry at 1 + max_age seconds past epoch — still in 1970
	return create_session_cookie_value(keyring, 'expired_test_token', session_options, 1);
};

/**
 * Known safe fields that may appear in any error response.
 *
 * Error schemas use `z.looseObject` so extra context fields are allowed in production,
 * but test responses should not contain fields that leak internal details (stack traces,
 * SQL, file paths). This set lists the fields that are safe to appear.
 */
const KNOWN_SAFE_ERROR_FIELDS = new Set([
	'error',
	'issues',
	'required_roles',
	'required_credential_types',
	'retry_after',
	'has_references',
	'ok'
]);

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
 * List the fields in an error response body that are not in the known-safe set.
 *
 * Error schemas use `z.looseObject` (intentional — multiple producers), but
 * test responses should be checked for fields that could leak information.
 *
 * @returns array of unexpected field names (empty = clean)
 */
export const check_error_response_fields = (body: Record<string, unknown>): Array<string> => {
	const unexpected: Array<string> = [];
	for (const key of Object.keys(body)) {
		if (!KNOWN_SAFE_ERROR_FIELDS.has(key)) {
			unexpected.push(key);
		}
	}
	return unexpected;
};

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
 * Pick request headers matching a route spec's auth requirement.
 *
 * Maps `RouteAuth` onto a test account's credentials:
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
): Record<string, string> => {
	const { auth } = spec;
	if (is_public_auth(auth)) {
		return { host: 'localhost', origin: 'http://localhost:5173' };
	}
	if (auth.credential_types?.includes('daemon_token')) {
		return keeper.create_daemon_token_headers();
	}
	if (auth.roles?.length) {
		if (auth.roles.includes(ROLE_ADMIN)) {
			return admin_account.create_session_headers();
		}
		return keeper.create_session_headers();
	}
	return authed_account.create_session_headers();
};
