/**
 * `parse_capture_answer` — the parse behind the `capture_*` cross-impl probes:
 * an answer that fails its schema throws, naming the method, and one that
 * passes comes back as the schema's output, not as it came off the wire.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { number, pipe, strip_object, string, transform } from '@fuzdev/fuz_schema/schema.ts';

import { parse_capture_answer } from '#lib/testing/cross_backend/setup.ts';

const StrippedAnswer = strip_object({ name: string, count: number });
const LengthAnswer = pipe(
	strip_object({ name: string }),
	transform(({ name }: { name: string }) => name.length)
);

describe('parse_capture_answer', () => {
	test('returns the schema output, an unknown key stripped', () => {
		const raw = { name: 'a', count: 1, added: true };
		const answer = parse_capture_answer('_testing_x', StrippedAnswer, raw);
		assert.deepStrictEqual(answer, { name: 'a', count: 1 });
		assert.notStrictEqual(answer, raw);
	});

	test('returns the transformed output', () => {
		assert.strictEqual(parse_capture_answer('_testing_x', LengthAnswer, { name: 'abc' }), 3);
	});

	test('throws on an answer that fails its schema, naming the method and the issue', () => {
		assert.throws(
			() => parse_capture_answer('_testing_x', StrippedAnswer, { name: 'a', count: 'one' }),
			/^_testing_x: the answer fails its schema:\ncount: /
		);
		assert.throws(
			() => parse_capture_answer('_testing_y', LengthAnswer, { name: 1 }),
			/^_testing_y: the answer fails its schema:/
		);
	});
});
