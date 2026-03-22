/**
 * Shared pure helpers for schema introspection and middleware matching.
 *
 * Used by both `route_spec.ts` (input validation) and `surface.ts`
 * (attack surface generation). Extracted to avoid circular dependencies
 * between routes and middleware.
 *
 * @module
 */

import {z} from 'zod';

import type {RouteAuth} from './route_spec.js';
import {derive_error_schemas, type RateLimitKey, type RouteErrorSchemas} from './error_schemas.js';

/**
 * Check if a schema is exactly `z.null()`.
 *
 * Uses Zod 4 type introspection (`_zod.def.type`) rather than runtime parsing
 * to avoid false positives from `z.nullable(z.string())` or similar schemas
 * that accept null but also accept other values.
 */
export const is_null_schema = (schema: z.ZodType): boolean => schema._zod.def.type === 'null';

/**
 * Check if a schema is a strict object (`z.strictObject()`).
 *
 * Strict objects set `catchall` to `ZodNever` to reject unknown keys.
 * Regular `z.object()` has `catchall: undefined` (strips unknown keys in Zod 4).
 */
export const is_strict_object_schema = (schema: z.ZodType): boolean => {
	if (schema._zod.def.type !== 'object') return false;
	const catchall = (schema._zod.def as {catchall?: z.ZodType}).catchall;
	return catchall?._zod.def.type === 'never';
};

/**
 * Convert a Zod schema to a JSON-serializable representation for the surface.
 *
 * Returns `null` for null schemas, JSON Schema for object schemas.
 */
export const schema_to_surface = (schema: z.ZodType): unknown => {
	if (is_null_schema(schema)) return null;
	try {
		const json_schema = z.toJSONSchema(schema);
		// Strip $schema for cleaner snapshots
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		if (typeof json_schema === 'object' && json_schema !== null && '$schema' in json_schema) {
			const {$schema: _, ...rest} = json_schema as Record<string, unknown>;
			return rest;
		}
		return json_schema;
	} catch {
		return null;
	}
};

/**
 * Check if a middleware path pattern applies to a route path.
 *
 * Supports Hono-style patterns:
 * - `/api/*` matches `/api/anything`
 * - `/api/tx/*` matches `/api/tx/runs` but not `/api/account/login`
 * - Exact match: `/health` matches `/health`
 *
 * @param mw_path - the middleware path pattern
 * @param route_path - the route path
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
 * @param middleware_errors - optional middleware error schemas
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
	const derived = derive_error_schemas(
		spec.auth,
		!is_null_schema(spec.input),
		!!spec.params,
		!!spec.query,
		spec.rate_limit,
	);
	const merged = {...derived, ...middleware_errors, ...spec.errors};
	return Object.keys(merged).length > 0 ? merged : null;
};
