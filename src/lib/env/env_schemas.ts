/**
 * `@fuzdev/fuz_schema` schemas for env var values, matching the Rust spine's
 * readers of the same vars.
 *
 * An env value is a string, so these take a string and output the value it
 * spells: `env_integer` for whole numbers, `EnvStringbool` for booleans.
 *
 * @module
 */

import {
	check,
	max_value,
	min_value,
	pipe,
	regex,
	safe_integer,
	string,
	transform,
	type PipeSchema
} from '@fuzdev/fuz_schema/schema.ts';

// declares `sensitivity` on fuz_schema's `SchemaMeta`, for consumers marking env fields
import '../sensitivity.ts';

/** Options of `env_integer`. */
export interface EnvIntegerOptions {
	/** The least value accepted, default `0`. */
	min?: number;
	/** The greatest value accepted, default `Number.MAX_SAFE_INTEGER`. */
	max?: number;
}

// Unicode `White_Space`, the set Rust's `str::trim` strips (`char::is_whitespace`);
// `String.prototype.trim` differs, stripping U+FEFF and keeping U+0085
const WHITE_SPACE_EDGES =
	/^[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/g;

// the trimmed value as a number, when it is decimal digits after at most one `+`
const EnvDigits = pipe(
	string,
	transform((v: string) => v.replace(WHITE_SPACE_EDGES, '')),
	regex(/^\+?\d+$/, 'decimal digits'),
	transform(Number)
);

/**
 * A whole number spelled in decimal digits, read the way the Rust spine reads
 * one (`value.trim().parse::<u64>()`): trimmed of Unicode `White_Space` (the
 * set Rust's `trim` strips, not `String.prototype.trim`'s), then decimal
 * digits after at most one leading `+`, so a blank value, a `-`, a fraction,
 * an exponent (`5e3`), and hex (`0x1F90`) are refused, and `+80` and leading
 * zeros (`00080`) are not. The number must be a safe integer within `min` and
 * `max`.
 *
 * @param options - the bounds, default `0` to `Number.MAX_SAFE_INTEGER`
 */
export const env_integer = (options?: EnvIntegerOptions): PipeSchema<number, typeof string> =>
	pipe(
		EnvDigits,
		safe_integer,
		min_value(options?.min ?? 0),
		max_value(options?.max ?? Number.MAX_SAFE_INTEGER)
	);

// the recognized spellings, lowercase, as Zod's `z.stringbool()` defaults and
// the Rust spine's `parse_stringbool` have them
const STRINGBOOL_VALUES: ReadonlyMap<string, boolean> = new Map([
	['true', true],
	['1', true],
	['yes', true],
	['on', true],
	['y', true],
	['enabled', true],
	['false', false],
	['0', false],
	['no', false],
	['off', false],
	['n', false],
	['disabled', false]
]);

/**
 * A boolean spelled as a word, matched case-insensitively and not trimmed:
 * `true`, `1`, `yes`, `on`, `y`, or `enabled` for `true`, and `false`, `0`,
 * `no`, `off`, `n`, or `disabled` for `false`. Anything else is refused,
 * `''` and `' true'` included, so a typo doesn't silently flip a feature.
 *
 * The set and the case rule of Zod's `z.stringbool()` defaults, and the twin
 * of the Rust spine's `parse_stringbool`.
 */
export const EnvStringbool: PipeSchema<boolean, typeof string> = pipe(
	string,
	check(
		(v: string) => STRINGBOOL_VALUES.has(v.toLowerCase()),
		'true|1|yes|on|y|enabled or false|0|no|off|n|disabled'
	),
	transform((v: string) => STRINGBOOL_VALUES.get(v.toLowerCase())!)
);
