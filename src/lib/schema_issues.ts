/**
 * Validation issues from either schema library the stack's specs use: Zod
 * (`z.core.$ZodIssue`) and `@fuzdev/fuz_schema` (`SchemaIssue`). A schema is
 * wholly one library, so one parse's issues are all of one kind; these
 * helpers read either, so the dispatcher, `ActionEvent` and the
 * forward-compatible reads treat a spec the same whichever library it is
 * written in, and an error response carries either library's issues in one
 * shape, `WireIssue`.
 *
 * @module
 */

import { z } from 'zod';
import {
	array,
	format_issue,
	is_schema,
	loose_object,
	number,
	parse,
	SchemaError,
	string,
	union,
	type AnySchema,
	type Infer,
	type InferInput,
	type Schema,
	type SchemaIssue
} from '@fuzdev/fuz_schema/schema.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';

/** A schema of either library: a Zod schema or a `@fuzdev/fuz_schema` one. */
export type ValidationSchema = z.ZodType | AnySchema;

/**
 * Whether `value` is a Zod schema. Zod's `instanceof` reads the schema's
 * traits, so a schema made by another copy of Zod is one too.
 *
 * @param value - any value
 */
export const is_zod_schema = (value: unknown): value is z.ZodType => value instanceof z.ZodType;

/**
 * Throw unless `value` is a Zod schema, naming `label` — what a reader of a
 * spec's schema calls once it has ruled out a `@fuzdev/fuz_schema` schema
 * (`is_schema`), so a value of neither library fails loudly where it is read,
 * rather than as a `TypeError` deeper in or a silent `undefined`.
 *
 * @param value - the schema, known not to be a fuz_schema schema
 * @param label - names the schema in the error, e.g. `` `action 'foo' input` ``
 * @throws Error when `value` is not a Zod schema, saying it is of neither library
 */
export function assert_zod_schema(value: unknown, label: string): asserts value is z.ZodType {
	if (is_zod_schema(value)) return;
	throw new Error(`${label} is neither a Zod schema nor a @fuzdev/fuz_schema schema`);
}

/**
 * Throw unless `value` is a schema of either library (`is_schema` or
 * `is_zod_schema`), naming `label` — what spec registration runs on each
 * schema slot, so a value of neither library fails at registration rather
 * than at request time.
 *
 * @param value - the value a spec declares as a schema
 * @param label - names the spec and slot in the error, e.g. `` `RPC action "foo": input` ``
 * @throws Error when `value` is neither a Zod nor a fuz_schema schema
 */
export function assert_validation_schema(
	value: unknown,
	label: string
): asserts value is ValidationSchema {
	if (is_schema(value)) return;
	assert_zod_schema(value, label);
}

/**
 * The output type of a `ValidationSchema`: fuz_schema's `Infer` or Zod's
 * `z.output`. The test narrows `T` itself: `Infer<T & Schema>` would read as
 * `unknown`.
 */
export type ValidationOutput<T extends ValidationSchema> = T extends Schema
	? Infer<T>
	: T extends z.ZodType
		? z.output<T>
		: never;

/** The input type of a `ValidationSchema`: fuz_schema's `InferInput` or Zod's `z.input`. */
export type ValidationInput<T extends ValidationSchema> = T extends Schema
	? InferInput<T>
	: T extends z.ZodType
		? z.input<T>
		: never;

/** One issue of a failed parse, in the library's own shape. */
export type AnyIssue = z.core.$ZodIssue | SchemaIssue;

/** What `parse_any` returns: the output, or the failed parse's issues in the library's order. */
export type ParseAnyResult<T> = Result<{ value: T }, { issues: Array<AnyIssue> }>;

/**
 * Parse `value` with a schema of either library: `parse` for a fuz_schema
 * schema (`is_schema`), `safeParse` for a Zod one.
 *
 * A fuz_schema parse reports at most its first hundred issues, a Zod parse
 * every issue.
 *
 * @param schema - a Zod or fuz_schema schema
 * @param value - the value to validate
 * @returns the output, or the issues
 * @throws Error when `schema` is neither a Zod nor a fuz_schema schema
 */
export const parse_any = <T extends ValidationSchema>(
	schema: T,
	value: unknown
): ParseAnyResult<ValidationOutput<T>> => {
	if (is_schema(schema)) {
		const result = parse(schema, value);
		return result.ok
			? { ok: true, value: result.value as ValidationOutput<T> }
			: { ok: false, issues: result.issues };
	}
	assert_zod_schema(schema, 'parse_any: the schema');
	const result = schema.safeParse(value);
	return result.success
		? { ok: true, value: result.data as ValidationOutput<T> }
		: { ok: false, issues: result.error.issues };
};

/**
 * Whether `issue` is Zod's: every Zod issue has a `code`, a fuz_schema issue a `kind`.
 */
export const is_zod_issue = (issue: AnyIssue): issue is z.core.$ZodIssue => 'code' in issue;

/**
 * Whether `issue` sits on the input itself rather than on one of its fields:
 * a non-object input, or an unknown key on the input object — what the Rust
 * twin refuses before reading any field.
 *
 * Zod reports both at an empty path, its `unrecognized_keys` naming the keys.
 * fuz_schema reports a non-object at an empty path and each unknown key as an
 * `unknown_key` issue whose path ends at the key, so one on the input has a
 * path of the key alone. An unknown key on a nested object is on that field,
 * as Zod's is.
 *
 * On the wire the `unknown_key` rule changes no answer today: a root
 * `unknown_key` comes from a root `object`, which `resolve_issues_invalid_reason`
 * already answers with none from its check of the input's keys, or from a
 * schema such as a `variant` whose fields resolve no reason. It is kept as the
 * direct statement of Zod's rule.
 *
 * @param issue - one issue of a failed parse
 */
export const issue_is_on_input = (issue: AnyIssue): boolean =>
	issue.path.length === 0 ||
	(!is_zod_issue(issue) && issue.kind === 'unknown_key' && issue.path.length === 1);

/** Keys a parse refused as unknown, and the path of the object holding them. */
export interface UnknownKeyTarget {
	/** The path of the object the keys are on, `[]` for the input itself. */
	path: ReadonlyArray<PropertyKey>;
	/** The unknown keys. */
	keys: ReadonlyArray<PropertyKey>;
}

/**
 * The unknown keys among `issues`, each with the path of its object, or
 * `null` when any issue is something else.
 *
 * A Zod `unrecognized_keys` issue is at its object's path and names every
 * key; a fuz_schema `unknown_key` issue is one key, the last element of its
 * path.
 *
 * @param issues - a failed parse's issues
 * @returns a target per issue, or `null` when not every issue is an unknown key
 */
export const unknown_key_targets = (
	issues: ReadonlyArray<AnyIssue>
): Array<UnknownKeyTarget> | null => {
	const targets: Array<UnknownKeyTarget> = [];
	for (const issue of issues) {
		if (is_zod_issue(issue)) {
			if (issue.code !== 'unrecognized_keys') return null;
			targets.push({ path: issue.path, keys: issue.keys });
		} else {
			if (issue.kind !== 'unknown_key' || issue.path.length === 0) return null;
			targets.push({ path: issue.path.slice(0, -1), keys: [issue.path.at(-1)!] });
		}
	}
	return targets;
};

/**
 * A failed parse's issues as text: Zod's `z.prettifyError` text for Zod
 * issues, and for fuz_schema issues their `format_issue` lines.
 *
 * @param issues - a failed parse's issues, all of one library
 */
export const format_issues = (issues: ReadonlyArray<AnyIssue>): string => {
	const first = issues[0];
	if (!first) return '';
	if (is_zod_issue(first)) {
		return z.prettifyError({ issues: issues as ReadonlyArray<z.core.$ZodIssue> });
	}
	return (issues as ReadonlyArray<SchemaIssue>).map(format_issue).join('\n');
};

/**
 * Whether `err` is a thrown validation failure of either library: a
 * `z.ZodError` or a fuz_schema `SchemaError` (`parse_or_throw`). Both carry
 * the failed parse's `issues`.
 *
 * @param err - a caught value
 */
export const is_schema_validation_error = (err: unknown): err is z.ZodError | SchemaError =>
	err instanceof z.ZodError || err instanceof SchemaError;

/**
 * A `@fuzdev/fuz_schema` `loose_object`: a validation issue as an error
 * response carries it, for either schema library — fuz_schema's `SchemaIssue`
 * as JSON, with `message` the text of the issue. `to_wire_issues` builds it
 * from either library's issues.
 *
 * Loose: a client reads it, and a newer server may add fields.
 */
export const WireIssue = loose_object({
	/** The fuz_schema kind of the check that failed, or `unknown_key` / `missing_key`. */
	kind: string,
	/** Keys from the root value to the one that failed, outermost first. */
	path: array(union([string, number])),
	/** Describes what was expected, as fuz_schema writes it. */
	expected: string,
	/** The type of the value that failed: `'null'`, `'array'`, `'NaN'`, `'Infinity'`, `'-Infinity'`, or its `typeof`. */
	received: string,
	/** The issue as text: `format_issue` for a fuz_schema issue, Zod's own message for a Zod one. */
	message: string
});
export type WireIssue = Infer<typeof WireIssue>;

/**
 * A failed parse's issues as `WireIssue`s, whichever library made them.
 *
 * A fuz_schema issue keeps its `kind`, `path`, `expected` and `received`, and
 * its `message` is `format_issue`'s text, the path included.
 *
 * A Zod issue maps to the kind fuz_schema reports for the same check, its
 * `message` Zod's own text, which names no path:
 *
 * - `invalid_type` — the type's kind (`string`, `number`, `boolean`,
 *   `bigint`, `object`, `record`, `array`); `int` is `integer`, a `tuple` an
 *   `array`, `null`, `undefined`, `void` and `nan` a `literal` of the value,
 *   `nonoptional` a `missing_key`, and a type fuz_schema has no kind for
 *   (`date`, `map`, `set`, `file`, `symbol`, `function`, `never`) a `check`
 *   expecting the type's name. A missing key is reported as fuz_schema
 *   reports it, as the type expected with `received: 'undefined'`.
 * - `too_small` / `too_big` — `min_length` / `max_length` for a string,
 *   array, set or file (`length >= N`), `min_value` / `max_value` otherwise
 *   (`>= N`); an exclusive bound writes `>` or `<`, which fuz_schema has no
 *   check for, and an exact length is reported as the bound it broke.
 * - `invalid_format` — `uuid` for a `uuid` or `guid`, `iso_datetime` for a
 *   `datetime`, `regex` for a `regex` (expecting its pattern), and a `check`
 *   expecting the format's name for every other format.
 * - `unrecognized_keys` — an `unknown_key` per key, the key appended to the
 *   path, as fuz_schema reports them.
 * - `invalid_union` — a `variant` expecting the options when Zod names a
 *   discriminator, else a `union` expecting each option as fuz_schema names
 *   it: by the type or the values it expected of the value, or by the
 *   value's type when the option took the type and failed a refinement or a
 *   field below. A union refused because more than one option matched is a
 *   `union` expecting `exactly one option`.
 * - `invalid_value` — a `literal` of one value, a `one_of` of more.
 * - `custom` — a `check`; `not_multiple_of` a `check` expecting
 *   `multiple of N`; `invalid_key` and `invalid_element` a `check` expecting
 *   `a valid key` / `a valid element`.
 *
 * A Zod issue holds no value, so `received` is read from `input` at the
 * issue's path: `'undefined'` where a key is missing or the path leads
 * through something that isn't an object. Where an earlier step of a Zod
 * pipe replaced the value, it names the input's value, not the replacement.
 *
 * @param issues - a failed parse's issues, either library
 * @param input - the value that was parsed
 * @returns the issues, one per issue but for a Zod `unrecognized_keys`, which is one per key
 */
export const to_wire_issues = (
	issues: ReadonlyArray<AnyIssue>,
	input: unknown
): Array<WireIssue> => {
	const wire: Array<WireIssue> = [];
	for (const issue of issues) {
		if (is_zod_issue(issue)) {
			push_zod_wire_issues(wire, issue, input);
		} else {
			wire.push({
				kind: issue.kind,
				path: to_wire_path(issue.path),
				expected: issue.expected,
				received: issue.received,
				message: format_issue(issue)
			});
		}
	}
	return wire;
};

// a symbol key has no JSON form, so it goes as its text
const to_wire_path = (path: ReadonlyArray<PropertyKey>): Array<string | number> =>
	path.map((key) => (typeof key === 'symbol' ? key.toString() : key));

// the type of a value as fuz_schema's `received` names it
const to_received = (value: unknown): string =>
	value === null
		? 'null'
		: Array.isArray(value)
			? 'array'
			: typeof value === 'number' && !Number.isFinite(value)
				? String(value)
				: typeof value;

// the value at `path` of `value`, by own keys, `undefined` where a key is
// missing or the path leads through something that isn't an object
const get_at = (value: unknown, path: ReadonlyArray<PropertyKey>): unknown => {
	let at = value;
	for (const key of path) {
		if (at === null || typeof at !== 'object') return undefined;
		at = Object.hasOwn(at, key) ? (at as Record<PropertyKey, unknown>)[key] : undefined;
	}
	return at;
};

// literals as fuz_schema's `expected` writes them, strings quoted
const format_literals = (values: ReadonlyArray<unknown>): string =>
	values.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))).join(' | ');

// fuz_schema's kind and `expected` for a Zod `invalid_type` issue's `expected`,
// where they differ from the type's own name
const ZOD_TYPE_KINDS: Readonly<Record<string, { kind: string; expected: string }>> = {
	string: { kind: 'string', expected: 'string' },
	number: { kind: 'number', expected: 'number' },
	boolean: { kind: 'boolean', expected: 'boolean' },
	bigint: { kind: 'bigint', expected: 'bigint' },
	int: { kind: 'integer', expected: 'integer' },
	object: { kind: 'object', expected: 'object' },
	record: { kind: 'record', expected: 'object' },
	array: { kind: 'array', expected: 'array' },
	tuple: { kind: 'array', expected: 'array' },
	null: { kind: 'literal', expected: 'null' },
	undefined: { kind: 'literal', expected: 'undefined' },
	void: { kind: 'literal', expected: 'undefined' },
	nan: { kind: 'literal', expected: 'NaN' },
	nonoptional: { kind: 'missing_key', expected: 'a required key' }
};

// a Zod length origin, whose bounds fuz_schema checks as `min_length` / `max_length`
const ZOD_LENGTH_ORIGINS: ReadonlySet<string> = new Set(['string', 'array', 'set', 'file']);

// fuz_schema's kind for a Zod `invalid_format` format, a `check` when absent
const ZOD_FORMAT_KINDS: Readonly<Record<string, string>> = {
	uuid: 'uuid',
	guid: 'uuid',
	datetime: 'iso_datetime',
	regex: 'regex'
};

// pushes the wire form of a Zod issue
const push_zod_wire_issues = (
	wire: Array<WireIssue>,
	issue: z.core.$ZodIssue,
	input: unknown
): void => {
	const { path } = issue;
	if (issue.code === 'unrecognized_keys') {
		// the object holding the keys, read once so the cost is linear in keys
		const holder = get_at(input, path);
		for (const key of issue.keys) {
			wire.push({
				kind: 'unknown_key',
				path: to_wire_path([...path, key]),
				expected: 'no unknown keys',
				received: to_received(get_at(holder, [key])),
				// Zod's text names every key, so a key of several gets the one-key form
				message:
					issue.keys.length === 1 ? issue.message : `Unrecognized key: ${JSON.stringify(key)}`
			});
		}
		return;
	}
	const { kind, expected } = to_zod_kind(issue, input, path);
	wire.push({
		kind,
		path: to_wire_path(path),
		expected,
		received: to_received(get_at(input, path)),
		message: issue.message
	});
};

// fuz_schema's kind and `expected` for a Zod issue other than `unrecognized_keys`
const to_zod_kind = (
	issue: Exclude<z.core.$ZodIssue, z.core.$ZodIssueUnrecognizedKeys>,
	input: unknown,
	path: ReadonlyArray<PropertyKey>
): { kind: string; expected: string } => {
	switch (issue.code) {
		case 'invalid_type':
			return ZOD_TYPE_KINDS[issue.expected] ?? { kind: 'check', expected: issue.expected };
		case 'too_small': {
			const op = issue.inclusive === false ? '>' : '>=';
			return ZOD_LENGTH_ORIGINS.has(issue.origin)
				? { kind: 'min_length', expected: `length ${op} ${issue.minimum}` }
				: { kind: 'min_value', expected: `${op} ${issue.minimum}` };
		}
		case 'too_big': {
			const op = issue.inclusive === false ? '<' : '<=';
			return ZOD_LENGTH_ORIGINS.has(issue.origin)
				? { kind: 'max_length', expected: `length ${op} ${issue.maximum}` }
				: { kind: 'max_value', expected: `${op} ${issue.maximum}` };
		}
		case 'invalid_format': {
			const kind = ZOD_FORMAT_KINDS[issue.format];
			if (kind === undefined) return { kind: 'check', expected: issue.format };
			return {
				kind,
				expected: kind === 'regex' ? (issue.pattern ?? 'regex') : kind
			};
		}
		case 'not_multiple_of':
			return { kind: 'check', expected: `multiple of ${issue.divisor}` };
		case 'invalid_union':
			if (issue.inclusive === false) return { kind: 'union', expected: 'exactly one option' };
			if (issue.discriminator !== undefined && issue.options) {
				return { kind: 'variant', expected: format_literals(issue.options) };
			}
			return {
				kind: 'union',
				expected: [...new Set(describe_union_options(issue, input, path))].join(' | ')
			};
		case 'invalid_key':
			return { kind: 'check', expected: 'a valid key' };
		case 'invalid_element':
			return { kind: 'check', expected: 'a valid element' };
		case 'invalid_value':
			return {
				kind: issue.values.length === 1 ? 'literal' : 'one_of',
				expected: format_literals(issue.values)
			};
		case 'custom':
			return { kind: 'check', expected: 'check' };
		default: {
			// a code a newer Zod added fails to compile here; at runtime it is a `check`
			const unmapped: never = issue;
			return { kind: 'check', expected: (unmapped as { code: string }).code };
		}
	}
};

// each option of a failed Zod union as fuz_schema's `expected` names it: by
// the type or the values its issue on the value itself expected, a union's
// own options in its place (a discriminated one is an object), and else by
// the value's type, which the option matched: a refinement failed, or an
// issue below the value, as an object or array option's (an option's issues
// are relative to the union)
const describe_union_options = (
	issue: z.core.$ZodIssueInvalidUnion,
	input: unknown,
	path: ReadonlyArray<PropertyKey>
): Array<string> =>
	issue.errors.flatMap((option_issues) => {
		if (!option_issues.length) return [];
		const on_value = option_issues.find((i) => i.path.length === 0);
		if (on_value?.code === 'invalid_union' && on_value.inclusive !== false) {
			return on_value.discriminator === undefined
				? describe_union_options(on_value, input, path)
				: ['object'];
		}
		if (
			(on_value?.code === 'invalid_type' && on_value.expected !== 'int') ||
			on_value?.code === 'invalid_value'
		) {
			return [to_zod_kind(on_value, input, path).expected];
		}
		return [to_received(get_at(input, path))];
	});
