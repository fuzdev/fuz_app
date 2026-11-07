/**
 * Shared pure helpers for schema introspection and middleware matching.
 *
 * Used by both `http/route_spec.ts` (input validation) and `http/surface.ts`
 * (attack surface generation). Extracted to avoid circular dependencies
 * between routes and middleware.
 *
 * @module
 */

import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import {
	parse,
	type AnySchema,
	type Infer,
	type SchemaKind,
	type SchemaResult
} from '@fuzdev/fuz_schema/schema.ts';
import { unwrap_schema } from '@fuzdev/fuz_schema/introspect.ts';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';

import { assert_validation_schema, unknown_key_targets } from '../schema_issues.ts';

/**
 * The kind the testing generators switch on: the innermost layer's
 * `@fuzdev/fuz_schema` kind, with an object schema of any strictness as
 * `'object'`, and a `literal(null)` and a `literal(undefined)` (`s.void`) as
 * `'null'` and `'void'`.
 */
export type SchemaFieldBaseType =
	Exclude<SchemaKind, 'loose_object' | 'strip_object' | 'object_with_rest'> | 'null' | 'void';

/**
 * What the testing generators read of one field of an object schema
 * (`to_object_schema_view`, `testing/schema_generators.ts`).
 */
export interface SchemaFieldInfo {
	/** The field's key. */
	name: string;
	/** The innermost layer's kind, `SchemaFieldBaseType`. */
	base_type: SchemaFieldBaseType;
	/** Whether the key must be present: no `optional` layer. */
	required: boolean;
	/** Whether the parse fills the key in when it is missing. */
	has_default: boolean;
	/** Whether a wrapping layer accepts `null`. */
	nullable: boolean;
}

/**
 * Check if a schema is exactly `literal(null)`.
 *
 * Reads the schema's kind rather than parsing `null`, to avoid false
 * positives from `nullable(string)` or similar schemas that accept null but
 * also accept other values.
 */
export const is_null_schema = (schema: AnySchema): boolean =>
	schema.kind === 'literal' && schema.def === null;

/**
 * Check if a schema is exactly `literal(undefined)` (what `s.void` is,
 * `meta` copies included).
 *
 * RPC action specs use a void schema to declare a parameterless method —
 * JSON-RPC 2.0 forbids `params: null` (params must be omitted or be a
 * Structured value), so void is the correct schema for "no params" and the
 * dispatcher maps absent params to `undefined` for these specs. Like
 * `is_null_schema`, it reads the schema's kind rather than parsing
 * `undefined`, so an optional schema is not void.
 */
export const is_void_schema = (schema: AnySchema): boolean =>
	schema.kind === 'literal' && schema.def === undefined;

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
 * void input (`is_void_schema`), `to_void_params`; for
 * any other input, an absent or `null` `params` reads as `{}`, so an
 * all-optional object input accepts a call that omits them. Every receiving
 * end — the server dispatch (`perform_action`) and a peer receiving a
 * request or notification (`ActionDispatcher`) — reads params through this,
 * so a peer is never stricter than the server.
 *
 * @param input - the action's input schema
 * @param raw_params - the call's `params` as parsed off the wire
 * @returns the value the input parse (`parse`) reads
 */
export const to_input_params = (input: AnySchema, raw_params: unknown): unknown =>
	is_void_schema(input) ? to_void_params(raw_params) : (raw_params ?? {});

/** What one walk of a parsed JSON value finds (`scan_json_value`). */
export interface JsonValueScan {
	/** An object holds an own `__proto__` key, at any depth (`ERROR_PARAMS_PROTO_KEY`). */
	proto_key: boolean;
	/** A string or an object key holds U+0000 (`ERROR_PARAMS_NUL`). */
	nul: boolean;
}

/**
 * Walks a parsed JSON value once for the two things a request may not store,
 * at any depth: an own `__proto__` key, and U+0000 in a string or a key.
 *
 * `JSON.parse` defines `"__proto__"` as an ordinary own key, but the first
 * plain assignment that copies it (`target[key] = value`, as any shallow copy
 * or merge loop does) hits the prototype setter instead, so stored JSON
 * carrying one is a prototype-pollution sink for whoever reads it back. An
 * own `constructor` or `prototype` key is inert on a plain object and is not
 * checked.
 *
 * U+0000 is valid JSON (`"\u0000"`), but Postgres refuses it in `text` and in
 * `jsonb`, so a value holding one fails its write with a 500. The dispatcher
 * refuses either in `params` (`invalid_params`, the proto key first), and a
 * route refuses a NUL in its JSON body (`invalid_request_body`), both after
 * the authority gates as any input refusal is.
 *
 * Walks with an explicit stack rather than recursion: `JSON.parse` accepts
 * nesting deep enough to overflow the call stack, and the walk is linear in
 * the value's nodes, which the request body limit bounds. It reads the parsed
 * value, not the text, so of two duplicate keys only the kept one is walked —
 * as on the Rust spine, whose `serde_json::Value` keeps the last too. The twin
 * is `fuz_http::scan_json_value`.
 *
 * @param value - a value as `JSON.parse` produced it
 * @returns what the walk found
 */
export const scan_json_value = (value: unknown): JsonValueScan => {
	let proto_key = false;
	let nul = false;
	const stack: Array<unknown> = [value];
	while (stack.length > 0 && !(proto_key && nul)) {
		const current = stack.pop();
		if (typeof current === 'string') {
			if (!nul && current.includes('\0')) nul = true;
			continue;
		}
		if (typeof current !== 'object' || current === null) continue;
		if (Array.isArray(current)) {
			for (const item of current) stack.push(item);
			continue;
		}
		const record = current as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (key === '__proto__') proto_key = true;
			if (!nul && key.includes('\0')) nul = true;
			stack.push(record[key]);
		}
	}
	return { proto_key, nul };
};

/**
 * `parse(schema, value)`, except that keys the schema doesn't declare are
 * dropped rather than refused — the forward-compatible read of a payload a
 * remote authored.
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
 * A parse reports at most a hundred issues, so a pass that only
 * deleted the reported keys would take a parse per hundred unknown keys,
 * quadratic in a payload of many. So after the first parse that reports
 * unknown keys, one schema-guided pass deletes every key a strict `object`
 * doesn't name anywhere the schema reaches — object entries, array items,
 * record values, the `variant` option the discriminator picks — and the next
 * parse usually succeeds. A key under a `union` is never
 * stripped: which option will match isn't known, and the union fails as one
 * issue of its own. A later `pipe` stage is stripped only as reported, as the
 * pass reads only a pipe's first schema, so keys a later stage refuses that
 * the first names still go a hundred a parse. A pass that finds
 * nothing to strip ends it, and the passes are capped at
 * `UNKNOWN_KEY_PASSES_MAX`, past which the last failure is
 * returned, so the work stays linear in the payload whatever its shape.
 *
 * A `union` reports one issue of its own, so a key inside one is not
 * stripped and the parse fails; a `variant` reports its matched option's
 * issues, so those are.
 *
 * Used for a response's `result` (`ActionEvent`) and for a peer's reply to a
 * server-initiated request (`peer/ping`).
 *
 * @param schema - the declared shape
 * @param value - the remote-authored payload
 * @returns the parse result, with undeclared keys dropped on success
 */
export const safe_parse_dropping_unknown_keys = <T extends AnySchema>(
	schema: T,
	value: unknown
): SchemaResult<Infer<T>> => {
	let parsed = parse(schema, value);
	let stripped: unknown;
	for (let pass = 0; !parsed.ok && pass < UNKNOWN_KEY_PASSES_MAX; pass++) {
		const targets = unknown_key_targets(parsed.issues);
		if (!targets) return parsed;
		let removed = false;
		if (stripped === undefined) {
			stripped = structuredClone(value);
			// once: every key a strict `object` the schema reaches doesn't name
			removed = strip_unknown_keys_by_schema(schema, stripped);
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
		parsed = parse(schema, stripped);
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
 * Check if a schema is a strict object: an `object` (which refuses unknown
 * keys, where `strip_object` drops them and `loose_object` keeps them).
 *
 * A refined strict object reads strict: a `pipe` is read through to its first
 * schema when no stage of it is a `transform` (`message`, `flavor`, `brand`
 * and `meta` keep the kind they wrap), so `pipe(O, O)` reads strict through
 * to `O`. A transformed object is not a strict object.
 */
export const is_strict_object_schema = (schema: AnySchema): boolean =>
	untransformed_head(schema)?.kind === 'object';

// the schema a value reaches first through every `pipe` it starts with, or
// `null` when any of those pipes has a `transform` stage
const untransformed_head = (schema: AnySchema): AnySchema | null => {
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
	 * Called with the emitter's message when part of the schema has no JSON
	 * Schema form and is left out or written as `{}` there.
	 */
	on_unrepresentable?: (message: string) => void;
}

/**
 * Convert a `@fuzdev/fuz_schema` schema to its JSON Schema for the surface
 * (`to_json_schema`), with `$schema` and `default` stripped at every depth.
 *
 * A value that is no schema throws first (`assert_validation_schema`),
 * naming `options.source`, so a slot that surface generation reads before
 * any registration does — a route's, an event's `params`, a `ws_endpoints`
 * action's — fails server assembly naming the slot, as registration refuses
 * a route's or action's slot, not as a JSON Schema the emitter could not
 * write.
 *
 * Returns `null` for a null schema (`is_null_schema`) and a void schema
 * (`is_void_schema`): no body, no params. Any other schema is written on the
 * side `options.io` names. A part JSON Schema can't say (a transform on the
 * output side, a `check`) is left out or written as `{}` (a
 * `pipe(string, check(…))` writes as `{type: 'string'}`), and
 * `options.on_unrepresentable` hears the emitter's message, so the surface
 * describes what it can and records the gap.
 *
 * It never answers `null` for a schema it failed to write, as that would
 * read as "takes no input" and drop the schema out of every suite reading the
 * surface: a schema with no JSON Schema form at all (`{}` where the schema
 * isn't `unknown`), and one the emitter refuses outright (an entry named like
 * a member of `Object.prototype`, metadata that isn't JSON), throw. So an
 * output whose root is a transform (`pipe(object(…), transform(…))`) throws,
 * and since `generate_app_surface` runs at server assembly, a route or action
 * declaring one fails the server at boot.
 *
 * @param schema - the schema to describe
 * @param options - the side to describe, the schema's name for errors, and a listener for gaps
 * @returns the JSON Schema, or `null` for a null or void schema
 * @throws Error naming `options.source` when the value is no schema, when the schema can't be written, or when nothing of it can
 */
export const schema_to_surface = (schema: AnySchema, options?: SchemaToSurfaceOptions): unknown => {
	assert_validation_schema(schema, options?.source ?? 'schema');
	if (is_null_schema(schema) || is_void_schema(schema)) return null;
	const io = options?.io ?? 'output';
	const write = (unrepresentable: 'throw' | 'any'): unknown =>
		strip_json_schema_noise(to_json_schema(schema, { io, unrepresentable }));
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
 * when schemas use function defaults (e.g. `with_default_fn(string, () => new Date().toISOString())`),
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
 * Check if a middleware layer carves a route path out: one of its
 * `carve_outs` applies to it (`middleware_applies`), whether or not its own
 * `path` does.
 *
 * @param spec - the layer's optional `carve_outs`
 * @param route_path - the route path to check
 */
export const middleware_carves_out = (
	spec: { readonly carve_outs?: ReadonlyArray<{ readonly path: string }> | null },
	route_path: string
): boolean =>
	(spec.carve_outs ?? []).some((carve_out) => middleware_applies(carve_out.path, route_path));

/**
 * Check if a middleware layer runs on a route path: its `path` pattern
 * applies (`middleware_applies`) and none of its `carve_outs` does
 * (`middleware_carves_out`).
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
): boolean => middleware_applies(spec.path, route_path) && !middleware_carves_out(spec, route_path);
