/**
 * The `@fuzdev/fuz_schema` `RoleName` twin (`auth/role_schema_fuz.ts`), held
 * to the Zod `RoleName` on one corpus: the same verdict, the same output, and
 * the same wire issues, `message` included where it is one of the two custom
 * messages. Two differences are declared: a string both too long and outside
 * the grammar gets the length issue alone, where Zod adds the grammar issue
 * after it, and a value that is no string gets fuz_schema's message.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { is_schema, parse } from '@fuzdev/fuz_schema/schema.ts';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';

import {
	ROLE_NAME_LENGTH_MAX,
	ROLE_NAME_LENGTH_MESSAGE,
	ROLE_NAME_PATTERN,
	ROLE_NAME_PATTERN_MESSAGE,
	RoleName as ZodRoleName
} from '#lib/auth/role_schema.ts';
import { RoleName } from '#lib/auth/role_schema_fuz.ts';
import { parse_any, to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';

/** Strings of the grammar and around it, and values that are no string. */
const CORPUS: Array<[label: string, input: unknown]> = [
	['empty', ''],
	['one letter', 'a'],
	['one letter z', 'z'],
	['two letters', 'ab'],
	['builtin admin', 'admin'],
	['builtin keeper', 'keeper'],
	['inner underscore', 'a_b'],
	['double underscore', 'a__b'],
	['many underscores', 'a___________b'],
	['at the cap', 'a'.repeat(ROLE_NAME_LENGTH_MAX)],
	['at the cap with underscores', 'a' + '_'.repeat(ROLE_NAME_LENGTH_MAX - 2) + 'a'],
	['one past the cap', 'a'.repeat(ROLE_NAME_LENGTH_MAX + 1)],
	['far past the cap', 'a'.repeat(1000)],
	['one past the cap, uppercase', 'A'.repeat(ROLE_NAME_LENGTH_MAX + 1)],
	['one past the cap, leading underscore', '_' + 'a'.repeat(ROLE_NAME_LENGTH_MAX)],
	['one past the cap, underscores', '_'.repeat(ROLE_NAME_LENGTH_MAX + 1)],
	['at the cap, uppercase', 'A'.repeat(ROLE_NAME_LENGTH_MAX)],
	['underscore', '_'],
	['two underscores', '__'],
	['leading underscore', '_admin'],
	['trailing underscore', 'admin_'],
	['both underscores', '_admin_'],
	['uppercase', 'A'],
	['capitalized', 'Admin'],
	['all caps', 'ADMIN'],
	['inner capital', 'adMin'],
	['trailing digit', 'admin2'],
	['leading digit', '2admin'],
	['inner digit', 'a1b'],
	['digit', '1'],
	['hyphen', 'ad-min'],
	['dot', 'ad.min'],
	['inner space', 'ad min'],
	['leading space', ' admin'],
	['trailing space', 'admin '],
	['trailing newline', 'admin\n'],
	['leading newline', '\nadmin'],
	['inner newline', 'ad\nmin'],
	['trailing NUL', 'admin\u0000'],
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
	['array of a role', ['admin']],
	['empty object', {}],
	['object with length', { length: 1 }],
	// a boxed string, `new String` without the wrapper constructor
	['String object', Object('admin')]
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

const CUSTOM_MESSAGES: ReadonlyArray<string> = [
	ROLE_NAME_LENGTH_MESSAGE,
	ROLE_NAME_PATTERN_MESSAGE
];

describe('fuz_schema RoleName', () => {
	test('is a fuz_schema schema', () => {
		assert.ok(is_schema(RoleName));
	});

	test('keeps the pattern message text', () => {
		assert.strictEqual(
			ROLE_NAME_PATTERN_MESSAGE,
			'Role names must be lowercase letters and underscores (a-z_), no leading/trailing underscore'
		);
	});

	test('agrees with the Zod RoleName on every row but the declared differences', () => {
		let matched = 0;
		let custom = 0;
		let declared = 0;
		for (const [label, input] of CORPUS) {
			const fuz = outcome_of(RoleName, input);
			const zod = outcome_of(ZodRoleName, input);
			assert.strictEqual(fuz.ok, zod.ok, label);
			if (fuz.ok && zod.ok) {
				assert.strictEqual(fuz.value, input, label);
				assert.strictEqual(zod.value, input, label);
				matched++;
				continue;
			}
			assert.ok(!fuz.ok && !zod.ok);
			const too_long_off_grammar =
				typeof input === 'string' &&
				input.length > ROLE_NAME_LENGTH_MAX &&
				!ROLE_NAME_PATTERN.test(input);
			// declared: a string too long and off the grammar gets the one length
			// issue, as fuz_schema's `pipe` stops at its first failing step
			const zod_issues = too_long_off_grammar ? zod.issues.slice(0, 1) : zod.issues;
			if (too_long_off_grammar) {
				declared++;
				assert.deepStrictEqual(
					zod.issues.map((i) => i.kind),
					['max_length', 'regex'],
					label
				);
			}
			assert.strictEqual(fuz.issues.length, zod_issues.length, label);
			for (let i = 0; i < fuz.issues.length; i++) {
				const { message: fuz_message, ...fuz_rest } = fuz.issues[i]!;
				const { message: zod_message, ...zod_rest } = zod_issues[i]!;
				assert.deepStrictEqual(fuz_rest, zod_rest, label);
				if (CUSTOM_MESSAGES.includes(zod_message)) {
					custom++;
					assert.strictEqual(fuz_message, zod_message, label);
				} else {
					// declared: a value that is no string gets fuz_schema's message
					assert.notStrictEqual(typeof input, 'string', label);
					assert.strictEqual(fuz_message, `expected string, received ${fuz_rest.received}`);
				}
			}
		}
		// the corpus reaches every branch
		assert.ok(matched >= 8, `${matched} matched`);
		assert.ok(custom >= 30, `${custom} custom messages`);
		assert.ok(declared >= 4, `${declared} too long and off the grammar`);
	});

	test('the length issue and the grammar issue carry their messages', () => {
		const long = parse(RoleName, 'a'.repeat(ROLE_NAME_LENGTH_MAX + 1));
		assert.ok(!long.ok);
		assert.deepStrictEqual(
			long.issues.map((i) => [i.kind, i.expected, i.message]),
			[['max_length', `length <= ${ROLE_NAME_LENGTH_MAX}`, ROLE_NAME_LENGTH_MESSAGE]]
		);
		const off = parse(RoleName, '_a');
		assert.ok(!off.ok);
		assert.deepStrictEqual(
			off.issues.map((i) => [i.kind, i.expected, i.message]),
			[['regex', String(ROLE_NAME_PATTERN), ROLE_NAME_PATTERN_MESSAGE]]
		);
		const both = parse(RoleName, 'A'.repeat(ROLE_NAME_LENGTH_MAX + 1));
		assert.ok(!both.ok);
		assert.deepStrictEqual(
			both.issues.map((i) => i.kind),
			['max_length']
		);
	});

	test('its JSON Schema is the Zod RoleName’s, byte for byte', () => {
		assert.strictEqual(
			JSON.stringify(to_json_schema(RoleName)),
			JSON.stringify(z.toJSONSchema(ZodRoleName))
		);
		assert.deepEqual<Record<string, unknown>>(to_json_schema(RoleName), {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'string',
			maxLength: ROLE_NAME_LENGTH_MAX,
			pattern: ROLE_NAME_PATTERN.source
		});
	});
});
