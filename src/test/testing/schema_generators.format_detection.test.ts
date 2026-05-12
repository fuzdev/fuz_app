/**
 * Coverage for `detect_format`'s `anyOf` descent.
 *
 * `.nullish()` / `.nullable()` wrap formats so `z.toJSONSchema` produces
 * `anyOf: [{format: ...}, {type: 'null'}]` instead of a top-level
 * `format`. Without the anyOf descent, format-aware adversarial cases
 * (malformed uuid / email / etc.) silently disappear for any field
 * declared `email.nullish()` — a regression that wouldn't fail any
 * existing test.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import {detect_format} from '$lib/testing/schema_generators.js';

describe('detect_format — anyOf descent', () => {
	test('detects email through .nullish()', () => {
		assert.strictEqual(detect_format(z.email().nullish()), 'email');
	});

	test('detects email through .nullable()', () => {
		assert.strictEqual(detect_format(z.email().nullable()), 'email');
	});

	test('detects email through .optional()', () => {
		assert.strictEqual(detect_format(z.email().optional()), 'email');
	});

	test('detects uuid through .nullish()', () => {
		assert.strictEqual(detect_format(z.uuid().nullish()), 'uuid');
	});

	test('detects uuid through .nullable()', () => {
		assert.strictEqual(detect_format(z.uuid().nullable()), 'uuid');
	});

	test('detects bare uuid (no wrapper)', () => {
		assert.strictEqual(detect_format(z.uuid()), 'uuid');
	});

	test('detects pattern through .nullable()', () => {
		assert.strictEqual(detect_format(z.string().regex(/^abc/).nullable()), 'pattern');
	});

	test('returns null for unconstrained string', () => {
		assert.strictEqual(detect_format(z.string()), null);
	});

	test('returns null for unconstrained string wrapped in .nullish()', () => {
		assert.strictEqual(detect_format(z.string().nullish()), null);
	});
});
