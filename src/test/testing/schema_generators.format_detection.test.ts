/**
 * Coverage for `detect_format`'s `anyOf` descent.
 *
 * `nullable` wraps formats so the JSON Schema writer produces
 * `anyOf: [{format: ...}, {type: 'null'}]` instead of a top-level
 * `format`. Without the anyOf descent, format-aware adversarial cases
 * (malformed uuid / pattern / etc.) silently disappear for any field
 * declared `nullable(Uuid)` — a regression that wouldn't fail any
 * existing test.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { nullable, optional, pipe, regex, string } from '@fuzdev/fuz_schema/schema.ts';

import { detect_format } from '#lib/testing/schema_generators.ts';
import { Email, Uuid } from '#lib/primitive_schemas.ts';

describe('detect_format — anyOf descent', () => {
	test('detects the email pattern through optional(nullable(..))', () => {
		assert.strictEqual(detect_format(optional(nullable(Email))), 'pattern');
	});

	test('detects the email pattern through nullable', () => {
		assert.strictEqual(detect_format(nullable(Email)), 'pattern');
	});

	test('detects the email pattern through optional', () => {
		assert.strictEqual(detect_format(optional(Email)), 'pattern');
	});

	test('detects uuid through optional(nullable(..))', () => {
		assert.strictEqual(detect_format(optional(nullable(Uuid))), 'uuid');
	});

	test('detects uuid through nullable', () => {
		assert.strictEqual(detect_format(nullable(Uuid)), 'uuid');
	});

	test('detects bare uuid (no wrapper)', () => {
		assert.strictEqual(detect_format(Uuid), 'uuid');
	});

	test('detects pattern through nullable', () => {
		assert.strictEqual(detect_format(nullable(pipe(string, regex(/^abc/)))), 'pattern');
	});

	test('returns null for unconstrained string', () => {
		assert.strictEqual(detect_format(string), null);
	});

	test('returns null for unconstrained string wrapped in optional(nullable(..))', () => {
		assert.strictEqual(detect_format(optional(nullable(string))), null);
	});
});
