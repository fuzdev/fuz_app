/**
 * Tests for `testing/schema_generators.ts` — branded-string synthesis.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import {generate_valid_body} from '$lib/testing/schema_generators.js';
import {
	account_session_revoke_action_spec,
	account_token_revoke_action_spec,
} from '$lib/auth/account_action_specs.js';

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
