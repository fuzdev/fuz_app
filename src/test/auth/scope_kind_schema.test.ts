/**
 * Tests for scope_kind_schema.ts — open registry of scope-kind names.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { create_scope_kind_schema, ScopeKindName } from '$lib/auth/scope_kind_schema.ts';

describe('ScopeKindName regex', () => {
	test('accepts valid lowercase names', () => {
		assert.ok(ScopeKindName.safeParse('classroom').success);
		assert.ok(ScopeKindName.safeParse('a').success);
		assert.ok(ScopeKindName.safeParse('ab').success);
		assert.ok(ScopeKindName.safeParse('multi_word_kind').success);
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

	test('rejects invalid scope-kind names at construction', () => {
		assert.throws(() => create_scope_kind_schema({ '': {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ Classroom: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ GLOBAL: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ _leading: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ trailing_: {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ 'has-dash': {} }), /Invalid scope-kind name/);
		assert.throws(() => create_scope_kind_schema({ 'has.dot': {} }), /Invalid scope-kind name/);
	});
});
