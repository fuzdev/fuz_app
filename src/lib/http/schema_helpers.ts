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
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import { is_schema, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';
import { unwrap_schema } from '@fuzdev/fuz_schema/introspect.ts';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';

import type { RouteAuth } from './auth_shape.ts';
import type { RouteMethod } from './route_spec.ts';
import {
	dedupe_rest_errors,
	derive_route_errors,
	to_error_schemas,
	type ErrorSchemas,
	type RestErrorDef
} from './error_schemas.ts';
import type { MiddlewareSpec } from './middleware_spec.ts';
import type { RateLimitKey } from '../rate_limiter.ts';
import {
	assert_validation_schema,
	parse_any,
	unknown_key_targets,
	type ParseAnyResult,
	type ValidationOutput,
	type ValidationSchema
} from '../schema_issues.ts';

/**
 * Check if a schema is exactly `z.null()`, or a `@fuzdev/fuz_schema`
 * `literal(null)`.
 *
 * Reads the schema's kind rather than parsing `null`, to avoid false
 * positives from `z.nullable(z.string())` or similar schemas that accept
 * null but also accept other values.
 */
export const is_null_schema = (schema: ValidationSchema): boolean =>
	schema instanceof z.ZodNull ||
	(is_schema(schema) && schema.kind === 'literal' && schema.def === null);

/**
 * Check if a schema is exactly `z.void()`, or a `@fuzdev/fuz_schema`
 * `literal(undefined)` (what its `s.void` is, `meta` copies included).
 *
 * RPC action specs use a void schema to declare a parameterless method —
 * JSON-RPC 2.0 forbids `params: null` (params must be omitted or be a
 * Structured value), so void is the correct schema for "no params" and the
 * dispatcher maps absent params to `undefined` for these specs. Like
 * `is_null_schema`, it reads the schema's kind rather than parsing
 * `undefined`, so an optional schema is not void. `z.undefined()` is not
 * void either.
 */
export const is_void_schema = (schema: ValidationSchema): boolean =>
	schema instanceof z.ZodVoid ||
	(is_schema(schema) && schema.kind === 'literal' && schema.def === undefined);

/**
 * Normalize the raw `params` of a void input (`is_void_schema`): an absent
 * `params`, an empty object, and the `null` a GET `?params=null` parses to
 * are all the no-arg call (`undefined`); anything else passes through for the
 * void schema to refuse.
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
 * void input (`is_void_schema`, Zod or fuz_schema), `to_void_params`; for
 * any other input, an absent or `null` `params` reads as `{}`, so an
 * all-optional object input accepts a call that omits them. Every receiving
 * end — the server dispatch (`perform_action`) and a peer receiving a
 * request or notification (`ActionDispatcher`) — reads params through this,
 * so a peer is never stricter than the server.
 *
 * @param input - the action's input schema, Zod or fuz_schema
 * @param raw_params - the call's `params` as parsed off the wire
 * @returns the value the input parse (`parse_any`) reads
 */
export const to_input_params = (input: ValidationSchema, raw_params: unknown): unknown =>
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
 * Check if a schema is a strict object: `z.strictObject()`, or a
 * `@fuzdev/fuz_schema` `object` (which refuses unknown keys, where
 * `strip_object` drops them and `loose_object` keeps them).
 *
 * Strict Zod objects set `catchall` to `ZodNever` to reject unknown keys.
 * Regular `z.object()` has `catchall: undefined` (strips unknown keys in Zod 4).
 * A refined strict object reads strict in both libraries: Zod keeps a
 * `.refine()` on the `ZodObject`, and a fuz_schema `pipe` is read through to
 * its first schema when no stage of it is a `transform` (`message`, `flavor`,
 * `brand` and `meta` keep the kind they wrap). A transformed object is not a
 * strict object in either: Zod's is a `ZodPipe`. The two libraries differ on a
 * pipe without a transform: Zod's `O.pipe(O)` is a `ZodPipe` and reads not
 * strict, where fuz_schema's `pipe(F, F)` reads strict through to `F`.
 */
export const is_strict_object_schema = (schema: ValidationSchema): boolean =>
	is_schema(schema)
		? fuz_schema_untransformed_head(schema)?.kind === 'object'
		: schema instanceof z.ZodObject && schema.def.catchall instanceof z.ZodNever;

// the schema a value reaches first through every `pipe` it starts with, or
// `null` when any of those pipes has a `transform` stage
const fuz_schema_untransformed_head = (schema: AnySchema): AnySchema | null => {
	let s = schema;
	while (s.kind === 'pipe') {
		const stages = s.def as ReadonlyArray<AnySchema>;
		if (stages.some((stage) => stage.kind === 'transform')) return null;
		s = stages[0]!;
	}
	return s;
};

/** Options of `schema_to_surface`. */
export interface SchemaToSurfaceOptions {
	/**
	 * Which side of a parse to describe: `'input'`, what it accepts (a
	 * request body, params, query), or `'output'`, what it returns (a
	 * response, an error body, a pushed event).
	 *
	 * @default 'output'
	 */
	io?: 'input' | 'output';
	/** Names the schema in a thrown error, e.g. `POST /api/thing input`. */
	source?: string;
	/**
	 * Called with the library's message when part of the schema has no JSON
	 * Schema form and is left out or written as `{}` there.
	 */
	on_unrepresentable?: (message: string) => void;
}

/**
 * Convert a Zod or `@fuzdev/fuz_schema` schema to its JSON Schema for the
 * surface, with `$schema` and `default` stripped at every depth.
 *
 * A value of neither library throws first (`assert_validation_schema`),
 * naming `options.source`, so a slot that surface generation reads before
 * any registration does — a route's, an event's `params`, a `ws_endpoints`
 * action's — fails server assembly naming the slot, as registration refuses
 * a route's or action's slot, not as a JSON Schema the emitter could not
 * write.
 *
 * Returns `null` for a null schema (`is_null_schema`) and a void schema
 * (`is_void_schema`), in either library: no body, no params. Any other
 * schema is written with its library's emitter (`to_json_schema` for fuz_schema, `z.toJSONSchema`
 * for Zod) on the side `options.io` names. A part JSON Schema can't say (a
 * transform on the output side, a `z.custom()`, a fuz_schema `check`) is left
 * out or written as `{}` (a `pipe(string, check(…))` writes as
 * `{type: 'string'}`), and `options.on_unrepresentable` hears the library's
 * message, so the surface describes what it can and records the gap.
 *
 * It never answers `null` for a schema it failed to write, as that would
 * read as "takes no input" and drop the schema out of every suite reading the
 * surface: a schema with no JSON Schema form at all (`{}` where the schema
 * isn't `z.unknown()` or `z.any()`), and one either emitter refuses outright
 * (a fuz_schema entry named like a member of `Object.prototype`, metadata
 * that isn't JSON), throw. So an output whose root is a transform (a Zod
 * `.transform()`, a fuz_schema `pipe(object(…), transform(…))`), a
 * `z.custom()`, or a `z.date()` throws, and since `generate_app_surface`
 * runs at server assembly, a route or action declaring one fails the server
 * at boot. That includes `z.unknown().transform(f)`, though `{}` would
 * describe it: the output side of a transform is unknown, whatever its input.
 *
 * @param schema - the schema to describe, Zod or fuz_schema
 * @param options - the side to describe, the schema's name for errors, and a listener for gaps
 * @returns the JSON Schema, or `null` for a null or void schema
 * @throws Error naming `options.source` when the value is of neither library, when the schema can't be written, or when nothing of it can
 */
export const schema_to_surface = (
	schema: ValidationSchema,
	options?: SchemaToSurfaceOptions
): unknown => {
	assert_validation_schema(schema, options?.source ?? 'schema');
	if (is_null_schema(schema) || is_void_schema(schema)) return null;
	const io = options?.io ?? 'output';
	const write = (unrepresentable: 'throw' | 'any'): unknown =>
		strip_json_schema_noise(
			is_schema(schema)
				? to_json_schema(schema, { io, unrepresentable })
				: z.toJSONSchema(schema as z.ZodType, { io, unrepresentable })
		);
	const fail = (message: string, cause: unknown): Error =>
		new Error(`${options?.source ?? 'schema'}: ${message}`, { cause });
	let gap: unknown;
	try {
		return write('throw');
	} catch (error) {
		gap = error;
	}
	// part of the schema has no JSON Schema form: write the rest
	let json: unknown;
	try {
		json = write('any');
	} catch (error) {
		throw fail(`cannot be written as JSON Schema: ${to_error_message(error)}`, error);
	}
	const message = to_error_message(gap);
	if (typeof json === 'object' && json !== null && Object.keys(json).length === 0) {
		throw fail(`has no JSON Schema form: ${message}`, gap);
	}
	options?.on_unrepresentable?.(message);
	return json;
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
 * A route's error map: every error definition the route can answer with, and
 * the status map they group into. Built by `resolve_route_errors`, and read by
 * every reader of a route's declared errors — the surface, the DEV output
 * check, the test helpers, error coverage, and the attack-surface suite.
 */
export interface RouteErrors {
	/**
	 * The definitions, in order — derived, then each applying middleware's, then
	 * the route's own — with each repeat left out (`dedupe_rest_errors`). Two
	 * shapes of one code at one status are both kept.
	 */
	readonly defs: ReadonlyArray<RestErrorDef>;
	/** The definitions grouped by status (`to_error_schemas`): one schema, or a `union` of them. */
	readonly schemas: ErrorSchemas;
}

/** What `resolve_route_errors` reads of a route spec. */
export interface RouteErrorsSpec {
	readonly method: RouteMethod;
	readonly path: string;
	readonly auth: RouteAuth;
	readonly input: ValidationSchema;
	readonly params?: ValidationSchema;
	readonly query?: ValidationSchema;
	readonly rate_limit?: RateLimitKey;
	readonly errors?: ReadonlyArray<RestErrorDef>;
}

/**
 * Resolve a route's error map: the union of the definitions derived from it
 * (`derive_route_errors`, narrowed to the slots it has), those of each
 * middleware layer that runs on it (`middleware_spec_applies`), in list order,
 * and its own `errors`. Nothing replaces anything: a definition at a status
 * another layer declares is one more branch there, and a repeat counts once.
 *
 * @param spec - the route spec
 * @param middleware_specs - the app's middleware layers, of which those that apply to the route contribute
 * @returns the route's error map
 */
export const resolve_route_errors = (
	spec: RouteErrorsSpec,
	middleware_specs?: ReadonlyArray<Pick<MiddlewareSpec, 'path' | 'carve_outs' | 'errors'>> | null
): RouteErrors => {
	const all: Array<RestErrorDef> = derive_route_errors({
		method: spec.method,
		auth: spec.auth,
		has_input: !is_null_schema(spec.input),
		has_params: spec.params !== undefined,
		has_query: spec.query !== undefined,
		rate_limit: spec.rate_limit
	});
	if (middleware_specs) {
		for (const mw of middleware_specs) {
			if (mw.errors && middleware_spec_applies(mw, spec.path)) all.push(...mw.errors);
		}
	}
	if (spec.errors) all.push(...spec.errors);
	const defs = dedupe_rest_errors(all);
	return { defs, schemas: to_error_schemas(defs) };
};

/**
 * Resolve every route's error map (`resolve_route_errors`) against one
 * middleware list, keyed by `route_errors_key` (`METHOD path`).
 *
 * @param route_specs - the app's routes
 * @param middleware_specs - the app's middleware layers
 * @returns each route's error map
 */
export const resolve_app_route_errors = (
	route_specs: ReadonlyArray<RouteErrorsSpec>,
	middleware_specs?: ReadonlyArray<Pick<MiddlewareSpec, 'path' | 'carve_outs' | 'errors'>> | null
): Map<string, RouteErrors> => {
	const route_errors: Map<string, RouteErrors> = new Map();
	for (const spec of route_specs) {
		route_errors.set(route_errors_key(spec), resolve_route_errors(spec, middleware_specs));
	}
	return route_errors;
};

/**
 * The key of a route in a map of route error maps, `METHOD path`.
 *
 * @param route - the route's method and path template
 */
export const route_errors_key = (route: {
	readonly method: string;
	readonly path: string;
}): string => `${route.method} ${route.path}`;

/**
 * A route's error map from a map built by `resolve_app_route_errors`, or,
 * with no map, resolved from the route alone — without middleware.
 *
 * @param route_errors - the app's route error maps, if the caller has them
 * @param spec - the route spec
 * @throws Error naming the route's key when a map is given with no entry for
 *   the route — a map built over other routes, which would silently drop the
 *   middleware's definitions
 */
export const get_route_errors = (
	route_errors: ReadonlyMap<string, RouteErrors> | null | undefined,
	spec: RouteErrorsSpec
): RouteErrors => {
	if (route_errors == null) return resolve_route_errors(spec);
	const key = route_errors_key(spec);
	const errors = route_errors.get(key);
	if (!errors) throw new Error(`get_route_errors: the route error map has no entry for '${key}'`);
	return errors;
};
