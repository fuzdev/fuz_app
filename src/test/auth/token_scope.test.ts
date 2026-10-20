/**
 * Tests for `auth/token_scope.ts` — building the stored scope from a mint input.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import {
	TOKEN_SCOPE_VERSION,
	TokenScopeInput,
	token_scope_from_input,
	token_scope_label
} from '#lib/auth/token_scope.ts';

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
		assert.strictEqual(TokenScopeInput.safeParse(input).success, false);
	});
});
