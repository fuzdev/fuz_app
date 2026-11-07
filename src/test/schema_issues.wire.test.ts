/**
 * Tests for `to_wire_issues` and `WireIssue` in `schema_issues.ts` — schema
 * issues as the one shape an error response carries.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import * as s from '@fuzdev/fuz_schema/schema.ts';
import { parse, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import { to_wire_issues, WireIssue } from '#lib/schema_issues.ts';

const wire_of = (schema: AnySchema, input: unknown): Array<WireIssue> => {
	const result = parse(schema, input);
	assert.ok(!result.ok, `refused: ${String(input)}`);
	return to_wire_issues(result.issues, input);
};

describe('to_wire_issues of fuz_schema issues', () => {
	test('passes the fields through, with format_issue as the message', () => {
		const schema = s.object({ a: s.object({ b: s.array(s.number) }) });
		const input = { a: { b: [1, 'x'] }, z: null };
		const result = s.parse(schema, input);
		assert.ok(!result.ok);
		const wire = to_wire_issues(result.issues, input);
		assert.deepStrictEqual(wire, [
			{
				kind: 'number',
				path: ['a', 'b', 1],
				expected: 'number',
				received: 'string',
				message: 'a.b.1: expected number, received string'
			},
			{
				kind: 'unknown_key',
				path: ['z'],
				expected: 'no unknown keys',
				received: 'null',
				message: 'z: expected no unknown keys, received null'
			}
		]);
		for (const [i, w] of wire.entries()) {
			assert.strictEqual(w.message, s.format_issue(result.issues[i]!));
			assert.ok(s.is(WireIssue, w));
		}
	});

	test('a message set by `message` is the text', () => {
		const schema = s.object({ a: s.message(s.string, 'need text') });
		const wire = wire_of(schema, { a: 1 });
		assert.strictEqual(wire.length, 1);
		assert.strictEqual(wire[0]!.message, s.format_issue({ ...wire[0]!, message: 'need text' }));
		assert.strictEqual(wire[0]!.message, 'a: need text');
	});

	test('the wire fields come in the canonical order', () => {
		const [wire] = wire_of(s.string, 1);
		assert.deepStrictEqual(Object.keys(wire!), ['kind', 'path', 'expected', 'received', 'message']);
	});

	test('to_wire_issues writes a symbol path segment as its text', () => {
		const key = Symbol('k');
		const issue = {
			kind: 'string',
			path: [key, 'a', 0],
			expected: 'string',
			received: 'number'
		} as unknown as s.SchemaIssue;
		const [wire] = to_wire_issues([issue], {});
		assert.deepStrictEqual(wire!.path, ['Symbol(k)', 'a', 0]);
		assert.doesNotThrow(() => JSON.stringify(wire));
	});

	test('WireIssue admits a field a newer server adds', () => {
		const [wire] = wire_of(s.string, 1);
		assert.ok(s.is(WireIssue, { ...wire!, added: true }));
	});
});
