/**
 * Tests for the hash schemas `Blake3Hash` and `FactHashSchema`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';
import { array as s_array, nullable as s_nullable, parse } from '@fuzdev/fuz_schema/schema.ts';
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
	test('parse refuses a malformed value', () => {
		assert.isFalse(parse(FactHashSchema, 'blake3:nope').ok);
	});

	test('parse round-trips a well-formed hash unchanged', () => {
		const raw = FACT_HASH_PREFIX + 'a'.repeat(64);
		const result = parse(FactHashSchema, raw);
		assert.ok(result.ok);
		assert.strictEqual(result.value, raw);
	});

	test('agrees with is_fact_hash, and with the verdicts the Zod form gave', () => {
		// [input, the verdict the earlier Zod form gave, frozen]
		const cases: Array<[string, boolean]> = [
			[HASH_A, true],
			[FACT_HASH_PREFIX + 'a'.repeat(63), false],
			[FACT_HASH_PREFIX + 'a'.repeat(65), false],
			[HASH_A + '\n', false],
			['sha256:' + 'a'.repeat(64), false],
			[FACT_HASH_PREFIX + 'A'.repeat(64), false],
			['a'.repeat(64), false],
			[`see ${HASH_A} here`, false],
			['', false]
		];
		for (const [c, expected] of cases) {
			assert.strictEqual(parse(FactHashSchema, c).ok, expected, c);
			assert.strictEqual(is_fact_hash(c), expected, c);
		}
	});

	test('output is fuz_util FactHash', () => {
		const result = parse(FactHashSchema, HASH_A);
		assert.ok(result.ok);
		const parsed: FactHash = result.value;
		assert.strictEqual(parsed, HASH_A);
	});

	test('keeps the regex in its JSON Schema', () => {
		const json = to_json_schema(s_nullable(s_array(FactHashSchema)), { io: 'output' });
		assert.deepEqual(json.anyOf, [
			{ type: 'array', items: { type: 'string', pattern: FACT_HASH_EXACT.source } },
			{ type: 'null' }
		]);
	});
});
