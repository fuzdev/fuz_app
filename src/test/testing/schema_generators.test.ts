/**
 * Tests for `testing/schema_generators.ts` — branded-string synthesis.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import {generate_valid_body} from '$lib/testing/schema_generators.ts';
import {
	account_session_revoke_action_spec,
	account_token_revoke_action_spec,
} from '$lib/auth/account_action_specs.ts';

describe('generate_valid_body — branded-string synthesis', () => {
	test('satisfies blake3 session_id pattern (account_session_revoke)', () => {
		const body = generate_valid_body(account_session_revoke_action_spec.input);
		assert.ok(body, 'expected a body');
		const parsed = account_session_revoke_action_spec.input.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('satisfies tok_ token_id pattern (account_token_revoke)', () => {
		const body = generate_valid_body(account_token_revoke_action_spec.input);
		assert.ok(body, 'expected a body');
		const parsed = account_token_revoke_action_spec.input.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('satisfies a bare fixed-length hex pattern', () => {
		const schema = z.strictObject({digest: z.string().regex(/^[0-9a-f]{64}$/)});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('satisfies a bare prefix-lengthed slug pattern', () => {
		const schema = z.strictObject({id: z.string().regex(/^foo_[A-Za-z0-9_-]{8}$/)});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});
});

describe('generate_valid_body — union synthesis', () => {
	test('picks the first variant of a plain union of objects', () => {
		// Mirrors the shape of a target/config field — a union of two object
		// variants where the first variant satisfies its own schema once its
		// required string fields are filled.
		const Remote = z.strictObject({
			local: z.literal(false).optional(),
			host: z.string().min(1),
			user: z.string().min(1),
		});
		const Local = z.strictObject({local: z.literal(true)});
		const schema = z.strictObject({target: z.union([Remote, Local])});

		const body = generate_valid_body(schema);
		assert.ok(body, 'expected a body');
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('picks the first variant of a union of primitives', () => {
		const schema = z.strictObject({val: z.union([z.string(), z.number()])});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('synthesizes a union nested inside another object field', () => {
		const Inner = z.strictObject({
			cfg: z.union([
				z.strictObject({mode: z.literal('a').optional(), label: z.string().min(1)}),
				z.strictObject({mode: z.literal('b').optional(), n: z.number()}),
			]),
		});
		const schema = z.strictObject({wrapper: Inner});

		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('union wrapped in .optional() at the field level still synthesizes when required', () => {
		// Optional unwrap happens before the union case is reached.
		const schema = z.strictObject({
			target: z.union([
				z.strictObject({host: z.string().min(1)}),
				z.strictObject({local: z.literal(true)}),
			]),
		});

		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('synthesizes a discriminated union whose first variant has a required literal discriminator', () => {
		// Without `case 'literal':` in generate_valid_value, the required
		// `kind: z.literal('local')` field on the first variant falls through
		// to `'test_value'`, which fails the literal check and breaks parse.
		const schema = z.strictObject({
			target: z.discriminatedUnion('kind', [
				z.strictObject({kind: z.literal('local'), value: z.string().min(1)}),
				z.strictObject({kind: z.literal('remote'), host: z.string().min(1)}),
			]),
		});

		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('synthesizes a bare z.literal() field', () => {
		const schema = z.strictObject({mode: z.literal('strict')});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
		assert.strictEqual((parsed.data as {mode: string}).mode, 'strict');
	});
});
