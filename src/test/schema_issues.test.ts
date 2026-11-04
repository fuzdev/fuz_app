/**
 * Tests for `schema_issues.ts` — parsing with either schema library and
 * reading the issues of either alike.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';
import { format_issue, number, object, parse_or_throw, string } from '@fuzdev/fuz_schema/schema.ts';

import {
	format_issues,
	is_schema_validation_error,
	issue_is_on_input,
	parse_any,
	unknown_key_targets,
	type AnyIssue
} from '#lib/schema_issues.ts';

const ZodInput = z.strictObject({ a: z.number(), inner: z.strictObject({ b: z.string() }) });
const FuzInput = object({ a: number, inner: object({ b: string }) });

const issues_of = (schema: typeof ZodInput | typeof FuzInput, value: unknown): Array<AnyIssue> => {
	const result = parse_any(schema, value);
	assert.ok(!result.ok, `refused: ${JSON.stringify(value)}`);
	return result.issues;
};

describe('parse_any', () => {
	test('returns the output of either library', () => {
		const value = { a: 1, inner: { b: 'b' } };
		for (const schema of [ZodInput, FuzInput]) {
			const result = parse_any(schema, value);
			assert.ok(result.ok);
			assert.deepStrictEqual(result.value, value);
		}
	});

	test("returns the library's own issues", () => {
		const [zod_issue] = issues_of(ZodInput, { a: 'x', inner: { b: 'b' } });
		assert.ok(zod_issue && 'code' in zod_issue);
		assert.strictEqual(zod_issue.code, 'invalid_type');
		const [fuz_issue] = issues_of(FuzInput, { a: 'x', inner: { b: 'b' } });
		assert.ok(fuz_issue && 'kind' in fuz_issue);
		assert.strictEqual(fuz_issue.kind, 'number');
	});
});

describe('issue_is_on_input', () => {
	test('an unknown key on the input is on the input in either library', () => {
		for (const schema of [ZodInput, FuzInput]) {
			const issues = issues_of(schema, { a: 1, inner: { b: 'b' }, extra: 1 });
			assert.strictEqual(issues.length, 1);
			assert.ok(issue_is_on_input(issues[0]!));
		}
	});

	test('a non-object input is on the input in either library', () => {
		for (const schema of [ZodInput, FuzInput]) {
			assert.ok(issues_of(schema, [1]).every(issue_is_on_input));
		}
	});

	test('a field fault and a nested unknown key are on their field', () => {
		for (const schema of [ZodInput, FuzInput]) {
			for (const value of [
				{ a: 'x', inner: { b: 'b' } },
				{ a: 1, inner: { b: 'b', extra: 1 } }
			]) {
				const issues = issues_of(schema, value);
				assert.ok(!issues.some(issue_is_on_input), JSON.stringify(value));
			}
		}
	});
});

describe('unknown_key_targets', () => {
	test('names each unknown key with the path of its object', () => {
		const value = { a: 1, x: 1, inner: { b: 'b', y: 1 } };
		assert.deepStrictEqual(unknown_key_targets(issues_of(ZodInput, value)), [
			{ path: ['inner'], keys: ['y'] },
			{ path: [], keys: ['x'] }
		]);
		assert.deepStrictEqual(unknown_key_targets(issues_of(FuzInput, value)), [
			{ path: ['inner'], keys: ['y'] },
			{ path: [], keys: ['x'] }
		]);
	});

	test('answers null when any issue is something else', () => {
		const value = { a: 'x', extra: 1, inner: { b: 'b' } };
		assert.isNull(unknown_key_targets(issues_of(ZodInput, value)));
		assert.isNull(unknown_key_targets(issues_of(FuzInput, value)));
	});
});

describe('format_issues', () => {
	test('writes Zod issues as `z.prettifyError` writes them', () => {
		const result = ZodInput.safeParse({ a: 'x', inner: {} });
		assert.ok(!result.success);
		assert.strictEqual(format_issues(result.error.issues), z.prettifyError(result.error));
	});

	test('writes fuz_schema issues a `format_issue` line each', () => {
		const issues = issues_of(FuzInput, { a: 'x', inner: {} });
		assert.strictEqual(issues.length, 2);
		assert.strictEqual(
			format_issues(issues),
			issues.map((issue) => format_issue(issue as Parameters<typeof format_issue>[0])).join('\n')
		);
	});

	test('writes no issues as empty text', () => {
		assert.strictEqual(format_issues([]), '');
	});
});

describe('is_schema_validation_error', () => {
	test("is true for either library's thrown error and false otherwise", () => {
		const thrown = (fn: () => unknown): unknown => {
			try {
				fn();
			} catch (err) {
				return err;
			}
			assert.fail('expected a throw');
		};
		assert.ok(is_schema_validation_error(thrown(() => ZodInput.parse({}))));
		assert.ok(is_schema_validation_error(thrown(() => parse_or_throw(FuzInput, {}))));
		assert.isFalse(is_schema_validation_error(new Error('x')));
		assert.isFalse(is_schema_validation_error({ issues: [] }));
	});
});
