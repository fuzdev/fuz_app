/**
 * Tests for scope_kind_schema.ts — open registry of scope-kind names.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { create_scope_kind_schema, ScopeKindName } from '#lib/auth/scope_kind_schema.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

describe('ScopeKindName regex', () => {
	test('accepts valid lowercase names', () => {
		assert.ok(ScopeKindName.safeParse('classroom').success);
		assert.ok(ScopeKindName.safeParse('a').success);
		assert.ok(ScopeKindName.safeParse('ab').success);
		assert.ok(ScopeKindName.safeParse('multi_word_kind').success);
		assert.ok(ScopeKindName.safeParse('a_b_c').success);
	});

	test('rejects empty / leading / trailing / non-lowercase', () => {
		assert.ok(!ScopeKindName.safeParse('').success);
		assert.ok(!ScopeKindName.safeParse('Classroom').success);
		assert.ok(!ScopeKindName.safeParse('CLASSROOM').success);
		assert.ok(!ScopeKindName.safeParse('GLOBAL').success); // index-side token
		assert.ok(!ScopeKindName.safeParse('_leading').success);
		assert.ok(!ScopeKindName.safeParse('trailing_').success);
		assert.ok(!ScopeKindName.safeParse('has-dash').success);
		assert.ok(!ScopeKindName.safeParse('has.dot').success);
		assert.ok(!ScopeKindName.safeParse('has space').success);
		assert.ok(!ScopeKindName.safeParse('123digit').success);
	});

	test('rejects runs of underscores', () => {
		assert.ok(!ScopeKindName.safeParse('class__room').success);
		assert.ok(!ScopeKindName.safeParse('class___room').success);
		assert.ok(!ScopeKindName.safeParse('a_b__c').success);
		assert.ok(!ScopeKindName.safeParse('__ab').success);
		assert.ok(!ScopeKindName.safeParse('ab__').success);
		assert.ok(!ScopeKindName.safeParse('__').success);
	});

	test('accepts a name at the length cap and rejects one past it', () => {
		assert.ok(ScopeKindName.safeParse('a'.repeat(NAME_LENGTH_MAX)).success);
		assert.ok(!ScopeKindName.safeParse('a'.repeat(NAME_LENGTH_MAX + 1)).success);
		// underscores count toward the length like any other character
		const with_underscores = `${'a_'.repeat(NAME_LENGTH_MAX / 2 - 1)}aa`;
		assert.strictEqual(with_underscores.length, NAME_LENGTH_MAX);
		assert.ok(ScopeKindName.safeParse(with_underscores).success);
		assert.ok(!ScopeKindName.safeParse(`${with_underscores}a`).success);
		// at the cap with a run of underscores is off the grammar
		const with_run = `a${'_'.repeat(NAME_LENGTH_MAX - 2)}a`;
		assert.strictEqual(with_run.length, NAME_LENGTH_MAX);
		assert.ok(!ScopeKindName.safeParse(with_run).success);
	});
});

describe('create_scope_kind_schema', () => {
	test('builds schema from consumer kinds', () => {
		const { ScopeKind, scope_kinds } = create_scope_kind_schema({
			classroom: { description: 'A classroom.' },
			tenant: {}
		});
		assert.ok(ScopeKind.safeParse('classroom').success);
		assert.ok(ScopeKind.safeParse('tenant').success);
		assert.ok(!ScopeKind.safeParse('unknown').success);
		assert.strictEqual(scope_kinds.size, 2);
		assert.strictEqual(scope_kinds.get('classroom')!.description, 'A classroom.');
		assert.strictEqual(scope_kinds.get('tenant')!.description, undefined);
	});

	test('empty registry produces a schema that rejects every input', () => {
		const { ScopeKind, scope_kinds } = create_scope_kind_schema({});
		assert.strictEqual(scope_kinds.size, 0);
		assert.ok(!ScopeKind.safeParse('classroom').success);
		assert.ok(!ScopeKind.safeParse('').success);
	});

	test('rejects a scope-kind name past the length cap at construction', () => {
		assert.throws(
			() => create_scope_kind_schema({ ['a'.repeat(NAME_LENGTH_MAX + 1)]: {} }),
			/at most/
		);
		create_scope_kind_schema({ ['a'.repeat(NAME_LENGTH_MAX)]: {} });
	});

	test('rejects invalid scope-kind names at construction', () => {
		assert.throws(() => create_scope_kind_schema({ '': {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ Classroom: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ GLOBAL: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ _leading: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ trailing_: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ 'has-dash': {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ 'has.dot': {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ class__room: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ class___room: {} }), /Invalid scope-kind name/);
		// a run of underscores is off the grammar, not merely unusual: it throws at construction
		assert.throws(
			() => create_scope_kind_schema({ a__b: {} }),
			'Invalid scope-kind name "a__b": Scope-kind names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores'
		);
		assert.ok(create_scope_kind_schema({ a_b_c: {} }));
	});
});
