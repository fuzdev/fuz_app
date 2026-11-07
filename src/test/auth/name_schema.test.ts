/**
 * Tests for `auth/name_schema.ts` — the name grammar and length cap the auth
 * vocabularies share, and that every reader holds it.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import {
	create_name_schema,
	format_name_length_message,
	format_name_pattern_message,
	is_valid_name,
	NAME_LENGTH_MAX,
	NAME_REGEX
} from '#lib/auth/name_schema.ts';
import { CredentialTypeName } from '#lib/auth/credential_type_schema.ts';
import { GrantPathName } from '#lib/auth/grant_path_schema.ts';
import {
	ROLE_NAME_LENGTH_MESSAGE,
	ROLE_NAME_PATTERN_MESSAGE,
	RoleName
} from '#lib/auth/role_schema.ts';
import {
	SCOPE_KIND_NAME_LENGTH_MESSAGE,
	SCOPE_KIND_NAME_PATTERN_MESSAGE,
	ScopeKindName
} from '#lib/auth/scope_kind_schema.ts';
import { is_route_scope_capability } from '#lib/auth/token_scope.ts';
import { parse_any, to_wire_issues } from '#lib/schema_issues.ts';

/** Names on the grammar and around it, each with its verdict. */
const CORPUS: Array<[name: string, valid: boolean]> = [
	['a', true],
	['admin', true],
	['a_b_c', true],
	['classroom_teacher', true],
	['a'.repeat(NAME_LENGTH_MAX), true],
	[`${'a_'.repeat(NAME_LENGTH_MAX / 2 - 1)}aa`, true],
	['a'.repeat(NAME_LENGTH_MAX + 1), false],
	[`${'a_'.repeat(NAME_LENGTH_MAX / 2)}a`, false],
	['', false],
	['_', false],
	['_a', false],
	['a_', false],
	['a__b', false],
	['A', false],
	['GLOBAL', false],
	['a1', false],
	['a-b', false],
	['a.b', false],
	['a b', false],
	['rôle', false]
];

/** A refusal's issues as `[kind, expected, received, message]`, the message as `'L'` (the length message) or `'P'` (the pattern message) or `''` (the library's default); `'accepted'` otherwise. */
type Answer =
	'accepted' | Array<[kind: string, expected: string, received: string, message: 'L' | 'P' | '']>;

/** What the Zod `GrantPathName` answered for each input of the test below, in order. */
const ZOD_GRANT_PATH_ANSWERS: Array<Answer> = [
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	[['max_length', 'length <= 64', 'string', 'L']],
	'accepted',
	[['max_length', 'length <= 64', 'string', 'L']],
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
	'accepted',
	[['string', 'string', 'null', '']],
	[['string', 'string', 'undefined', '']],
	[['string', 'string', 'number', '']],
	[['string', 'string', 'boolean', '']],
	[['string', 'string', 'array', '']],
	[['string', 'string', 'object', '']]
];

/** What the Zod `CredentialTypeName` answered for each input of the test below, in order. */
const ZOD_CREDENTIAL_TYPE_ANSWERS: Array<Answer> = [
	[['regex', '/^[a-z]+(?:_[a-z]+)*$/', 'string', 'P']],
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	[['max_length', 'length <= 64', 'string', 'L']],
	'accepted',
	[['max_length', 'length <= 64', 'string', 'L']],
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
	'accepted',
	[['string', 'string', 'null', '']],
	[['string', 'string', 'undefined', '']],
	[['string', 'string', 'number', '']],
	[['string', 'string', 'boolean', '']],
	[['string', 'string', 'array', '']],
	[['string', 'string', 'object', '']]
];

describe('the shared name grammar', () => {
	test('NAME_LENGTH_MAX and NAME_REGEX', () => {
		assert.strictEqual(NAME_LENGTH_MAX, 64);
		assert.strictEqual(NAME_REGEX.source, '^[a-z]+(?:_[a-z]+)*$');
		assert.strictEqual(NAME_REGEX.flags, '');
	});

	test('every reader gives each name the verdict of is_valid_name', () => {
		for (const [name, valid] of CORPUS) {
			assert.strictEqual(is_valid_name(name), valid, name);
			assert.strictEqual(parse(RoleName, name).ok, valid, `RoleName ${name}`);
			assert.strictEqual(parse(ScopeKindName, name).ok, valid, `ScopeKindName ${name}`);
			assert.strictEqual(parse(GrantPathName, name).ok, valid, `GrantPathName ${name}`);
			assert.strictEqual(parse(CredentialTypeName, name).ok, valid, `CredentialTypeName ${name}`);
			assert.strictEqual(is_route_scope_capability(`surface:${name}`), valid, `surface:${name}`);
		}
	});

	test('each domain keeps its own label in its messages', () => {
		assert.strictEqual(ROLE_NAME_LENGTH_MESSAGE, 'Role names must be at most 64 characters');
		assert.strictEqual(
			ROLE_NAME_PATTERN_MESSAGE,
			'Role names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores'
		);
		assert.strictEqual(
			SCOPE_KIND_NAME_LENGTH_MESSAGE,
			'Scope-kind names must be at most 64 characters'
		);
		assert.strictEqual(
			SCOPE_KIND_NAME_PATTERN_MESSAGE,
			'Scope-kind names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores'
		);
		for (const [schema, label] of [
			[GrantPathName, 'Grant-path'],
			[CredentialTypeName, 'Credential-type']
		] as const) {
			const long = parse(schema, 'a'.repeat(NAME_LENGTH_MAX + 1));
			assert.ok(!long.ok);
			assert.deepStrictEqual(
				long.issues.map((i) => i.message),
				[format_name_length_message(label)]
			);
			const off = parse(schema, 'a__b');
			assert.ok(!off.ok);
			assert.deepStrictEqual(
				off.issues.map((i) => i.message),
				[format_name_pattern_message(label)]
			);
		}
	});

	test('create_name_schema reports the one length issue for a name too long and off the grammar', () => {
		const result = parse(create_name_schema('Test'), 'A'.repeat(NAME_LENGTH_MAX + 1));
		assert.ok(!result.ok);
		assert.deepStrictEqual(
			result.issues.map((i) => [i.kind, i.message]),
			[['max_length', 'Test names must be at most 64 characters']]
		);
	});

	test('a value that is no string gets one string issue', () => {
		for (const input of [null, undefined, 1, true, ['a'], {}, Object('a')]) {
			const result = parse(create_name_schema('Test'), input);
			assert.ok(!result.ok);
			assert.deepStrictEqual(
				result.issues.map((i) => i.kind),
				['string']
			);
		}
	});

	test('GrantPathName and CredentialTypeName give the answers their Zod copies gave', () => {
		const inputs: Array<unknown> = [
			'',
			'a',
			'admin',
			'a_b_c',
			'a'.repeat(NAME_LENGTH_MAX),
			'a'.repeat(NAME_LENGTH_MAX + 1),
			`${'a_'.repeat(NAME_LENGTH_MAX / 2 - 1)}aa`,
			`${'a_'.repeat(NAME_LENGTH_MAX / 2)}a`,
			'A'.repeat(NAME_LENGTH_MAX + 1),
			`1${'a'.repeat(NAME_LENGTH_MAX)}`,
			'1abc',
			'Admin',
			'GLOBAL',
			'_a',
			'a_',
			'a__b',
			'a.',
			'a-b',
			'a b',
			'a\n',
			'rôle',
			'\u{1d41a}',
			'__proto__',
			'constructor',
			null,
			undefined,
			1,
			true,
			['a'],
			{}
		];
		assert.strictEqual(ZOD_GRANT_PATH_ANSWERS.length, inputs.length);
		assert.strictEqual(ZOD_CREDENTIAL_TYPE_ANSWERS.length, inputs.length);
		for (const [schema, answers, label] of [
			[GrantPathName, ZOD_GRANT_PATH_ANSWERS, 'GrantPathName'],
			[CredentialTypeName, ZOD_CREDENTIAL_TYPE_ANSWERS, 'CredentialTypeName']
		] as const) {
			for (const [row, input] of inputs.entries()) {
				const name = `${label} ${JSON.stringify(input) ?? String(input)}`;
				const answer = answers[row]!;
				const fuz = parse_any(schema, input);
				if (answer === 'accepted') {
					assert.ok(fuz.ok, name);
					assert.strictEqual(fuz.value, input, name);
					continue;
				}
				assert.ok(!fuz.ok, name);
				const fuz_issues = to_wire_issues(fuz.issues, input);
				// declared: a string too long and off the grammar gets the one length issue
				const expected = answer.slice(0, 1)[0]!;
				assert.strictEqual(fuz_issues.length, 1, name);
				const { message: fuz_message, kind, expected: exp, received } = fuz_issues[0]!;
				assert.deepStrictEqual([kind, exp, received], expected.slice(0, 3), name);
				// declared: a value that is no string gets fuz_schema's message
				if (typeof input === 'string') {
					assert.strictEqual(
						fuz_message,
						expected[3] === 'L'
							? format_name_length_message(
									label === 'GrantPathName' ? 'Grant-path' : 'Credential-type'
								)
							: format_name_pattern_message(
									label === 'GrantPathName' ? 'Grant-path' : 'Credential-type'
								),
						name
					);
				}
			}
		}
	});
});
