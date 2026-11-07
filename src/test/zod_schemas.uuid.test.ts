/**
 * Tests for `ZodUuid`, the Zod form of `Uuid`, `ZodUuidWithDefault`, and `create_uuid`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';

import { create_uuid } from '#lib/primitive_schemas.ts';
import { ZodUuid, ZodUuidWithDefault } from '#lib/zod_schemas.ts';

/** The shape `crypto.randomUUID()` produces — a lowercase version-4 UUID. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('create_uuid', () => {
	test('returns a valid UUID v4 string', () => {
		assert.match(create_uuid(), UUID_V4);
	});

	test('returns unique values on each call', () => {
		const ids = new Set(Array.from({ length: 100 }, () => create_uuid()));
		assert.strictEqual(ids.size, 100);
	});

	test('round-trips through the ZodUuid schema', () => {
		const id = create_uuid();
		assert.equal(ZodUuid.parse(id), id);
	});
});

describe('ZodUuid schema', () => {
	test('parses a valid UUID', () => {
		const value = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
		assert.equal(ZodUuid.parse(value), value);
	});

	test('rejects a malformed UUID', () => {
		assert.equal(ZodUuid.safeParse('not-a-uuid').success, false);
		assert.equal(ZodUuid.safeParse('g81d4fae-7dec-11d0-a765-00a0c91e6bf6').success, false);
		assert.equal(ZodUuid.safeParse('').success, false);
	});

	test('rejects the urn namespace prefix', () => {
		assert.equal(ZodUuid.safeParse('urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6').success, false);
	});

	test('rejects non-string input', () => {
		assert.equal(ZodUuid.safeParse(123).success, false);
		assert.equal(ZodUuid.safeParse(null).success, false);
		assert.equal(ZodUuid.safeParse(undefined).success, false);
	});

	test('outputs lowercase, whatever the input case', () => {
		assert.strictEqual(
			ZodUuid.parse('F81D4FAE-7DEC-11D0-A765-00A0C91E6BF6'),
			'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'
		);
		assert.strictEqual(
			ZodUuid.parse('f81D4fae-7DEC-11d0-A765-00a0C91e6bf6'),
			'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'
		);
		assert.strictEqual(
			ZodUuid.parse('00000000-0000-0000-0000-000000000000'),
			'00000000-0000-0000-0000-000000000000'
		);
		// the max UUID in any case, as RFC 9562 §4 and the Rust spine read it,
		// where `z.uuid()` takes it in lowercase only
		for (const max of [
			'ffffffff-ffff-ffff-ffff-ffffffffffff',
			'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
			'ffffffff-FFFF-ffff-FFFF-ffffffffffff'
		]) {
			assert.strictEqual(ZodUuid.parse(max), 'ffffffff-ffff-ffff-ffff-ffffffffffff', max);
		}
		assert.isFalse(z.uuid().safeParse('FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF').success);
	});

	test('a refusal is a uuid format issue', () => {
		const result = ZodUuid.safeParse('not-a-uuid');
		assert(!result.success);
		assert.strictEqual(result.error.issues.length, 1);
		const [issue] = result.error.issues;
		assert.strictEqual(issue!.code, 'invalid_format');
		assert.strictEqual((issue as { format?: string }).format, 'uuid');
	});

	test('its JSON schema is a uuid string, z.uuid()’s but for the pattern', () => {
		// the lowercasing is an overwrite, not a transform: the rendered schema
		// is the one `z.uuid()` renders, input and output alike, but for the
		// pattern, which takes the max UUID in any case
		for (const io of ['input', 'output'] as const) {
			const { pattern, ...rest } = z.toJSONSchema(ZodUuid, { io });
			const { pattern: bare_pattern, ...bare_rest } = z.toJSONSchema(z.uuid(), { io });
			assert.deepEqual(rest, bare_rest, io);
			assert.strictEqual(rest.format, 'uuid', io);
			assert(typeof pattern === 'string');
			assert(typeof bare_pattern === 'string');
			assert.notStrictEqual(pattern, bare_pattern, io);
		}
	});
});

describe('ZodUuidWithDefault', () => {
	test('generates a default UUID when parsing undefined', () => {
		assert.match(ZodUuidWithDefault.parse(undefined), UUID_V4);
	});

	test('preserves an explicit value', () => {
		const id = create_uuid();
		assert.strictEqual(ZodUuidWithDefault.parse(id), id);
	});

	test('rejects an explicit invalid value', () => {
		assert.equal(ZodUuidWithDefault.safeParse('nope').success, false);
	});

	test('produces distinct defaults across parses', () => {
		assert.notEqual(ZodUuidWithDefault.parse(undefined), ZodUuidWithDefault.parse(undefined));
	});
});
