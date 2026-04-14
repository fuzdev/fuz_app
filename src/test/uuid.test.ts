/**
 * Tests for uuid.ts — branded UUID schema and factory.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {create_uuid, Uuid, UuidWithDefault} from '$lib/uuid.js';

describe('create_uuid', () => {
	test('returns a valid UUID v4 string', () => {
		const id = create_uuid();
		assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	test('returns unique values on each call', () => {
		const ids = new Set(Array.from({length: 100}, () => create_uuid()));
		assert.strictEqual(ids.size, 100);
	});
});

describe('Uuid schema', () => {
	test('accepts valid UUIDs', () => {
		const result = Uuid.safeParse(create_uuid());
		assert.ok(result.success);
	});

	test('rejects non-UUID strings', () => {
		const result = Uuid.safeParse('not-a-uuid');
		assert.ok(!result.success);
	});

	test('rejects empty string', () => {
		const result = Uuid.safeParse('');
		assert.ok(!result.success);
	});
});

describe('UuidWithDefault', () => {
	test('generates a default UUID when parsing undefined', () => {
		const result = UuidWithDefault.parse(undefined);
		assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	test('accepts provided UUID', () => {
		const id = create_uuid();
		const result = UuidWithDefault.parse(id);
		assert.strictEqual(result, id);
	});
});
