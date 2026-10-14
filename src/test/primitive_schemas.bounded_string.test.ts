/**
 * Tests for `bounded_string` — the UTF-16 code unit length bound every
 * length-capped wire string schema in the package is built on.
 *
 * The cases that tell the two counts apart are the astral ones: a string over
 * the cap in code units but at or under it in code points must be refused,
 * and one at the floor in code units but under it in code points must be
 * admitted, whichever of the two the installed Zod counts. On a Zod that
 * counts code units its own `.min()` / `.max()` already agree, so the
 * `against a code point count` cases run the bound's check directly on the
 * issues a code point count would have raised.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import { bounded_string } from '#lib/primitive_schemas.ts';

/** U+1F600 — one code point, two UTF-16 code units. */
const ASTRAL = '\u{1F600}';

const MIN = 4;
const MAX = 8;

/** Over `MAX` in code units, under it in code points. */
const ASTRAL_OVER = ASTRAL.repeat(MAX / 2 + 1);
/** At `MIN` in code units, under it in code points. */
const ASTRAL_AT_MIN = ASTRAL.repeat(MIN / 2);

/** The issues of a failed parse, serialized — the form a DEV error body carries. */
const issues_json = (schema: z.ZodType, value: unknown): string => {
	const parsed = schema.safeParse(value);
	assert.ok(!parsed.success);
	return JSON.stringify(parsed.error.issues);
};

/** The issues of a failed parse, as plain data. */
const issues_of = (schema: z.ZodType, value: unknown): Array<{ code: string; message: string }> =>
	JSON.parse(issues_json(schema, value));

/**
 * Runs the bound's own check — the last check `bounded_string` adds — on a
 * hand-built payload, standing in for a Zod that counts code points whichever
 * Zod is installed: `zod_issues` is what such a Zod's `.min()` / `.max()`
 * would have raised before the check ran. Reaching the check means going
 * through Zod's internal `_zod` surface; it is confined to this helper.
 */
const run_bound_check = (
	schema: z.ZodString,
	value: string,
	zod_issues: Array<z.core.$ZodRawIssue>
): Array<z.core.$ZodRawIssue> => {
	const check = schema._zod.def.checks?.at(-1);
	assert.ok(check);
	// the bound's own check, not one of Zod's length checks before it
	assert.strictEqual(check._zod.def.check, 'custom');
	const payload: z.core.ParsePayload<string> = { value, issues: [...zod_issues] };
	void check._zod.check(payload);
	return payload.issues;
};

describe('bounded_string max', () => {
	const schema = bounded_string({ max: MAX });

	test('ASCII at the cap passes, one past is refused', () => {
		assert.ok(schema.safeParse('a'.repeat(MAX)).success);
		assert.ok(schema.safeParse('').success);
		assert.ok(!schema.safeParse('a'.repeat(MAX + 1)).success);
	});

	test('an astral string exactly at the cap in code units passes', () => {
		const at_max = ASTRAL.repeat(MAX / 2);
		assert.strictEqual(at_max.length, MAX);
		assert.ok(schema.safeParse(at_max).success);
	});

	test('an astral string one code unit past the cap is refused', () => {
		const over = ASTRAL.repeat(MAX / 2) + 'a';
		assert.strictEqual(over.length, MAX + 1);
		assert.ok(!schema.safeParse(over).success);
	});

	test('over the cap in code units but under it in code points is refused', () => {
		assert.strictEqual(ASTRAL_OVER.length, MAX + 2);
		assert.ok(Array.from(ASTRAL_OVER).length < MAX, 'under the cap in code points');
		assert.ok(!schema.safeParse(ASTRAL_OVER).success);
	});

	test('an astral refusal carries the same single issue as an ASCII one', () => {
		const ascii = issues_json(schema, 'a'.repeat(MAX + 2));
		assert.strictEqual(issues_of(schema, 'a'.repeat(MAX + 2)).length, 1);
		// compared serialized, so key order counts too — the issues go into DEV error bodies
		assert.strictEqual(issues_json(schema, ASTRAL_OVER), ascii);
		// and both are what a plain `.max()` reports for the ASCII string
		assert.strictEqual(ascii, issues_json(z.string().max(MAX), 'a'.repeat(MAX + 2)));
	});

	test('max_message replaces the message on both refusals, key order included', () => {
		const with_message = bounded_string({ max: MAX, max_message: 'too long' });
		const ascii = issues_json(with_message, 'a'.repeat(MAX + 2));
		assert.strictEqual(issues_json(with_message, ASTRAL_OVER), ascii);
		assert.strictEqual(ascii, issues_json(z.string().max(MAX, 'too long'), 'a'.repeat(MAX + 2)));
		assert.strictEqual(issues_of(with_message, ASTRAL_OVER)[0]!.message, 'too long');
	});

	test('a non-string is refused with the type issue alone', () => {
		assert.strictEqual(issues_json(schema, 123), issues_json(z.string(), 123));
	});
});

describe('bounded_string min', () => {
	const schema = bounded_string({ min: MIN, max: MAX });

	test('ASCII at the floor passes, one under is refused', () => {
		assert.ok(schema.safeParse('a'.repeat(MIN)).success);
		assert.ok(!schema.safeParse('a'.repeat(MIN - 1)).success);
	});

	test('at the floor in code units but under it in code points passes', () => {
		assert.strictEqual(ASTRAL_AT_MIN.length, MIN);
		assert.ok(Array.from(ASTRAL_AT_MIN).length < MIN, 'under the floor in code points');
		assert.ok(schema.safeParse(ASTRAL_AT_MIN).success);
	});

	test('an astral string under the floor in code units is refused', () => {
		assert.ok(!schema.safeParse(ASTRAL).success);
	});

	test('a short refusal carries the single issue a plain `.min()` reports', () => {
		assert.strictEqual(issues_of(schema, 'a').length, 1);
		assert.strictEqual(issues_json(schema, 'a'), issues_json(z.string().min(MIN), 'a'));
	});

	test('`min: 1` refuses only the empty string', () => {
		const non_empty = bounded_string({ min: 1, max: MAX });
		assert.ok(!non_empty.safeParse('').success);
		assert.ok(non_empty.safeParse('a').success);
		assert.ok(non_empty.safeParse(ASTRAL).success);
	});
});

describe('bounded_string against a code point count', () => {
	const schema = bounded_string({ min: MIN, max: MAX });

	test('adds the over-max issue a code point count did not raise', () => {
		const issues = run_bound_check(schema, ASTRAL_OVER, []);
		assert.strictEqual(issues.length, 1);
		assert.deepInclude(issues[0], {
			origin: 'string',
			code: 'too_big',
			maximum: MAX,
			inclusive: true,
			continue: true
		});
	});

	test('a max_message issue it adds puts path ahead of message, as Zod finalizes its own', () => {
		const with_message = bounded_string({ max: MAX, max_message: 'too long' });
		const issues = run_bound_check(with_message, ASTRAL_OVER, []);
		assert.strictEqual(issues.length, 1);
		const issue = issues[0]!;
		assert.deepInclude(issue, { path: [], message: 'too long', continue: true });
		const keys = Object.keys(issue);
		assert.ok(keys.indexOf('path') < keys.indexOf('message'));
	});

	test('adds the under-min issue when none was raised', () => {
		const issues = run_bound_check(schema, 'a', []);
		assert.strictEqual(issues.length, 1);
		assert.deepInclude(issues[0], {
			origin: 'string',
			code: 'too_small',
			minimum: MIN,
			inclusive: true,
			continue: true
		});
	});

	test('withdraws the under-min issue a code point count raised', () => {
		const raised: z.core.$ZodRawIssue = {
			origin: 'string',
			code: 'too_small',
			minimum: MIN,
			inclusive: true,
			input: ASTRAL_AT_MIN,
			continue: true
		};
		assert.deepEqual(run_bound_check(schema, ASTRAL_AT_MIN, [raised]), []);
	});

	test('leaves the issue a code unit count raised, adding none', () => {
		const raised: z.core.$ZodRawIssue = {
			origin: 'string',
			code: 'too_big',
			maximum: MAX,
			inclusive: true,
			input: ASTRAL_OVER,
			continue: true
		};
		assert.deepEqual(run_bound_check(schema, ASTRAL_OVER, [raised]), [raised]);
	});

	test('leaves an issue it does not own', () => {
		const other: z.core.$ZodRawIssue = {
			origin: 'string',
			code: 'too_small',
			minimum: MIN + 1,
			inclusive: true,
			input: ASTRAL_AT_MIN,
			continue: true
		};
		assert.deepEqual(run_bound_check(schema, ASTRAL_AT_MIN, [other]), [other]);
	});
});

describe('bounded_string chained', () => {
	test('a format check after the bound still reports on an over-cap astral string', () => {
		const schema = bounded_string({ max: MAX }).regex(/^[a-z]+$/);
		assert.ok(schema.safeParse('abc').success);
		const codes = (value: string): Array<string> => issues_of(schema, value).map((i) => i.code);
		assert.deepEqual(codes('A'.repeat(MAX + 2)), ['too_big', 'invalid_format']);
		assert.deepEqual(codes(ASTRAL_OVER), ['too_big', 'invalid_format']);
	});

	test('a transform after the bound runs on a string at the floor in code units', () => {
		const schema = bounded_string({ min: MIN, max: MAX }).transform((s) => s.length);
		assert.strictEqual(schema.parse(ASTRAL_AT_MIN), MIN);
	});

	test('a refinement after the bound runs on a string at the floor in code units', () => {
		const seen: Array<string> = [];
		const schema = bounded_string({ min: MIN, max: MAX }).refine((s) => {
			seen.push(s);
			return true;
		});
		assert.ok(schema.safeParse(ASTRAL_AT_MIN).success);
		assert.deepEqual(seen, [ASTRAL_AT_MIN]);
	});

	test('the verdict holds through object, optional, nullish, default, brand, array and union wrappers', () => {
		const bounded = (): z.ZodString => bounded_string({ min: MIN, max: MAX });
		const wrapped: Array<[z.ZodType, (value: string) => unknown]> = [
			[z.strictObject({ a: bounded() }), (a) => ({ a })],
			[z.strictObject({ a: bounded().optional() }), (a) => ({ a })],
			[z.strictObject({ a: bounded().nullish() }), (a) => ({ a })],
			[z.strictObject({ a: bounded().default('abcd') }), (a) => ({ a })],
			[bounded().brand('Bounded'), (a) => a],
			[z.array(bounded()), (a) => ['abcd', a]],
			[z.union([z.number(), bounded()]), (a) => a]
		];
		for (const [schema, wrap] of wrapped) {
			assert.ok(schema.safeParse(wrap(ASTRAL_AT_MIN)).success);
			assert.ok(!schema.safeParse(wrap(ASTRAL_OVER)).success);
		}
	});

	test('the async parse path reaches the same verdict', async () => {
		const schema = z.strictObject({ a: bounded_string({ min: MIN, max: MAX }) });
		assert.ok((await schema.safeParseAsync({ a: ASTRAL_AT_MIN })).success);
		assert.ok(!(await schema.safeParseAsync({ a: ASTRAL_OVER })).success);
	});

	test('a nested refusal carries the field path', () => {
		const schema = z.strictObject({ a: bounded_string({ max: MAX }) });
		const ascii = issues_json(schema, { a: 'a'.repeat(MAX + 2) });
		assert.strictEqual(issues_json(schema, { a: ASTRAL_OVER }), ascii);
		assert.deepEqual(JSON.parse(ascii)[0].path, ['a']);
	});

	test('a nested max_message refusal carries the field path, key order included', () => {
		const schema = z.strictObject({
			a: z.strictObject({ b: bounded_string({ max: MAX, max_message: 'too long' }) })
		});
		const ascii = issues_json(schema, { a: { b: 'a'.repeat(MAX + 2) } });
		assert.strictEqual(issues_json(schema, { a: { b: ASTRAL_OVER } }), ascii);
		assert.deepEqual(JSON.parse(ascii)[0].path, ['a', 'b']);
		assert.strictEqual(
			ascii,
			issues_json(z.strictObject({ a: z.strictObject({ b: z.string().max(MAX, 'too long') }) }), {
				a: { b: 'a'.repeat(MAX + 2) }
			})
		);
	});
});

describe('bounded_string schema', () => {
	test('the JSON Schema carries the bounds as `.min()` / `.max()` would', () => {
		assert.deepEqual(
			z.toJSONSchema(bounded_string({ min: 2, max: MAX })),
			z.toJSONSchema(z.string().min(2).max(MAX))
		);
		assert.deepEqual(
			z.toJSONSchema(bounded_string({ max: MAX })),
			z.toJSONSchema(z.string().max(MAX))
		);
	});
});
