/**
 * Shared pure helpers for schema introspection and middleware matching.
 *
 * Used by both `http/route_spec.ts` (input validation) and `http/surface.ts`
 * (attack surface generation). Extracted to avoid circular dependencies
 * between routes and middleware.
 *
 * @module
 */

import { z } from 'zod';

import type { RouteAuth } from './auth_shape.ts';
import {
	derive_error_schemas,
	type RateLimitKey,
	type RouteErrorSchemas
} from './error_schemas.ts';

/**
 * Check if a schema is exactly `z.null()`.
 *
 * Uses `instanceof` rather than runtime parsing to avoid false positives
 * from `z.nullable(z.string())` or similar schemas that accept null
 * but also accept other values.
 */
export const is_null_schema = (schema: z.ZodType): boolean => schema instanceof z.ZodNull;

/**
 * Check if a schema is exactly `z.void()`.
 *
 * RPC action specs use `z.void()` to declare a parameterless method —
 * JSON-RPC 2.0 forbids `params: null` (params must be omitted or be a
 * Structured value), so `z.void()` is the correct schema for "no params"
 * and the dispatcher maps absent params to `undefined` for these specs.
 */
export const is_void_schema = (schema: z.ZodType): boolean => schema instanceof z.ZodVoid;

/**
 * Normalize the raw `params` of a `z.void()` input: an absent `params`, an
 * empty object, and the `null` a GET `?params=null` parses to are all the
 * no-arg call (`undefined`); anything else passes through for `z.void()` to
 * refuse.
 *
 * JSON-RPC 2.0 lets a parameterless call omit `params`, and an empty by-name
 * structure carries no parameters, so refusing `{}` would only break clients
 * that send it for a parameterless call. Arrays — `[]` included — are not
 * normalized: RPC params are by-name only. The Rust spine's
 * `require_void_params` accepts the same shapes. Receiving ends reach it
 * through `to_input_params`.
 *
 * @param raw_params - the request's `params` as parsed off the wire
 * @returns `undefined` for an empty shape, else `raw_params` unchanged
 */
export const to_void_params = (raw_params: unknown): unknown => {
	if (raw_params === undefined || raw_params === null) return undefined;
	if (
		typeof raw_params === 'object' &&
		!Array.isArray(raw_params) &&
		Object.keys(raw_params).length === 0
	) {
		return undefined;
	}
	return raw_params;
};

/**
 * Normalize the raw `params` of an RPC call for `input` to validate: for a
 * `z.void()` input, `to_void_params`; for any other input, an absent or
 * `null` `params` reads as `{}`, so an all-optional object input accepts a
 * call that omits them. Every receiving end — the server dispatch
 * (`perform_action`) and a peer receiving a request or notification
 * (`ActionDispatcher`) — reads params through this, so a peer is never
 * stricter than the server.
 *
 * @param input - the action's input schema
 * @param raw_params - the call's `params` as parsed off the wire
 * @returns the value to run `input.safeParse` on
 */
export const to_input_params = (input: z.ZodType, raw_params: unknown): unknown =>
	is_void_schema(input) ? to_void_params(raw_params) : (raw_params ?? {});

/**
 * `schema.safeParse(value)`, except that keys the schema doesn't declare are
 * dropped rather than refused — the forward-compatible read of a payload a
 * remote authored.
 *
 * Output schemas are strict so the server's DEV output validation catches a
 * handler leaking fields it shouldn't. The receiving side, though, is often
 * older than the remote it talks to — a deploy lands before open tabs reload
 * — and a remote that adds a field is making a compatible change. So when
 * every issue is an unrecognized key, those keys are stripped from a copy of
 * `value` and it's parsed again; any other issue (a wrong type, a missing
 * field, `null` where a value is required) still fails. `value` itself is
 * never mutated. This matches serde's default on the Rust spine, which
 * ignores unknown fields. Keys nested in a `z.union` branch surface as a
 * union issue and aren't stripped; a `z.discriminatedUnion` reports its
 * matched branch's issues directly, so those are.
 *
 * Used for a response's `result` (`ActionEvent`) and for a peer's reply to a
 * server-initiated request (`peer/ping`).
 *
 * @param schema - the declared shape
 * @param value - the remote-authored payload
 * @returns the parse result, with undeclared keys dropped on success
 */
export const safe_parse_dropping_unknown_keys = <T extends z.ZodType>(
	schema: T,
	value: unknown
): z.ZodSafeParseResult<z.output<T>> => {
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed;
	const { issues } = parsed.error;
	if (!issues.every((issue) => issue.code === 'unrecognized_keys')) return parsed;
	const stripped = structuredClone(value);
	for (const issue of issues) {
		const target = get_at_path(stripped, issue.path);
		if (typeof target !== 'object' || target === null) return parsed;
		for (const key of issue.keys) {
			Reflect.deleteProperty(target, key);
		}
	}
	return schema.safeParse(stripped);
};

const get_at_path = (value: unknown, path: ReadonlyArray<PropertyKey>): unknown => {
	let current = value;
	for (const segment of path) {
		if (typeof current !== 'object' || current === null) return undefined;
		current = (current as Record<PropertyKey, unknown>)[segment];
	}
	return current;
};

/**
 * Check if a schema is a strict object (`z.strictObject()`).
 *
 * Strict objects set `catchall` to `ZodNever` to reject unknown keys.
 * Regular `z.object()` has `catchall: undefined` (strips unknown keys in Zod 4).
 */
export const is_strict_object_schema = (schema: z.ZodType): boolean =>
	schema instanceof z.ZodObject && schema.def.catchall instanceof z.ZodNever;

/**
 * Convert a Zod schema to a JSON-serializable representation for the surface.
 *
 * Returns `null` for null schemas, JSON Schema for object schemas.
 */
export const schema_to_surface = (schema: z.ZodType): unknown => {
	if (is_null_schema(schema)) return null;
	try {
		const json_schema = z.toJSONSchema(schema);
		return strip_json_schema_noise(json_schema);
	} catch {
		return null;
	}
};

/**
 * Recursively strip `$schema` and `default` from a JSON Schema value.
 *
 * `$schema` is noise for snapshots. `default` can be non-deterministic
 * when schemas use function defaults (e.g. `z.string().default(() => new Date().toISOString())`),
 * and defaults are runtime behavior, not attack surface structure.
 */
const strip_json_schema_noise = (value: unknown): unknown => {
	if (typeof value !== 'object' || value === null) return value;
	if (Array.isArray(value)) return value.map(strip_json_schema_noise);
	const result: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (k === '$schema' || k === 'default') continue;
		result[k] = strip_json_schema_noise(v);
	}
	return result;
};

/**
 * Check if a middleware path pattern applies to a route path.
 *
 * Supports Hono-style patterns:
 * - `/api/*` matches `/api/anything`
 * - `/api/zap/*` matches `/api/zap/runs` but not `/api/account/login`
 * - Exact match: `/health` matches `/health`
 */
export const middleware_applies = (mw_path: string, route_path: string): boolean => {
	if (mw_path === '*') return true;
	if (mw_path === route_path) return true;
	if (mw_path.endsWith('/*')) {
		const prefix = mw_path.slice(0, -1); // '/api/*' → '/api/'
		return route_path.startsWith(prefix) || route_path === prefix.slice(0, -1);
	}
	return false;
};

/**
 * Merge auto-derived, middleware, and explicit error schemas for a route spec.
 *
 * Merge order: derived -> middleware -> explicit route errors.
 * Later layers override earlier ones for the same status code.
 *
 * @param spec - the route spec (needs `auth`, `input`, `params`, `rate_limit`, `errors`)
 * @param middleware_errors - errors contributed by middleware whose path matches the route
 * @returns merged error schemas, or `null` if empty
 */
export const merge_error_schemas = (
	spec: {
		auth: RouteAuth;
		input: z.ZodType;
		params?: z.ZodObject;
		query?: z.ZodObject;
		rate_limit?: RateLimitKey;
		errors?: RouteErrorSchemas;
	},
	middleware_errors?: RouteErrorSchemas | null
): RouteErrorSchemas | null => {
	const derived = derive_error_schemas({
		auth: spec.auth,
		has_input: !is_null_schema(spec.input),
		has_params: !!spec.params,
		has_query: !!spec.query,
		rate_limit: spec.rate_limit
	});
	const merged = { ...derived, ...middleware_errors, ...spec.errors };
	return Object.keys(merged).length > 0 ? merged : null;
};
