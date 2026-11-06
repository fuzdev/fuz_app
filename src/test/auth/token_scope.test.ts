/**
 * Tests for `auth/token_scope.ts` — building the stored scope from a mint
 * input, and the size cap on the stored document.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { is } from '@fuzdev/fuz_schema/schema.ts';

import {
	is_route_scope_capability,
	MAX_TOKEN_SCOPE_BYTES,
	parse_stored_token_scope,
	parse_token_scope,
	serialize_token_scope,
	TOKEN_SCOPE_VERSION,
	TokenScopeInput,
	token_scope_from_input,
	token_scope_label,
	token_scope_methods
} from '#lib/auth/token_scope.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';
import {
	token_scope_methods_at_bytes,
	token_scope_methods_bytes
} from '#lib/testing/token_scope_fixtures.ts';

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

describe('the scope cap', () => {
	const filler = '\u00e9'.repeat(40);
	const at_cap = token_scope_methods_at_bytes(MAX_TOKEN_SCOPE_BYTES, filler);
	const over_cap = token_scope_methods_at_bytes(MAX_TOKEN_SCOPE_BYTES + 1, filler);
	/** The text Postgres prints a `jsonb` as; the fixture's names hold no `:` or `,`. */
	const as_printed = (json: string): string => json.replaceAll(':', ': ').replaceAll(',', ', ');

	test('the fixtures sit on the cap in bytes and far under it in code units', () => {
		assert.strictEqual(token_scope_methods_bytes(at_cap), MAX_TOKEN_SCOPE_BYTES);
		assert.strictEqual(token_scope_methods_bytes(over_cap), MAX_TOKEN_SCOPE_BYTES + 1);
		const over_json = JSON.stringify(token_scope_methods(over_cap));
		assert.isBelow(over_json.length, MAX_TOKEN_SCOPE_BYTES - 1000);
	});

	test('the mint counts UTF-8 bytes', () => {
		const json = serialize_token_scope(token_scope_methods(at_cap));
		assert.strictEqual(json, JSON.stringify(token_scope_methods(at_cap)));
		assert.throws(
			() => serialize_token_scope(token_scope_methods(over_cap)),
			`token scope document is ${MAX_TOKEN_SCOPE_BYTES + 1} bytes, exceeding the ${MAX_TOKEN_SCOPE_BYTES} byte cap`
		);
	});

	test('the read counts UTF-8 bytes of the compact document, parsed or printed', () => {
		// as the Rust spine writes it, methods sorted, and in another order
		for (const methods of [at_cap, [...at_cap].reverse()]) {
			const json = JSON.stringify(token_scope_methods(methods));
			const printed = as_printed(json);
			assert.isAbove(new TextEncoder().encode(printed).length, MAX_TOKEN_SCOPE_BYTES);
			assert.deepStrictEqual(
				parse_stored_token_scope(JSON.parse(json)),
				token_scope_methods(methods)
			);
			assert.deepStrictEqual(parse_token_scope(printed), token_scope_methods(methods));
			assert.deepStrictEqual(parse_stored_token_scope(printed), token_scope_methods(methods));
		}
		const over = token_scope_methods(over_cap);
		assert.strictEqual(parse_stored_token_scope(over), null);
		assert.strictEqual(parse_stored_token_scope(as_printed(JSON.stringify(over))), null);
	});

	test('an ASCII document under the cap reads from its printed text past it', () => {
		const methods = token_scope_methods_at_bytes(MAX_TOKEN_SCOPE_BYTES - 50, 'm');
		const printed = as_printed(JSON.stringify(token_scope_methods(methods)));
		assert.isAbove(printed.length, MAX_TOKEN_SCOPE_BYTES);
		assert.deepStrictEqual(parse_token_scope(printed), token_scope_methods(methods));
		assert.deepStrictEqual(parse_stored_token_scope(printed), token_scope_methods(methods));
	});

	test('a text past twice the cap is refused before it is parsed', () => {
		// a document at the cap padded with whitespace parses, so only the length refuses it
		const json = JSON.stringify(
			token_scope_methods(token_scope_methods_at_bytes(MAX_TOKEN_SCOPE_BYTES, 'm'))
		);
		const printed = as_printed(json);
		assert.isBelow(printed.length, 2 * MAX_TOKEN_SCOPE_BYTES);
		assert.isNotNull(parse_token_scope(printed));
		const padded = json + ' '.repeat(2 * MAX_TOKEN_SCOPE_BYTES + 1 - json.length);
		assert.deepStrictEqual(JSON.parse(padded), JSON.parse(json));
		assert.strictEqual(parse_token_scope(padded), null);
		assert.strictEqual(parse_stored_token_scope(padded), null);
		assert.isNotNull(parse_token_scope(padded.slice(0, -1)));
	});

	test('an absent document is unreadable', () => {
		assert.strictEqual(parse_stored_token_scope(undefined), null);
	});
});
