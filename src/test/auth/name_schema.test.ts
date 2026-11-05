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
import { RoleName as FuzRoleName } from '#lib/auth/role_schema_fuz.ts';
import {
	SCOPE_KIND_NAME_LENGTH_MESSAGE,
	SCOPE_KIND_NAME_PATTERN_MESSAGE,
	ScopeKindName
} from '#lib/auth/scope_kind_schema.ts';
import { ScopeKindName as FuzScopeKindName } from '#lib/auth/scope_kind_schema_fuz.ts';
import { is_route_scope_capability } from '#lib/auth/token_scope.ts';

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

describe('the shared name grammar', () => {
	test('NAME_LENGTH_MAX and NAME_REGEX', () => {
		assert.strictEqual(NAME_LENGTH_MAX, 64);
		assert.strictEqual(NAME_REGEX.source, '^[a-z]+(?:_[a-z]+)*$');
		assert.strictEqual(NAME_REGEX.flags, '');
	});

	test('every reader gives each name the verdict of is_valid_name', () => {
		for (const [name, valid] of CORPUS) {
			assert.strictEqual(is_valid_name(name), valid, name);
			assert.strictEqual(RoleName.safeParse(name).success, valid, `RoleName ${name}`);
			assert.strictEqual(parse(FuzRoleName, name).ok, valid, `fuz RoleName ${name}`);
			assert.strictEqual(ScopeKindName.safeParse(name).success, valid, `ScopeKindName ${name}`);
			assert.strictEqual(parse(FuzScopeKindName, name).ok, valid, `fuz ScopeKindName ${name}`);
			assert.strictEqual(GrantPathName.safeParse(name).success, valid, `GrantPathName ${name}`);
			assert.strictEqual(
				CredentialTypeName.safeParse(name).success,
				valid,
				`CredentialTypeName ${name}`
			);
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
			const long = schema.safeParse('a'.repeat(NAME_LENGTH_MAX + 1));
			assert.ok(!long.success);
			assert.deepStrictEqual(
				long.error.issues.map((i) => i.message),
				[format_name_length_message(label)]
			);
			const off = schema.safeParse('a__b');
			assert.ok(!off.success);
			assert.deepStrictEqual(
				off.error.issues.map((i) => i.message),
				[format_name_pattern_message(label)]
			);
		}
	});

	test('create_name_schema reports the length issue before the grammar issue', () => {
		const result = create_name_schema('Test').safeParse('A'.repeat(NAME_LENGTH_MAX + 1));
		assert.ok(!result.success);
		assert.deepStrictEqual(
			result.error.issues.map((i) => i.message),
			[
				'Test names must be at most 64 characters',
				'Test names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores'
			]
		);
	});
});
