import './assert_dev_env.js';

/**
 * Integration test helpers — route lookup, response validation, and cookie utilities.
 *
 * @module
 */

import type {RouteSpec, RouteMethod} from '../http/route_spec.js';
import {is_null_schema, merge_error_schemas} from '../http/schema_helpers.js';
import {assert} from 'vitest';

import type {Keyring} from '../auth/keyring.js';
import {create_session_cookie_value, type SessionOptions} from '../auth/session_cookie.js';

/**
 * Find a route spec matching the given method and path.
 *
 * Supports both exact matches and parameterized paths (`:param` segments).
 *
 * @param specs - route specs to search
 * @param method - HTTP method
 * @param path - request path (exact or with concrete param values)
 * @returns matching route spec, or `undefined`
 */
export const find_route_spec = (
	specs: Array<RouteSpec>,
	method: string,
	path: string,
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
 * Find an auth route by suffix and method.
 *
 * Useful for discovering login/logout/verify/revoke paths regardless
 * of consumer prefix (`/api/account/login`, `/api/auth/login`, etc.).
 *
 * @param specs - route specs to search
 * @param suffix - path suffix to match (e.g. `'/login'`)
 * @param method - HTTP method
 * @returns matching route spec, or `undefined`
 */
export const find_auth_route = (
	specs: Array<RouteSpec>,
	suffix: string,
	method: RouteMethod,
): RouteSpec | undefined => {
	return specs.find((s) => s.method === method && s.path.endsWith(suffix));
};

/**
 * Validate a response body against the route spec's declared schemas.
 *
 * For 2xx responses, validates against `spec.output`.
 * For error responses, validates against the merged error schema for that status code.
 * Throws with details on mismatch.
 *
 * @param route_specs - route specs for schema lookup
 * @param method - HTTP method of the request
 * @param path - path of the request
 * @param response - the Response to validate
 */
export const assert_response_matches_spec = async (
	route_specs: Array<RouteSpec>,
	method: string,
	path: string,
	response: Response,
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
				`${method} ${path} (${response.status}) returned non-JSON but has output schema`,
			);
		}
		if (!response.ok) {
			const merged = merge_error_schemas(spec);
			if (merged?.[response.status]) {
				throw new Error(
					`${method} ${path} (${response.status}) returned non-JSON but has error schema for status ${response.status}`,
				);
			}
		}
		return;
	}

	if (response.ok) {
		const result = spec.output.safeParse(body);
		if (!result.success) {
			throw new Error(
				`Output schema mismatch for ${method} ${path} (${response.status}): ${JSON.stringify(result.error.issues)}`,
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
						`Error schema mismatch for ${method} ${path} (${response.status}): ${JSON.stringify(result.error.issues)}`,
					);
				}
			}
		}
	}
};

/**
 * Create an expired test cookie — validly signed but with an expiry timestamp in 1970.
 *
 * @param keyring - keyring for signing
 * @param session_options - session config
 * @returns signed cookie value with long-past expiry
 */
export const create_expired_test_cookie = async (
	keyring: Keyring,
	session_options: SessionOptions<string>,
): Promise<string> => {
	// now_seconds=1 puts the expiry at 1 + max_age seconds past epoch — still in 1970
	return create_session_cookie_value(keyring, 'expired_test_token', session_options, 1);
};

/**
 * Assert that a 429 response includes a valid `Retry-After` header
 * matching the JSON body's `retry_after` field.
 *
 * @param response - the 429 response
 * @param body - parsed JSON body with `retry_after` field
 */
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
	'required_role',
	'retry_after',
	'credential_type',
	'has_references',
	'ok',
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
	'token',
];

/**
 * Assert that an error response body contains no unexpected fields.
 *
 * Error schemas use `z.looseObject` (intentional — multiple producers), but
 * test responses should be checked for fields that could leak information.
 * Flags any field not in the known-safe set.
 *
 * @param body - parsed error response JSON
 * @param context - description for error messages (e.g., `'POST /api/login 401'`)
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
 * stack traces, SQL, or internal paths.
 *
 * @param body - parsed error response JSON
 * @param context - description for error messages
 */
export const assert_no_error_info_leakage = (
	body: Record<string, unknown>,
	context: string,
): void => {
	const body_str = JSON.stringify(body);
	for (const pattern of LEAKY_FIELD_PATTERNS) {
		// check field names (not values — 'error' legitimately contains error codes)
		for (const key of Object.keys(body)) {
			assert.ok(
				!key.toLowerCase().includes(pattern),
				`${context}: error response field '${key}' matches leaky pattern '${pattern}'`,
			);
		}
	}
	// check for stack traces and file paths in values
	assert.ok(
		!body_str.includes('node_modules'),
		`${context}: error response contains node_modules path`,
	);
	assert.ok(!body_str.includes('at '), `${context}: error response contains stack trace`);
	assert.ok(!/\.ts:\d+/.test(body_str), `${context}: error response contains .ts file reference`);
};

/**
 * Assert that a 429 response includes a valid `Retry-After` header
 * matching the JSON body's `retry_after` field.
 *
 * @param response - the 429 response
 * @param body - parsed JSON body with `retry_after` field
 */
export const assert_rate_limit_retry_after_header = (
	response: Response,
	body: {retry_after: number},
): void => {
	const header = response.headers.get('Retry-After');
	assert.ok(header, 'Missing Retry-After header on 429 response');
	const header_value = Number(header);
	assert.ok(!Number.isNaN(header_value), `Retry-After header is not a number: ${header}`);
	assert.strictEqual(
		header_value,
		Math.ceil(body.retry_after),
		`Retry-After header (${header_value}) should equal ceil(retry_after) (${Math.ceil(body.retry_after)})`,
	);
};

// --- Data exposure helpers ---

/** Field names that must never appear in any HTTP response body. */
export const SENSITIVE_FIELD_BLOCKLIST: ReadonlyArray<string> = ['password_hash', 'token_hash'];

/** Field names that must not appear in non-admin HTTP response bodies. */
export const ADMIN_ONLY_FIELD_BLOCKLIST: ReadonlyArray<string> = ['updated_by', 'created_by'];

/**
 * Recursively collect all key names from a parsed JSON value.
 *
 * Walks objects and arrays to find every property name at any nesting depth.
 *
 * @param value - parsed JSON value
 * @returns set of all key names found
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
 * @param body - parsed response JSON
 * @param blocklist - field names to check for
 * @param context - description for error messages
 */
export const assert_no_sensitive_fields_in_json = (
	body: unknown,
	blocklist: ReadonlyArray<string>,
	context: string,
): void => {
	const keys = collect_json_keys_recursive(body);
	for (const field of blocklist) {
		assert.ok(!keys.has(field), `${context}: response contains blocklisted field '${field}'`);
	}
};
