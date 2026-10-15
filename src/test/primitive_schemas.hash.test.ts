/**
 * Tests for the hash schemas `Blake3Hash` and `FactHashSchema`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import {
	FACT_HASH_EXACT,
	FACT_HASH_PREFIX,
	is_fact_hash,
	type FactHash
} from '@fuzdev/fuz_util/hash_schemas.ts';

import { Blake3Hash, FactHashSchema } from '#lib/primitive_schemas.ts';

/** A syntactically valid (if not content-derived) fact hash literal. */
const HASH_A = (FACT_HASH_PREFIX + 'a'.repeat(64)) as FactHash;

describe('Blake3Hash', () => {
	test('accepts all-zeros', () => {
		assert.strictEqual(Blake3Hash.safeParse('0'.repeat(64)).success, true);
	});

	test('accepts all-f', () => {
		assert.strictEqual(Blake3Hash.safeParse('f'.repeat(64)).success, true);
	});

	test('rejects too short', () => {
		assert.strictEqual(Blake3Hash.safeParse('abcdef').success, false);
	});

	test('rejects too long', () => {
		assert.strictEqual(Blake3Hash.safeParse('a'.repeat(65)).success, false);
	});

	test('rejects uppercase hex', () => {
		assert.strictEqual(Blake3Hash.safeParse('A'.repeat(64)).success, false);
	});

	test('rejects non-hex characters', () => {
		assert.strictEqual(Blake3Hash.safeParse('g'.repeat(64)).success, false);
	});

	test('rejects empty string', () => {
		assert.strictEqual(Blake3Hash.safeParse('').success, false);
	});

	test('rejects 63 chars (off-by-one short)', () => {
		assert.strictEqual(Blake3Hash.safeParse('a'.repeat(63)).success, false);
	});

	test('rejects 65 chars (off-by-one long)', () => {
		assert.strictEqual(Blake3Hash.safeParse('a'.repeat(65)).success, false);
	});

	test('rejects UUID format', () => {
		// Regression: session IDs were validated as UUIDs but are blake3 hashes
		assert.strictEqual(Blake3Hash.safeParse('00000000-0000-4000-8000-000000000040').success, false);
	});

	test('rejects mixed case hex', () => {
		const mixed = 'aAbBcCdDeEfF'.repeat(5) + 'aAbB';
		assert.strictEqual(mixed.length, 64);
		assert.strictEqual(Blake3Hash.safeParse(mixed).success, false);
	});

	test('rejects leading whitespace', () => {
		assert.strictEqual(Blake3Hash.safeParse(' ' + 'a'.repeat(64)).success, false);
	});

	test('rejects trailing whitespace', () => {
		assert.strictEqual(Blake3Hash.safeParse('a'.repeat(64) + ' ').success, false);
	});

	test('rejects embedded spaces', () => {
		assert.strictEqual(Blake3Hash.safeParse('a'.repeat(32) + ' ' + 'a'.repeat(31)).success, false);
	});

	test('rejects number', () => {
		assert.strictEqual(Blake3Hash.safeParse(12345).success, false);
	});

	test('rejects null', () => {
		assert.strictEqual(Blake3Hash.safeParse(null).success, false);
	});

	test('rejects undefined', () => {
		assert.strictEqual(Blake3Hash.safeParse(undefined).success, false);
	});

	test('rejects boolean', () => {
		assert.strictEqual(Blake3Hash.safeParse(true).success, false);
	});

	test('rejects the `blake3:`-prefixed wire form (that is FactHashSchema)', () => {
		assert.strictEqual(Blake3Hash.safeParse(HASH_A).success, false);
	});
});

describe('FactHashSchema', () => {
	test('parse throws on a malformed value', () => {
		assert.throws(() => FactHashSchema.parse('blake3:nope'));
	});

	test('parse round-trips a well-formed hash unchanged', () => {
		const raw = FACT_HASH_PREFIX + 'a'.repeat(64);
		assert.strictEqual(FactHashSchema.parse(raw), raw);
	});

	test('agrees with is_fact_hash', () => {
		const cases = [
			HASH_A,
			FACT_HASH_PREFIX + 'a'.repeat(63),
			FACT_HASH_PREFIX + 'a'.repeat(65),
			HASH_A + '\n',
			'sha256:' + 'a'.repeat(64),
			FACT_HASH_PREFIX + 'A'.repeat(64),
			'a'.repeat(64),
			`see ${HASH_A} here`,
			''
		];
		for (const c of cases) {
			assert.strictEqual(FactHashSchema.safeParse(c).success, is_fact_hash(c), c);
		}
	});

	test('output is fuz_util FactHash', () => {
		const parsed: FactHash = FactHashSchema.parse(HASH_A);
		assert.strictEqual(parsed, HASH_A);
	});

	test('keeps the regex in its JSON Schema', () => {
		const json = z.toJSONSchema(z.array(FactHashSchema).nullable()) as Record<string, unknown>;
		assert.deepEqual(json.anyOf, [
			{ type: 'array', items: { type: 'string', pattern: FACT_HASH_EXACT.source } },
			{ type: 'null' }
		]);
	});
});
