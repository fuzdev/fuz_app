/**
 * `scope_advisory_lock_key` against fixed vectors — the same vectors the Rust
 * twin `fuz_auth::role_grant_offer_queries::scope_advisory_lock_key` is
 * pinned by, so the two spines lock one scope under one key.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	scope_advisory_lock_key,
	SCOPE_ADVISORY_LOCK_CLASS
} from '#lib/auth/role_grant_queries.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

/** `[scope_id, key2]` — shared with the Rust twin's test. */
const VECTORS: ReadonlyArray<readonly [string, number]> = [
	['00000000-0000-0000-0000-000000000000', 0],
	['00000000-0000-0000-0000-000000000001', 1],
	['10000000-0000-0000-0000-000000000000', 268_435_456],
	['ffffffff-0000-0000-0000-000000000000', -1],
	['019a8f2e-4b3c-7d10-9e2f-3a4b5c6d7e8f', -1_998_276_870],
	['019a8f2e-4b3c-7d10-9e2f-3a4b5c6d7e90', -1_998_276_891],
	['f47ac10b-58cc-4372-a567-0e02b2c3d479', -1_156_425_726]
];

test('the class is the ASCII of `fuzs`', () => {
	assert.strictEqual(SCOPE_ADVISORY_LOCK_CLASS, 0x6675_7a73);
	assert.strictEqual(
		String.fromCharCode(
			...[24, 16, 8, 0].map((shift) => (SCOPE_ADVISORY_LOCK_CLASS >> shift) & 0xff)
		),
		'fuzs'
	);
});

test('each scope folds to its vector', () => {
	for (const [scope_id, key] of VECTORS) {
		assert.deepStrictEqual(
			scope_advisory_lock_key(scope_id as Uuid),
			[SCOPE_ADVISORY_LOCK_CLASS, key],
			scope_id
		);
	}
});

test('every word counts: two UUIDv7s of one millisecond differ in the last word alone', () => {
	const [, a] = scope_advisory_lock_key('019a8f2e-4b3c-7d10-9e2f-3a4b5c6d7e8f' as Uuid);
	const [, b] = scope_advisory_lock_key('019a8f2e-4b3c-7d10-9e2f-3a4b5c6d7e90' as Uuid);
	assert.notStrictEqual(a, b);
});

test('the key is an int4 on every input', () => {
	for (const [scope_id] of VECTORS) {
		const [, key] = scope_advisory_lock_key(scope_id as Uuid);
		assert.ok(Number.isInteger(key) && key >= -(2 ** 31) && key < 2 ** 31, scope_id);
	}
});

test('an uppercase UUID folds as its lowercase', () => {
	assert.deepStrictEqual(
		scope_advisory_lock_key('F47AC10B-58CC-4372-A567-0E02B2C3D479' as Uuid),
		scope_advisory_lock_key('f47ac10b-58cc-4372-a567-0e02b2c3d479' as Uuid)
	);
});

test('a malformed id throws', () => {
	for (const bad of [
		'',
		'not-a-uuid',
		'019a8f2e-4b3c-7d10-9e2f-3a4b5c6d7e8',
		'g47ac10b-58cc-4372-a567-0e02b2c3d479'
	]) {
		assert.throws(() => scope_advisory_lock_key(bad as Uuid), /not a UUID/, bad);
	}
});
