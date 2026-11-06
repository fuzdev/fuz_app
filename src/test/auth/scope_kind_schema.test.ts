/**
 * Tests for scope_kind_schema.ts — open registry of scope-kind names.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { is } from '@fuzdev/fuz_schema/schema.ts';

import { create_scope_kind_registry, ScopeKindName } from '#lib/auth/scope_kind_schema.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

describe('ScopeKindName regex', () => {
	test('accepts valid lowercase names', () => {
		assert.ok(is(ScopeKindName, 'classroom'));
		assert.ok(is(ScopeKindName, 'a'));
		assert.ok(is(ScopeKindName, 'ab'));
		assert.ok(is(ScopeKindName, 'multi_word_kind'));
		assert.ok(is(ScopeKindName, 'a_b_c'));
	});

	test('rejects empty / leading / trailing / non-lowercase', () => {
		assert.ok(!is(ScopeKindName, ''));
		assert.ok(!is(ScopeKindName, 'Classroom'));
		assert.ok(!is(ScopeKindName, 'CLASSROOM'));
		assert.ok(!is(ScopeKindName, 'GLOBAL')); // index-side token
		assert.ok(!is(ScopeKindName, '_leading'));
		assert.ok(!is(ScopeKindName, 'trailing_'));
		assert.ok(!is(ScopeKindName, 'has-dash'));
		assert.ok(!is(ScopeKindName, 'has.dot'));
		assert.ok(!is(ScopeKindName, 'has space'));
		assert.ok(!is(ScopeKindName, '123digit'));
	});

	test('rejects runs of underscores', () => {
		assert.ok(!is(ScopeKindName, 'class__room'));
		assert.ok(!is(ScopeKindName, 'class___room'));
		assert.ok(!is(ScopeKindName, 'a_b__c'));
		assert.ok(!is(ScopeKindName, '__ab'));
		assert.ok(!is(ScopeKindName, 'ab__'));
		assert.ok(!is(ScopeKindName, '__'));
	});

	test('accepts a name at the length cap and rejects one past it', () => {
		assert.ok(is(ScopeKindName, 'a'.repeat(NAME_LENGTH_MAX)));
		assert.ok(!is(ScopeKindName, 'a'.repeat(NAME_LENGTH_MAX + 1)));
		// underscores count toward the length like any other character
		const with_underscores = `${'a_'.repeat(NAME_LENGTH_MAX / 2 - 1)}aa`;
		assert.strictEqual(with_underscores.length, NAME_LENGTH_MAX);
		assert.ok(is(ScopeKindName, with_underscores));
		assert.ok(!is(ScopeKindName, `${with_underscores}a`));
		// at the cap with a run of underscores is off the grammar
		const with_run = `a${'_'.repeat(NAME_LENGTH_MAX - 2)}a`;
		assert.strictEqual(with_run.length, NAME_LENGTH_MAX);
		assert.ok(!is(ScopeKindName, with_run));
	});
});

describe('create_scope_kind_registry', () => {
	test('builds the registry from consumer kinds', () => {
		const { scope_kinds } = create_scope_kind_registry({
			classroom: { description: 'A classroom.' },
			tenant: {}
		});
		assert.ok(scope_kinds.has('classroom'));
		assert.ok(scope_kinds.has('tenant'));
		assert.ok(!scope_kinds.has('unknown'));
		assert.strictEqual(scope_kinds.size, 2);
		assert.strictEqual(scope_kinds.get('classroom')!.description, 'A classroom.');
		assert.strictEqual(scope_kinds.get('tenant')!.description, undefined);
	});

	test('an empty registry holds no kind', () => {
		const { scope_kinds } = create_scope_kind_registry({});
		assert.strictEqual(scope_kinds.size, 0);
		assert.ok(!scope_kinds.has('classroom'));
		assert.ok(!scope_kinds.has(''));
	});

	test('rejects a scope-kind name past the length cap at construction', () => {
		assert.throws(
			() => create_scope_kind_registry({ ['a'.repeat(NAME_LENGTH_MAX + 1)]: {} }),
			/at most/
		);
		create_scope_kind_registry({ ['a'.repeat(NAME_LENGTH_MAX)]: {} });
	});

	test('rejects invalid scope-kind names at construction', () => {
		assert.throws(() => create_scope_kind_registry({ '': {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_registry({ Classroom: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_registry({ GLOBAL: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_registry({ _leading: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_registry({ trailing_: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_registry({ 'has-dash': {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_registry({ 'has.dot': {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_registry({ class__room: {} }), /Invalid scope-kind name/);
		assert.throws(
			() => create_scope_kind_registry({ class___room: {} }),
			/Invalid scope-kind name/
		);
		// a run of underscores is off the grammar, not merely unusual: it throws at construction
		assert.throws(
			() => create_scope_kind_registry({ a__b: {} }),
			'Invalid scope-kind name "a__b": Scope-kind names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores'
		);
		assert.ok(create_scope_kind_registry({ a_b_c: {} }));
	});
});
