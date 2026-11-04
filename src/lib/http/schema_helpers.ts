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
import { is_schema, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';
import { unwrap_schema } from '@fuzdev/fuz_schema/introspect.ts';

import type { RouteAuth } from './auth_shape.ts';
import type { RouteMethod } from './route_spec.ts';
import {
	derive_error_schemas,
	type RateLimitKey,
	type RouteErrorSchemas
} from './error_schemas.ts';
import {
	parse_any,
	unknown_key_targets,
	type ParseAnyResult,
	type ValidationOutput,
	type ValidationSchema
} from '../schema_issues.ts';

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
 * @returns the value the input parse (`parse_any`) reads
 */
export const to_input_params = (input: z.ZodType, raw_params: unknown): unknown =>
	is_void_schema(input) ? to_void_params(raw_params) : (raw_params ?? {});

/**
 * Check whether a parsed JSON value holds an own `__proto__` key in any
 * object, at any depth — what the dispatcher refuses in a request's `params`
 * (`ERROR_PARAMS_PROTO_KEY`).
 *
 * `JSON.parse` defines `"__proto__"` as an ordinary own key, but the first
 * plain assignment that copies it (`target[key] = value`, as any shallow copy
 * or merge loop does) hits the prototype setter instead, so stored JSON
 * carrying one is a prototype-pollution sink for whoever reads it back. An
 * own `constructor` or `prototype` key is inert on a plain object and is not
 * checked.
 *
 * Walks with an explicit stack rather than recursion: `JSON.parse` accepts
 * nesting deep enough to overflow the call stack, and the walk is linear in
 * the value's nodes, which the request body limit bounds. The Rust spine's
 * `fuz_http::json_has_own_proto_key` is the twin.
 *
 * @param value - a value as `JSON.parse` produced it
 * @returns whether any object in `value` has an own `__proto__` key
 */
export const json_has_own_proto_key = (value: unknown): boolean => {
	const stack: Array<unknown> = [value];
	while (stack.length > 0) {
		const current = stack.pop();
		if (typeof current !== 'object' || current === null) continue;
		if (Array.isArray(current)) {
			for (const item of current) stack.push(item);
			continue;
		}
		if (Object.hasOwn(current, '__proto__')) return true;
		for (const item of Object.values(current)) stack.push(item);
	}
	return false;
};

/**
 * `parse_any(schema, value)`, except that keys the schema doesn't declare are
 * dropped rather than refused — the forward-compatible read of a payload a
 * remote authored. Takes a Zod or a `@fuzdev/fuz_schema` schema.
 *
 * Output schemas are strict so the server's DEV output validation catches a
 * handler leaking fields it shouldn't. The receiving side, though, is often
 * older than the remote it talks to — a deploy lands before open tabs reload
 * — and a remote that adds a field is making a compatible change. So when
 * every issue is an unknown key (`unknown_key_targets`), those keys are
 * stripped from a copy of `value` and it's parsed again, until a parse
 * succeeds or reports anything else; any other issue (a wrong type, a missing
 * field, `null` where a value is required) still fails. `value` itself is
 * never mutated. This matches serde's default on the Rust spine, which
 * ignores unknown fields.
 *
 * A fuz_schema parse reports at most a hundred issues, so a pass that only
 * deleted the reported keys would take a parse per hundred unknown keys,
 * quadratic in a payload of many. So after the first parse that reports
 * unknown keys, one schema-guided pass deletes every key a strict fuz_schema
 * `object` doesn't name anywhere the schema reaches — object entries, array
 * items, record values, the `variant` option the discriminator picks — and
 * the next parse usually succeeds. A key under a fuz_schema `union` is never
 * stripped: which option will match isn't known, and the union fails as one
 * issue of its own. A later `pipe` stage is stripped only as reported, as the
 * pass reads only a pipe's first schema, so keys a later stage refuses that
 * the first names still go a hundred a parse. A pass that finds
 * nothing to strip ends it, and the passes are capped at
 * `UNKNOWN_KEY_PASSES_MAX` for both libraries, past which the last failure is
 * returned, so the work stays linear in the payload whatever its shape.
 *
 * Unions differ by library. A Zod `z.union` of strict objects reports the
 * unknown key itself (`unrecognized_keys` on the object), so it is stripped,
 * as are a `z.discriminatedUnion`'s matched-branch keys. A fuz_schema `union`
 * reports one issue of its own, so a key inside one is not stripped and the
 * parse fails; a `variant` reports its matched option's issues, so those are.
 *
 * Used for a response's `result` (`ActionEvent`) and for a peer's reply to a
 * server-initiated request (`peer/ping`).
 *
 * @param schema - the declared shape, Zod or fuz_schema
 * @param value - the remote-authored payload
 * @returns the parse result, with undeclared keys dropped on success
 */
export const safe_parse_dropping_unknown_keys = <T extends ValidationSchema>(
	schema: T,
	value: unknown
): ParseAnyResult<ValidationOutput<T>> => {
	let parsed = parse_any(schema, value);
	let stripped: unknown;
	for (let pass = 0; !parsed.ok && pass < UNKNOWN_KEY_PASSES_MAX; pass++) {
		const targets = unknown_key_targets(parsed.issues);
		if (!targets) return parsed;
		let removed = false;
		if (stripped === undefined) {
			stripped = structuredClone(value);
			// once: every key a strict `object` the schema reaches doesn't name
			if (is_schema(schema)) removed = strip_unknown_keys_by_schema(schema, stripped);
		}
		for (const { path, keys } of targets) {
			const target = get_at_path(stripped, path);
			if (typeof target !== 'object' || target === null) continue;
			for (const key of keys) {
				if (Object.hasOwn(target, key)) {
					Reflect.deleteProperty(target, key);
					removed = true;
				}
			}
		}
		if (!removed) return parsed;
		parsed = parse_any(schema, stripped);
	}
	return parsed;
};

/**
 * The most parses after the first that `safe_parse_dropping_unknown_keys`
 * runs, each after stripping the keys the one before refused.
 */
export const UNKNOWN_KEY_PASSES_MAX = 4;

// deletes from `value`, in place, every own key of an object a strict
// `object` validates that the object doesn't name, walking the schema with
// the value: object entries, every item of an `array`, every value of a
// `record` and the `rest` of an `object_with_rest`, a `variant`'s option by
// its discriminator as the `variant` picks it, and through `optional`,
// `nullable`, the defaults, a `pipe`'s first schema, and `lazy`
// (`unwrap_schema`). A `union` is left alone: which option will match isn't
// known, and one option's strip could delete a key another names. Any key
// deleted is one the first parse of that position refuses. Each object is
// walked once, by the first schema that reaches it, so an aliased or cyclic
// value ends. Returns whether any key was deleted. An explicit stack, as a
// value can nest deeper than the call stack
const strip_unknown_keys_by_schema = (schema: AnySchema, value: unknown): boolean => {
	let removed = false;
	const seen: Set<object> = new Set();
	// each schema unwrapped once, so a `lazy`'s function is called once per walk
	// for each schema node that reaches it (beside the one call its own `run`
	// makes), not once per value it reaches; a function returning a different
	// schema per call can strip a key the parse's schema names
	const unwrapped: Map<AnySchema, AnySchema> = new Map();
	const unwrap = (node: AnySchema): AnySchema => {
		let s = unwrapped.get(node);
		if (!s) unwrapped.set(node, (s = unwrap_schema(node)));
		return s;
	};
	// each `variant`'s options by discriminator, built as the `variant` builds
	// its own: the last option of a value wins, and a `Map` compares keys by
	// SameValueZero
	const variant_options: Map<AnySchema, Map<unknown, AnySchema>> = new Map();
	const stack: Array<[AnySchema, unknown]> = [[schema, value]];
	while (stack.length > 0) {
		const [node, current] = stack.pop()!;
		if (typeof current !== 'object' || current === null || seen.has(current)) continue;
		seen.add(current);
		let s = unwrap(node);
		if (Array.isArray(current)) {
			if (s.kind === 'array') for (const item of current) stack.push([s.def, item]);
			continue;
		}
		const object = current as Record<string, unknown>;
		if (s.kind === 'variant') {
			let by_value = variant_options.get(s);
			if (!by_value) {
				by_value = new Map();
				for (const option of s.def.options) by_value.set(option.def[s.def.key].def, option);
				variant_options.set(s, by_value);
			}
			// read as the `variant` reads it, through the prototype
			const option = by_value.get(object[s.def.key]);
			if (!option) continue;
			// an option is an object schema, its discriminator an entry of it
			s = unwrap(option);
		}
		switch (s.kind) {
			case 'object':
			case 'loose_object':
			case 'strip_object':
				for (const key of Object.keys(object)) {
					if (Object.hasOwn(s.def, key)) stack.push([s.def[key]!, object[key]]);
					else if (s.kind === 'object') {
						Reflect.deleteProperty(object, key);
						removed = true;
					}
				}
				break;
			case 'object_with_rest':
				for (const key of Object.keys(object)) {
					// the parse drops a `__proto__` key unread, so its value is no rest's
					if (key === '__proto__' && !Object.hasOwn(s.def.entries, key)) continue;
					const entry = Object.hasOwn(s.def.entries, key) ? s.def.entries[key]! : s.def.rest;
					stack.push([entry, object[key]]);
				}
				break;
			case 'record':
				for (const key of Object.keys(object)) stack.push([s.def, object[key]]);
				break;
			default:
			// a `union` and every other kind: nothing to strip
		}
	}
	return removed;
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
 * Check if two middleware path patterns can match a common route path — the
 * pattern-against-pattern form of `middleware_applies`, over the same
 * grammar (`*`, an exact path, or a `/prefix/*` that also matches `/prefix`).
 *
 * @param a - one Hono-style pattern
 * @param b - the other
 */
export const middleware_paths_overlap = (a: string, b: string): boolean => {
	if (a === '*' || b === '*') return true;
	// a `/prefix/*` pattern's shortest match is the bare `/prefix` (`/*` → ``)
	const base = (pattern: string): string =>
		pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
	return middleware_applies(a, base(b)) || middleware_applies(b, base(a));
};

/**
 * Check if a middleware layer runs on a route path: its `path` pattern
 * applies (`middleware_applies`) and none of its `carve_outs` does.
 *
 * @param spec - the layer's `path` and optional `carve_outs`
 * @param route_path - the route path to check
 */
export const middleware_spec_applies = (
	spec: {
		readonly path: string;
		readonly carve_outs?: ReadonlyArray<{ readonly path: string }> | null;
	},
	route_path: string
): boolean =>
	middleware_applies(spec.path, route_path) &&
	!(spec.carve_outs ?? []).some((carve_out) => middleware_applies(carve_out.path, route_path));

/**
 * Merge auto-derived, middleware, and explicit error schemas for a route spec.
 *
 * Merge order: derived -> middleware -> explicit route errors.
 * Later layers override earlier ones for the same status code.
 *
 * @param spec - the route spec (reads `method`, `auth`, `input`, `params`, `query`, `rate_limit`, `errors`)
 * @param middleware_errors - errors contributed by middleware whose path matches the route
 * @returns merged error schemas, or `null` if empty
 */
export const merge_error_schemas = (
	spec: {
		method: RouteMethod;
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
		rate_limit: spec.rate_limit,
		checks_content_type: spec.method === 'POST'
	});
	const merged = { ...derived, ...middleware_errors, ...spec.errors };
	return Object.keys(merged).length > 0 ? merged : null;
};
