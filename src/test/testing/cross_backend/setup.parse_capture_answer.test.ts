/**
 * `parse_capture_answer` — the parse behind the `capture_*` cross-impl probes:
 * an answer that fails its schema throws, naming the method, and one that
 * passes comes back as the schema's output, not as it came off the wire.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { number, strip_object, string } from '@fuzdev/fuz_schema/schema.ts';

import { parse_capture_answer } from '#lib/testing/cross_backend/setup.ts';

const FuzAnswer = strip_object({ name: string, count: number });
const ZodAnswer = z.object({ name: z.string() }).transform(({ name }) => name.length);

describe('parse_capture_answer', () => {
	test('returns the fuz_schema output, an unknown key stripped', () => {
		const raw = { name: 'a', count: 1, added: true };
		const answer = parse_capture_answer('_testing_x', FuzAnswer, raw);
		assert.deepStrictEqual(answer, { name: 'a', count: 1 });
		assert.notStrictEqual(answer, raw);
	});

	test('returns the Zod output, transformed', () => {
		assert.strictEqual(parse_capture_answer('_testing_x', ZodAnswer, { name: 'abc' }), 3);
	});

	test('throws on an answer that fails its schema, naming the method and the issue', () => {
		assert.throws(
			() => parse_capture_answer('_testing_x', FuzAnswer, { name: 'a', count: 'one' }),
			/^_testing_x: the answer fails its schema:\ncount: /
		);
		assert.throws(
			() => parse_capture_answer('_testing_y', ZodAnswer, { name: 1 }),
			/^_testing_y: the answer fails its schema:/
		);
	});
});
