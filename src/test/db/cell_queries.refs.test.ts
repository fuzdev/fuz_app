/**
 * `derive_cell_refs` — the exact whole-string fact-hash walk behind
 * `cell.refs`. Twin of the Rust `fuz_cell` `extract_refs` unit cases.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { derive_cell_refs } from '#lib/db/cell_queries.ts';

/** A well-formed fact hash whose digest is `c` repeated. */
const hash_of = (c: string): string => `blake3:${c.repeat(64)}`;

describe('derive_cell_refs', () => {
	test('walks nested values, dedupes, and sorts', () => {
		const [a, b, c] = [hash_of('a'), hash_of('b'), hash_of('c')];
		assert.deepEqual(
			derive_cell_refs({
				kind_label: 'doc',
				cover: c,
				nested: { attachments: [b, 'not-a-ref', a, b, { again: c }] },
				count: 3,
				flag: true,
				none: null
			}),
			[a, b, c]
		);
	});

	test('returns null, not [], when there are no refs', () => {
		assert.strictEqual(derive_cell_refs({ n: 1, s: 'plain string' }), null);
		assert.strictEqual(derive_cell_refs('plain string'), null);
		assert.strictEqual(derive_cell_refs([]), null);
	});

	test('takes whole exact hashes only', () => {
		const exact = `blake3:${'0123456789abcdef'.repeat(4)}`;
		assert.deepEqual(derive_cell_refs({ f: exact }), [exact]);
		for (const not_a_ref of [
			// a short or malformed digest
			'blake3:zz',
			'blake3:',
			`blake3:${'a'.repeat(63)}`,
			`blake3:${'a'.repeat(65)}`,
			// uppercase hex
			`blake3:${'0123456789ABCDEF'.repeat(4)}`,
			// a hash inside prose or markup, or wrapped in whitespace
			`see ${exact} for details`,
			`![cover](${exact})`,
			` ${exact}`,
			`${exact}\n`,
			// two hashes run together
			`${exact}${exact}`,
			// another algorithm token
			`sha256:${'a'.repeat(64)}`
		]) {
			assert.strictEqual(derive_cell_refs({ f: not_a_ref }), null, JSON.stringify(not_a_ref));
		}
	});

	test('skips object keys', () => {
		const exact = hash_of('d');
		assert.strictEqual(derive_cell_refs({ [exact]: 1 }), null);
		assert.deepEqual(derive_cell_refs({ [exact]: exact }), [exact]);
	});
});
