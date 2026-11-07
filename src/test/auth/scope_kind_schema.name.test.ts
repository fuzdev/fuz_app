/**
 * `ScopeKindName` (`auth/scope_kind_schema.ts`), on one corpus: each row's expected answer was frozen from the Zod copy
 * of the schema it replaced (`ZOD_ANSWERS`, in corpus order): the same verdict,
 * the same output, and the same wire issues, the message as the custom length
 * or pattern message where Zod's was one. Two differences are declared: a
 * string both too long and outside the grammar gets the length issue alone,
 * where Zod added the grammar issue after it, and a value that is no string
 * gets fuz_schema's message.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is_schema, parse } from '@fuzdev/fuz_schema/schema.ts';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';

import {
	SCOPE_KIND_NAME_LENGTH_MESSAGE,
	SCOPE_KIND_NAME_PATTERN_MESSAGE,
	ScopeKindName
} from '#lib/auth/scope_kind_schema.ts';
import { parse_any, to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';
import { NAME_LENGTH_MAX, NAME_REGEX } from '#lib/auth/name_schema.ts';

/** Strings of the grammar and around it, and values that are no string. */
const CORPUS: Array<[label: string, input: unknown]> = [
	['empty', ''],
	['one letter', 'a'],
	['one letter z', 'z'],
	['two letters', 'ab'],
	['classroom', 'classroom'],
	['GLOBAL', 'GLOBAL'],
	['inner underscore', 'a_b'],
	['inner underscores', 'a_b_c'],
	['double underscore', 'a__b'],
	['triple underscore', 'a___b'],
	['many underscores', 'a___________b'],
	['double underscore after single', 'a_b__c'],
	['double underscore leading', '__ab'],
	['double underscore trailing', 'ab__'],
	['at the cap', 'a'.repeat(NAME_LENGTH_MAX)],
	['at the cap with underscores', 'a_'.repeat(NAME_LENGTH_MAX / 2 - 1) + 'aa'],
	['at the cap with a run of underscores', 'a' + '_'.repeat(NAME_LENGTH_MAX - 2) + 'a'],
	['one past the cap with underscores', 'a_'.repeat(NAME_LENGTH_MAX / 2) + 'a'],
	['one past the cap', 'a'.repeat(NAME_LENGTH_MAX + 1)],
	['far past the cap', 'a'.repeat(1000)],
	['one past the cap, uppercase', 'A'.repeat(NAME_LENGTH_MAX + 1)],
	['one past the cap, leading underscore', '_' + 'a'.repeat(NAME_LENGTH_MAX)],
	['one past the cap, underscores', '_'.repeat(NAME_LENGTH_MAX + 1)],
	['at the cap, uppercase', 'A'.repeat(NAME_LENGTH_MAX)],
	['underscore', '_'],
	['two underscores', '__'],
	['leading underscore', '_room'],
	['trailing underscore', 'room_'],
	['both underscores', '_room_'],
	['uppercase', 'A'],
	['capitalized', 'Admin'],
	['all caps', 'ADMIN'],
	['inner capital', 'adMin'],
	['trailing digit', 'room2'],
	['leading digit', '2room'],
	['inner digit', 'a1b'],
	['digit', '1'],
	['hyphen', 'ad-min'],
	['dot', 'ad.min'],
	['inner space', 'ad min'],
	['leading space', ' room'],
	['trailing space', 'room '],
	['trailing newline', 'room\n'],
	['leading newline', '\nroom'],
	['inner newline', 'ad\nmin'],
	['trailing NUL', 'room\u0000'],
	['zero-width space', 'ad​min'],
	['Cyrillic a', 'аdmin'],
	['fullwidth a', 'ａdmin'],
	['e acute', 'é'],
	['sharp s', 'ß'],
	['dotless i', 'admın'],
	['Kelvin sign', 'K'],
	['titlecase dz', 'ǅ'],
	['modifier apostrophe', 'ʼa'],
	['math bold a', '\u{1d41a}'],
	['astral past the cap', '\u{1d41a}'.repeat(33)],
	['lone surrogate', '\ud800'],
	['null', null],
	['undefined', undefined],
	['zero', 0],
	['number', 1],
	['NaN', NaN],
	['true', true],
	['bigint', 64n],
	['empty array', []],
	['array of a scope kind', ['room']],
	['empty object', {}],
	['object with length', { length: 1 }],
	// a boxed string, `new String` without the wrapper constructor
	['String object', Object('room')]
];

/** What a parse gave: its output, or its wire issues. */
const outcome_of = (
	schema: Parameters<typeof parse_any>[0],
	input: unknown
): { ok: true; value: unknown } | { ok: false; issues: Array<WireIssue> } => {
	const result = parse_any(schema, input);
	return result.ok
		? { ok: true, value: result.value }
		: { ok: false, issues: to_wire_issues(result.issues, input) };
};

/** A refusal's issues as `[kind, expected, received, message]`, the message as `'L'` (the length message), `'P'` (the pattern message) or `''` (the library's default); `'accepted'` otherwise. */
type Answer =
	'accepted' | Array<[kind: string, expected: string, received: string, message: 'L' | 'P' | '']>;

const ZOD_ANSWERS: Array<Answer> = [
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	'accepted',
	'accepted',
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	'accepted',
	'accepted',
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['max_length', 'length <= 64', 'string', 'L']],
	[['max_length', 'length <= 64', 'string', 'L']],
	[['max_length', 'length <= 64', 'string', 'L']],
	[
		['max_length', 'length <= 64', 'string', 'L'],
		['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']
	],
	[
		['max_length', 'length <= 64', 'string', 'L'],
		['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']
	],
	[
		['max_length', 'length <= 64', 'string', 'L'],
		['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']
	],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[
		['max_length', 'length <= 64', 'string', 'L'],
		['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']
	],
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	[['string', 'string', 'null', '']],
	[['string', 'string', 'undefined', '']],
	[['string', 'string', 'number', '']],
	[['string', 'string', 'number', '']],
	[['string', 'string', 'NaN', '']],
	[['string', 'string', 'boolean', '']],
	[['string', 'string', 'bigint', '']],
	[['string', 'string', 'array', '']],
	[['string', 'string', 'array', '']],
	[['string', 'string', 'object', '']],
	[['string', 'string', 'object', '']],
	[['string', 'string', 'object', '']]
];

describe('ScopeKindName', () => {
	test('is a fuz_schema schema', () => {
		assert.ok(is_schema(ScopeKindName));
	});

	test('keeps the pattern message text', () => {
		assert.strictEqual(
			SCOPE_KIND_NAME_PATTERN_MESSAGE,
			'Scope-kind names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores'
		);
	});

	test('gives every row the answer the Zod copy gave, but for the declared differences', () => {
		assert.strictEqual(ZOD_ANSWERS.length, CORPUS.length);
		let matched = 0;
		let custom = 0;
		let declared = 0;
		for (const [row, [label, input]] of CORPUS.entries()) {
			const answer = ZOD_ANSWERS[row]!;
			const fuz = outcome_of(ScopeKindName, input);
			if (answer === 'accepted') {
				assert.ok(fuz.ok, label);
				assert.strictEqual(fuz.value, input, label);
				matched++;
				continue;
			}
			assert.ok(!fuz.ok, label);
			const too_long_off_grammar =
				typeof input === 'string' && input.length > NAME_LENGTH_MAX && !NAME_REGEX.test(input);
			// declared: a string too long and off the grammar gets the one length
			// issue, as fuz_schema's `pipe` stops at its first failing step
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
					assert.strictEqual(fuz_message, SCOPE_KIND_NAME_LENGTH_MESSAGE, label);
				} else if (message === 'P') {
					custom++;
					assert.strictEqual(fuz_message, SCOPE_KIND_NAME_PATTERN_MESSAGE, label);
				} else {
					// declared: a value that is no string gets fuz_schema's message
					assert.notStrictEqual(typeof input, 'string', label);
					assert.strictEqual(fuz_message, `expected string, received ${received}`);
				}
			}
		}
		// the corpus reaches every branch
		assert.ok(matched >= 8, `${matched} matched`);
		assert.ok(custom >= 30, `${custom} custom messages`);
		assert.ok(declared >= 4, `${declared} too long and off the grammar`);
	});

	test('the length issue and the grammar issue carry their messages', () => {
		const long = parse(ScopeKindName, 'a'.repeat(NAME_LENGTH_MAX + 1));
		assert.ok(!long.ok);
		assert.deepStrictEqual(
			long.issues.map((i) => [i.kind, i.expected, i.message]),
			[['max_length', `length <= ${NAME_LENGTH_MAX}`, SCOPE_KIND_NAME_LENGTH_MESSAGE]]
		);
		const off = parse(ScopeKindName, '_a');
		assert.ok(!off.ok);
		assert.deepStrictEqual(
			off.issues.map((i) => [i.kind, i.expected, i.message]),
			[['regex', String(NAME_REGEX), SCOPE_KIND_NAME_PATTERN_MESSAGE]]
		);
		const both = parse(ScopeKindName, 'A'.repeat(NAME_LENGTH_MAX + 1));
		assert.ok(!both.ok);
		assert.deepStrictEqual(
			both.issues.map((i) => i.kind),
			['max_length']
		);
	});

	test('its JSON Schema is the one the Zod copy wrote, byte for byte', () => {
		assert.strictEqual(
			JSON.stringify(to_json_schema(ScopeKindName)),
			'{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"string","maxLength":64,"pattern":"^[a-z]+(?:_[a-z]+)*$"}'
		);
		assert.deepEqual<Record<string, unknown>>(to_json_schema(ScopeKindName), {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'string',
			maxLength: NAME_LENGTH_MAX,
			pattern: NAME_REGEX.source
		});
	});
});
