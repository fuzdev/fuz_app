/**
 * Tests for `auth/token_scope.ts` — building the stored scope from a mint input.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { is } from '@fuzdev/fuz_schema/schema.ts';

import {
	is_route_scope_capability,
	TOKEN_SCOPE_VERSION,
	TokenScopeInput,
	token_scope_from_input,
	token_scope_label
} from '#lib/auth/token_scope.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

describe('is_route_scope_capability', () => {
	test('a surface name is runs of lowercase letters joined by single underscores', () => {
		for (const good of [
			'surface:a',
			'surface:upload',
			'surface:file_bytes',
			'surface:a_b_c',
			'surface:db_admin'
		]) {
			assert.ok(is_route_scope_capability(good), good);
		}
		for (const bad of [
			'rpc:account_verify',
			'upload',
			'surface:',
			'surface:_upload',
			'surface:upload_',
			'surface:file__bytes',
			'surface:file___bytes',
			'surface:a_b__c',
			'surface:__upload',
			'surface:upload__',
			'surface:__',
			'surface:Upload',
			'surface:file-bytes',
			'surface:9lives'
		]) {
			assert.ok(!is_route_scope_capability(bad), bad);
		}
	});

	test('a surface name is at most NAME_LENGTH_MAX characters', () => {
		assert.ok(is_route_scope_capability(`surface:${'a'.repeat(NAME_LENGTH_MAX)}`));
		assert.ok(!is_route_scope_capability(`surface:${'a'.repeat(NAME_LENGTH_MAX + 1)}`));
	});
});

describe('token_scope_from_input', () => {
	test('a full input builds a current-version full scope', () => {
		assert.deepStrictEqual(token_scope_from_input({ kind: 'full' }), {
			version: TOKEN_SCOPE_VERSION,
			kind: 'full'
		});
	});

	test('duplicate method names collapse into one, first occurrence kept', () => {
		const scope = token_scope_from_input({
			kind: 'methods',
			methods: ['cell_list', 'cell_get', 'cell_list', 'cell_get']
		});
		assert.deepStrictEqual(scope, {
			version: TOKEN_SCOPE_VERSION,
			kind: 'methods',
			methods: ['cell_list', 'cell_get']
		});
		// the label counts what the scope admits, as the Rust spine's set does
		assert.strictEqual(token_scope_label(scope), '2 methods');
	});
});

describe('TokenScopeInput', () => {
	const refused: Array<[label: string, input: unknown]> = [
		['an unknown key', { kind: 'full', junk: 1 }],
		['a version', { kind: 'full', version: 1 }],
		['a grandfathered flag', { kind: 'full', grandfathered: true }],
		['methods on kind full', { kind: 'full', methods: ['cell_get'] }],
		['a null methods', { kind: 'methods', methods: null }],
		['no methods on kind methods', { kind: 'methods' }],
		['an unknown kind', { kind: 'everything' }]
	];
	test.each(refused)('refuses %s', (_label, input) => {
		assert.strictEqual(is(TokenScopeInput, input), false);
	});
});
