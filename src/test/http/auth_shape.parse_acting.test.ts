/**
 * Unit tests for `parse_acting`, the raw `acting` selector read both
 * dispatchers and the WS upgrade share. Its grammar is the fuz_schema
 * `ActingActor`'s, so the uppercase max UUID reads as a selector, as on the
 * Rust spine.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { parse_acting } from '#lib/http/auth_shape.ts';

describe('parse_acting', () => {
	test('a UUID reads as the selector, lowercased', () => {
		assert.strictEqual(
			parse_acting('f81d4fae-7dec-41d0-a765-00a0c91e6bf6'),
			'f81d4fae-7dec-41d0-a765-00a0c91e6bf6'
		);
		assert.strictEqual(
			parse_acting('F81D4FAE-7DEC-41D0-A765-00A0C91E6BF6'),
			'f81d4fae-7dec-41d0-a765-00a0c91e6bf6'
		);
	});

	test('the nil and the max UUID read as selectors, the max in any case', () => {
		assert.strictEqual(
			parse_acting('00000000-0000-0000-0000-000000000000'),
			'00000000-0000-0000-0000-000000000000'
		);
		for (const max of [
			'ffffffff-ffff-ffff-ffff-ffffffffffff',
			'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
			'ffffffff-FFFF-ffff-FFFF-ffffffffffff'
		]) {
			assert.strictEqual(parse_acting(max), 'ffffffff-ffff-ffff-ffff-ffffffffffff', max);
		}
	});

	test('an absent or malformed selector reads as omitted', () => {
		for (const value of [
			undefined,
			null,
			'',
			'not-a-uuid',
			'3f8a1c2e12344abc9def0123456789ab',
			'urn:uuid:3f8a1c2e-1234-4abc-9def-0123456789ab',
			'00000000-0000-0000-0000-000000000001',
			'"f81d4fae-7dec-41d0-a765-00a0c91e6bf6"',
			123,
			['f81d4fae-7dec-41d0-a765-00a0c91e6bf6']
		]) {
			assert.isUndefined(parse_acting(value), JSON.stringify(value));
		}
	});
});
