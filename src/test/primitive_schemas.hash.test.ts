/**
 * Tests for the hash schemas `Blake3Hash` (fuz_schema) and `FactHashSchema` (Zod).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { parse } from '@fuzdev/fuz_schema/schema.ts';
import {
	FACT_HASH_EXACT,
	FACT_HASH_PREFIX,
	is_fact_hash,
	type FactHash
} from '@fuzdev/fuz_util/hash_schemas.ts';

import { FactHashSchema } from '#lib/primitive_schemas.ts';
import { Blake3Hash } from '#lib/primitive_schemas_fuz.ts';

/** A syntactically valid (if not content-derived) fact hash literal. */
const HASH_A = (FACT_HASH_PREFIX + 'a'.repeat(64)) as FactHash;

describe('Blake3Hash', () => {
	test('accepts all-zeros', () => {
		assert.strictEqual(parse(Blake3Hash, '0'.repeat(64)).ok, true);
	});

	test('accepts all-f', () => {
		assert.strictEqual(parse(Blake3Hash, 'f'.repeat(64)).ok, true);
	});

	test('rejects too short', () => {
		assert.strictEqual(parse(Blake3Hash, 'abcdef').ok, false);
	});

	test('rejects too long', () => {
		assert.strictEqual(parse(Blake3Hash, 'a'.repeat(65)).ok, false);
	});

	test('rejects uppercase hex', () => {
		assert.strictEqual(parse(Blake3Hash, 'A'.repeat(64)).ok, false);
	});

	test('rejects non-hex characters', () => {
		assert.strictEqual(parse(Blake3Hash, 'g'.repeat(64)).ok, false);
	});

	test('rejects empty string', () => {
		assert.strictEqual(parse(Blake3Hash, '').ok, false);
	});

	test('rejects 63 chars (off-by-one short)', () => {
		assert.strictEqual(parse(Blake3Hash, 'a'.repeat(63)).ok, false);
	});

	test('rejects 65 chars (off-by-one long)', () => {
		assert.strictEqual(parse(Blake3Hash, 'a'.repeat(65)).ok, false);
	});

	test('rejects UUID format', () => {
		// Regression: session IDs were validated as UUIDs but are blake3 hashes
		assert.strictEqual(parse(Blake3Hash, '00000000-0000-4000-8000-000000000040').ok, false);
	});

	test('rejects mixed case hex', () => {
		const mixed = 'aAbBcCdDeEfF'.repeat(5) + 'aAbB';
		assert.strictEqual(mixed.length, 64);
		assert.strictEqual(parse(Blake3Hash, mixed).ok, false);
	});

	test('rejects leading whitespace', () => {
		assert.strictEqual(parse(Blake3Hash, ' ' + 'a'.repeat(64)).ok, false);
	});

	test('rejects trailing whitespace', () => {
		assert.strictEqual(parse(Blake3Hash, 'a'.repeat(64) + ' ').ok, false);
	});

	test('rejects embedded spaces', () => {
		assert.strictEqual(parse(Blake3Hash, 'a'.repeat(32) + ' ' + 'a'.repeat(31)).ok, false);
	});

	test('rejects number', () => {
		assert.strictEqual(parse(Blake3Hash, 12345).ok, false);
	});

	test('rejects null', () => {
		assert.strictEqual(parse(Blake3Hash, null).ok, false);
	});

	test('rejects undefined', () => {
		assert.strictEqual(parse(Blake3Hash, undefined).ok, false);
	});

	test('rejects boolean', () => {
		assert.strictEqual(parse(Blake3Hash, true).ok, false);
	});

	test('rejects the `blake3:`-prefixed wire form (that is FactHashSchema)', () => {
		assert.strictEqual(parse(Blake3Hash, HASH_A).ok, false);
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
