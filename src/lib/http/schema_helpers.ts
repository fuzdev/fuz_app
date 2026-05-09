/**
 * Shared pure helpers for schema introspection and middleware matching.
 *
 * Used by both `http/route_spec.ts` (input validation) and `http/surface.ts`
 * (attack surface generation). Extracted to avoid circular dependencies
 * between routes and middleware.
 *
 * @module
 */

import {z} from 'zod';

import {needs_actor, type RouteAuth} from './auth_shape.js';
import {derive_error_schemas, type RateLimitKey, type RouteErrorSchemas} from './error_schemas.js';

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
 * Whether the dispatcher's authorization phase may emit actor-failure
 * errors on this route is derived from `spec.auth.actor !== 'none'`
 * directly — see `TODO_AUTH_SHAPE.md` registry-time invariant 2:
 * `actor !== 'none' ⟺ input declares acting?: ActingActor`. With the
 * biconditional enforced at registration time, the http/ framework
 * reads the actor axis off the auth shape itself; it no longer needs an
 * `is_acting_aware` callback to peek at the input schema. See
 * `http/CLAUDE.md` § Three-layer error-schema merge.
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
	middleware_errors?: RouteErrorSchemas | null,
): RouteErrorSchemas | null => {
	const derived = derive_error_schemas({
		auth: spec.auth,
		has_input: !is_null_schema(spec.input),
		has_params: !!spec.params,
		has_query: !!spec.query,
		rate_limit: spec.rate_limit,
		acting_aware: needs_actor(spec.auth),
	});
	const merged = {...derived, ...middleware_errors, ...spec.errors};
	return Object.keys(merged).length > 0 ? merged : null;
};
