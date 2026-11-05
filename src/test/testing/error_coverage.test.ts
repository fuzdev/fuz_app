/**
 * Tests for `extract_declared_error_codes` — the codes a declared error
 * schema names, read from a Zod or a `@fuzdev/fuz_schema` schema, which split
 * a status into per-code coverage rows.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import {
	check,
	literal,
	loose_object,
	object,
	one_of,
	optional,
	pipe,
	string,
	strip_object
} from '@fuzdev/fuz_schema/schema.ts';

import { extract_declared_error_codes } from '#lib/testing/error_coverage.ts';

describe('extract_declared_error_codes', () => {
	test('reads a Zod literal and enum', () => {
		assert.deepStrictEqual(
			extract_declared_error_codes(z.looseObject({ error: z.literal('a_not_found') })),
			['a_not_found']
		);
		assert.deepStrictEqual(
			extract_declared_error_codes(z.strictObject({ error: z.enum(['a', 'b']) })),
			['a', 'b']
		);
	});

	test('reads a fuz_schema literal and one_of, on any object kind', () => {
		assert.deepStrictEqual(
			extract_declared_error_codes(loose_object({ error: literal('a_not_found') })),
			['a_not_found']
		);
		assert.deepStrictEqual(extract_declared_error_codes(object({ error: one_of(['a', 'b']) })), [
			'a',
			'b'
		]);
		assert.deepStrictEqual(extract_declared_error_codes(strip_object({ error: literal('c') })), [
			'c'
		]);
	});

	test('reads a fuz_schema object under a pipe', () => {
		const schema = pipe(
			object({ error: literal('a') }),
			check(() => true)
		);
		assert.deepStrictEqual(extract_declared_error_codes(schema), ['a']);
	});

	test('is null for a fuz_schema error field that names no code', () => {
		assert.strictEqual(extract_declared_error_codes(loose_object({ error: string })), null);
		// the field is read as given, as the Zod one is: an optional code is no declared code
		assert.strictEqual(
			extract_declared_error_codes(loose_object({ error: optional(literal('a')) })),
			null
		);
		assert.strictEqual(extract_declared_error_codes(loose_object({ other: literal('a') })), null);
	});

	test('is null for a schema that is no object', () => {
		assert.strictEqual(extract_declared_error_codes(literal('a')), null);
		assert.strictEqual(extract_declared_error_codes(string), null);
		assert.strictEqual(extract_declared_error_codes(z.literal('a')), null);
	});
});
