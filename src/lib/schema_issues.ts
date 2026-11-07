/**
 * Validation issues of a `@fuzdev/fuz_schema` parse (`SchemaIssue`) as the
 * stack reads them: on the input or on a field, unknown keys, text, and the
 * one shape every error response carries them in, `WireIssue`.
 *
 * @module
 */

import {
	array,
	format_issue,
	is_schema,
	loose_object,
	number,
	SchemaError,
	string,
	union,
	type AnySchema,
	type Infer,
	type SchemaIssue
} from '@fuzdev/fuz_schema/schema.ts';

/**
 * Throw unless `value` is a `@fuzdev/fuz_schema` schema (`is_schema`), naming
 * `label` — what spec registration runs on each schema slot, so a value that
 * is no schema fails at registration rather than at request time.
 *
 * @param value - the value a spec declares as a schema
 * @param label - names the spec and slot in the error, e.g. `` `RPC action "foo": input` ``
 * @throws Error when `value` is not a fuz_schema schema
 */
export function assert_validation_schema(
	value: unknown,
	label: string
): asserts value is AnySchema {
	if (is_schema(value)) return;
	throw new Error(`${label} is not a @fuzdev/fuz_schema schema`);
}

/**
 * Whether `issue` sits on the input itself rather than on one of its fields:
 * a non-object input, or an unknown key on the input object — what the Rust
 * twin refuses before reading any field.
 *
 * A non-object is reported at an empty path, and each unknown key as an
 * `unknown_key` issue whose path ends at the key, so one on the input has a
 * path of the key alone. An unknown key on a nested object is on that field.
 *
 * On the wire the `unknown_key` rule changes no answer today: a root
 * `unknown_key` comes from a root `object`, which `resolve_issues_invalid_reason`
 * already answers with none from its check of the input's keys, or from a
 * schema such as a `variant` whose fields resolve no reason. It is kept as the
 * direct statement of the rule.
 *
 * @param issue - one issue of a failed parse
 */
export const issue_is_on_input = (issue: SchemaIssue): boolean =>
	issue.path.length === 0 || (issue.kind === 'unknown_key' && issue.path.length === 1);

/** Keys a parse refused as unknown, and the path of the object holding them. */
export interface UnknownKeyTarget {
	/** The path of the object the keys are on, `[]` for the input itself. */
	path: ReadonlyArray<PropertyKey>;
	/** The unknown keys. */
	keys: ReadonlyArray<PropertyKey>;
}

/**
 * The unknown keys among `issues`, each with the path of its object, or
 * `null` when any issue is something else. An `unknown_key` issue is one
 * key, the last element of its path.
 *
 * @param issues - a failed parse's issues
 * @returns a target per issue, or `null` when not every issue is an unknown key
 */
export const unknown_key_targets = (
	issues: ReadonlyArray<SchemaIssue>
): Array<UnknownKeyTarget> | null => {
	const targets: Array<UnknownKeyTarget> = [];
	for (const issue of issues) {
		if (issue.kind !== 'unknown_key' || issue.path.length === 0) return null;
		targets.push({ path: issue.path.slice(0, -1), keys: [issue.path.at(-1)!] });
	}
	return targets;
};

/**
 * A failed parse's issues as text, a `format_issue` line each.
 *
 * @param issues - a failed parse's issues
 */
export const format_issues = (issues: ReadonlyArray<SchemaIssue>): string =>
	issues.map(format_issue).join('\n');

/**
 * Whether `err` is a thrown validation failure, a `SchemaError`
 * (`parse_or_throw`), which carries the failed parse's `issues`.
 *
 * @param err - a caught value
 */
export const is_schema_validation_error = (err: unknown): err is SchemaError =>
	err instanceof SchemaError;

/**
 * A `@fuzdev/fuz_schema` `loose_object`: a validation issue as an error
 * response carries it — `SchemaIssue` as JSON, with `message` the text of the
 * issue. `to_wire_issues` builds it.
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
	/** The issue as text, `format_issue`'s. */
	message: string
});
export type WireIssue = Infer<typeof WireIssue>;

/**
 * A failed parse's issues as `WireIssue`s: each keeps its `kind`, `path`,
 * `expected` and `received`, and its `message` is `format_issue`'s text, the
 * path included. A symbol key in a path goes as its text.
 *
 * @param issues - a failed parse's issues
 * @returns one per issue
 */
export const to_wire_issues = (issues: ReadonlyArray<SchemaIssue>): Array<WireIssue> =>
	issues.map((issue) => ({
		kind: issue.kind,
		path: issue.path.map((key) => (typeof key === 'symbol' ? key.toString() : key)),
		expected: issue.expected,
		received: issue.received,
		message: format_issue(issue)
	}));
