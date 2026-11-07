/**
 * `AuditEventTypeName` and `AuditOutcome` (`auth/audit_log_schema.ts`), on one
 * corpus each: each row's expected answer was frozen from the Zod copy of the
 * schema it replaced (`ZOD_EVENT_TYPE_ANSWERS`, `ZOD_OUTCOME_ANSWERS`, in
 * corpus order): the same verdict, the same output, and the same wire issues,
 * the message as the custom length or pattern message where Zod's was one.
 * Two differences are declared for `AuditEventTypeName`: a string both too
 * long and off the grammar gets the length issue alone, where Zod added the
 * grammar issue after it, and a value that is no string gets fuz_schema's
 * message.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is_schema, parse } from '@fuzdev/fuz_schema/schema.ts';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';

import {
	AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_REGEX,
	AUDIT_EVENT_TYPES,
	type AuditEventType,
	AuditEventTypeName,
	AuditOutcome
} from '#lib/auth/audit_log_schema.ts';
import { to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

/** Names of the grammar and around it, and values that are no string. */
const EVENT_TYPE_CORPUS: Array<unknown> = [
	'login',
	'role_grant_create',
	'a',
	'A',
	'app.thing/created-v2',
	'a.b',
	'a/b',
	'a-b',
	'a_',
	'a'.repeat(NAME_LENGTH_MAX),
	'a'.repeat(NAME_LENGTH_MAX + 1),
	'1'.repeat(NAME_LENGTH_MAX + 1),
	'_'.repeat(NAME_LENGTH_MAX + 1),
	'',
	'1login',
	'_login',
	'.login',
	'log in',
	'login\n',
	'lögin',
	'\u{1d41a}',
	null,
	undefined,
	1,
	true,
	['login'],
	{}
];

const OUTCOME_CORPUS: Array<unknown> = [
	'success',
	'failure',
	'Success',
	'',
	'maybe',
	' success',
	null,
	undefined,
	0,
	['success']
];

/** What a parse gave: its output, or its wire issues. */
const outcome_of = (
	schema: Parameters<typeof parse>[0],
	input: unknown
): { ok: true; value: unknown } | { ok: false; issues: Array<WireIssue> } => {
	const result = parse(schema, input);
	return result.ok
		? { ok: true, value: result.value }
		: { ok: false, issues: to_wire_issues(result.issues, input) };
};

/** A refusal's issues as `[kind, expected, received, message]`, the message as `'L'` (the length message), `'P'` (the pattern message) or `''` (the library's default); `'accepted'` otherwise. */
type Answer =
	'accepted' | Array<[kind: string, expected: string, received: string, message: 'L' | 'P' | '']>;

const ZOD_EVENT_TYPE_ANSWERS: Array<Answer> = [
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	[['max_length', 'length <= 64', 'string', 'L']],
	[
		['max_length', 'length <= 64', 'string', 'L'],
		['regex', '/^[A-Za-z][A-Za-z0-9_./-]*$/', 'string', 'P']
	],
	[
		['max_length', 'length <= 64', 'string', 'L'],
		['regex', '/^[A-Za-z][A-Za-z0-9_./-]*$/', 'string', 'P']
	],
	[['regex', '/^[A-Za-z][A-Za-z0-9_./-]*$/', 'string', 'P']],
	[['regex', '/^[A-Za-z][A-Za-z0-9_./-]*$/', 'string', 'P']],
	[['regex', '/^[A-Za-z][A-Za-z0-9_./-]*$/', 'string', 'P']],
	[['regex', '/^[A-Za-z][A-Za-z0-9_./-]*$/', 'string', 'P']],
	[['regex', '/^[A-Za-z][A-Za-z0-9_./-]*$/', 'string', 'P']],
	[['regex', '/^[A-Za-z][A-Za-z0-9_./-]*$/', 'string', 'P']],
	[['regex', '/^[A-Za-z][A-Za-z0-9_./-]*$/', 'string', 'P']],
	[['regex', '/^[A-Za-z][A-Za-z0-9_./-]*$/', 'string', 'P']],
	[['string', 'string', 'null', '']],
	[['string', 'string', 'undefined', '']],
	[['string', 'string', 'number', '']],
	[['string', 'string', 'boolean', '']],
	[['string', 'string', 'array', '']],
	[['string', 'string', 'object', '']]
];

const ZOD_OUTCOME_ANSWERS: Array<Answer> = [
	'accepted',
	'accepted',
	[['one_of', '"success" | "failure"', 'string', '']],
	[['one_of', '"success" | "failure"', 'string', '']],
	[['one_of', '"success" | "failure"', 'string', '']],
	[['one_of', '"success" | "failure"', 'string', '']],
	[['one_of', '"success" | "failure"', 'null', '']],
	[['one_of', '"success" | "failure"', 'undefined', '']],
	[['one_of', '"success" | "failure"', 'number', '']],
	[['one_of', '"success" | "failure"', 'array', '']]
];

describe('AuditEventTypeName', () => {
	test('is a fuz_schema schema', () => {
		assert.ok(is_schema(AuditEventTypeName));
	});

	test('keeps the message text', () => {
		assert.strictEqual(AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE, 'must be at most 64 characters');
		assert.strictEqual(
			AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE,
			'must start with a letter; only letters, digits, _ . / - allowed'
		);
	});

	test('gives every row the answer the Zod copy gave, but for the declared differences', () => {
		assert.strictEqual(ZOD_EVENT_TYPE_ANSWERS.length, EVENT_TYPE_CORPUS.length);
		let matched = 0;
		let custom = 0;
		let declared = 0;
		for (const [row, input] of EVENT_TYPE_CORPUS.entries()) {
			const label = JSON.stringify(input) ?? String(input);
			const answer = ZOD_EVENT_TYPE_ANSWERS[row]!;
			const fuz = outcome_of(AuditEventTypeName, input);
			if (answer === 'accepted') {
				assert.ok(fuz.ok, label);
				assert.strictEqual(fuz.value, input, label);
				matched++;
				continue;
			}
			assert.ok(!fuz.ok, label);
			const too_long_off_grammar =
				typeof input === 'string' &&
				input.length > NAME_LENGTH_MAX &&
				!AUDIT_EVENT_TYPE_NAME_REGEX.test(input);
			// declared: the one length issue, as fuz_schema's `pipe` stops at its
			// first failing step
			const expected = too_long_off_grammar ? answer.slice(0, 1) : answer;
			if (too_long_off_grammar) {
				declared++;
				assert.deepStrictEqual(
					answer.map((i) => i[0]),
					['max_length', 'regex'],
					label
				);
			}
			assert.deepStrictEqual(
				fuz.issues.map((i) => [i.kind, i.expected, i.received]),
				expected.map((i) => i.slice(0, 3)),
				label
			);
			for (const [i, [, , received, message]] of expected.entries()) {
				const fuz_message = fuz.issues[i]!.message;
				if (message === 'L') {
					custom++;
					assert.strictEqual(fuz_message, AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE, label);
				} else if (message === 'P') {
					custom++;
					assert.strictEqual(fuz_message, AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE, label);
				} else {
					// declared: a value that is no string gets fuz_schema's message
					assert.notStrictEqual(typeof input, 'string', label);
					assert.strictEqual(fuz_message, `expected string, received ${received}`);
				}
			}
		}
		assert.ok(matched >= 8, `${matched} matched`);
		assert.ok(custom >= 10, `${custom} custom messages`);
		assert.ok(declared >= 2, `${declared} too long and off the grammar`);
	});

	test('its JSON Schema is the one the Zod copy wrote, byte for byte', () => {
		assert.strictEqual(
			JSON.stringify(to_json_schema(AuditEventTypeName)),
			'{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"string","maxLength":64,"pattern":"^[A-Za-z][A-Za-z0-9_./-]*$"}'
		);
	});
});

describe('AuditOutcome', () => {
	test('gives every row the answer the Zod copy gave', () => {
		assert.strictEqual(ZOD_OUTCOME_ANSWERS.length, OUTCOME_CORPUS.length);
		for (const [row, input] of OUTCOME_CORPUS.entries()) {
			const label = JSON.stringify(input) ?? String(input);
			const answer = ZOD_OUTCOME_ANSWERS[row]!;
			const fuz = outcome_of(AuditOutcome, input);
			if (answer === 'accepted') {
				assert.ok(fuz.ok, label);
				assert.strictEqual(fuz.value, input, label);
				continue;
			}
			assert.ok(!fuz.ok, label);
			assert.deepStrictEqual(
				fuz.issues.map((i) => [i.kind, i.expected, i.received]),
				answer.map((i) => i.slice(0, 3)),
				label
			);
		}
	});

	test('its JSON Schema is the one the Zod copy wrote, byte for byte', () => {
		assert.strictEqual(
			JSON.stringify(to_json_schema(AuditOutcome)),
			'{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"string","enum":["success","failure"]}'
		);
	});
});

describe('AuditEventType', () => {
	test('is the union of AUDIT_EVENT_TYPES and nothing else', () => {
		// compile-time: each direction fails typecheck when the type drifts
		const every: ReadonlyArray<AuditEventType> = AUDIT_EVENT_TYPES;
		const to_builtin = (t: AuditEventType): (typeof AUDIT_EVENT_TYPES)[number] => t;
		assert.ok(every.every((t) => AUDIT_EVENT_TYPES.includes(to_builtin(t))));
		// @ts-expect-error a name outside the builtins is no AuditEventType
		const _outside: AuditEventType = 'app_login';
		assert.ok(!AUDIT_EVENT_TYPES.some((t) => t === _outside));
	});
});
