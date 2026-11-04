/**
 * Tests for sensitivity.ts — `find_schema_sensitivity`, the fail-safe
 * reader of a fuz_schema field's `sensitivity`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	array,
	check,
	lazy,
	min_length,
	message,
	nullable,
	object,
	optional,
	pipe,
	string,
	transform,
	union,
	with_default,
	type Schema
} from '@fuzdev/fuz_schema/schema.ts';

import { find_schema_sensitivity } from '#lib/sensitivity.ts';

const Secret = meta(string, { sensitivity: 'secret' });
const Personal = meta(string, { sensitivity: 'personal' });

describe('find_schema_sensitivity', () => {
	test('undefined when nothing is marked', () => {
		assert.isUndefined(find_schema_sensitivity(string));
		assert.isUndefined(
			find_schema_sensitivity(
				optional(
					pipe(
						string,
						check(() => true)
					)
				)
			)
		);
	});

	test('reads the schema itself and through wrappers', () => {
		for (const schema of [
			Secret,
			optional(Secret),
			nullable(Secret),
			with_default(Secret, 'x'),
			lazy(() => Secret)
		]) {
			assert.strictEqual(find_schema_sensitivity(schema), 'secret');
		}
	});

	test('finds a secret in a later pipe step', () => {
		const schema = pipe(
			string,
			check((v: string) => v.length > 0),
			meta(
				transform((v: string) => v),
				{ sensitivity: 'secret' }
			)
		);
		assert.strictEqual(find_schema_sensitivity(schema), 'secret');
	});

	test('finds a secret in a union option', () => {
		assert.strictEqual(find_schema_sensitivity(union([string, Secret])), 'secret');
	});

	test('the strongest wins, secret over personal, in any order', () => {
		assert.strictEqual(find_schema_sensitivity(Personal), 'personal');
		assert.strictEqual(find_schema_sensitivity(union([Personal, Secret])), 'secret');
		assert.strictEqual(find_schema_sensitivity(union([Secret, Personal])), 'secret');
		assert.strictEqual(
			find_schema_sensitivity(meta(optional(Secret), { sensitivity: 'personal' })),
			'secret'
		);
		assert.strictEqual(
			find_schema_sensitivity(
				pipe(
					Personal,
					meta(
						check(() => true),
						{ sensitivity: 'secret' }
					)
				)
			),
			'secret'
		);
	});

	test('stops at structural schemas', () => {
		assert.isUndefined(find_schema_sensitivity(object({ key: Secret })));
		assert.isUndefined(find_schema_sensitivity(array(Secret)));
	});

	test('a recursive schema ends', () => {
		const Node: Schema = lazy(() => optional(union([Secret, Node])));
		assert.strictEqual(find_schema_sensitivity(Node), 'secret');
	});

	test('a mark inside or outside message is read', () => {
		assert.strictEqual(find_schema_sensitivity(message(Secret, 'required')), 'secret');
		assert.strictEqual(find_schema_sensitivity(message(message(Secret, 'a'), 'b')), 'secret');
		assert.strictEqual(
			find_schema_sensitivity(
				pipe(string, message(meta(min_length(1), { sensitivity: 'secret' }), 'x'))
			),
			'secret'
		);
		assert.strictEqual(
			find_schema_sensitivity(meta(message(string, 'required'), { sensitivity: 'secret' })),
			'secret'
		);
	});
});
