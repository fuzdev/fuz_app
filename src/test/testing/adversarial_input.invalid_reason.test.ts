/**
 * The reason a generated adversarial case owes — `InputTestCase.field` and
 * `expected_invalid_reason`, which the in-process and cross-process RPC
 * params suites assert against.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import {
	expected_invalid_reason,
	generate_input_test_cases
} from '#lib/testing/adversarial_input_cases.ts';
import { generate_rpc_params_test_cases } from '#lib/testing/rpc_envelope_cases.ts';
import {
	ERROR_TOKEN_LIFETIME_INVALID,
	ERROR_TOKEN_SCOPE_INVALID,
	TokenCreateInput
} from '#lib/auth/account_action_specs.ts';
import { AuditLogListInput } from '#lib/auth/admin_action_specs.ts';
import {
	ERROR_LIMIT_INVALID,
	ERROR_OFFSET_INVALID,
	ERROR_OUTCOME_INVALID,
	ERROR_SINCE_SEQ_INVALID
} from '#lib/http/error_schemas.ts';

/** Each case's label → the reason it owes. */
const owed = (input: z.ZodType): Map<string, string | undefined> =>
	new Map(
		generate_rpc_params_test_cases(input).map((tc) => [
			tc.label,
			expected_invalid_reason(input, tc)
		])
	);

describe('expected_invalid_reason', () => {
	test('every per-field case names its field, and whole-body cases name none', () => {
		const Input = z.strictObject({ a: z.string().min(1), b: z.number().int().min(0) });
		for (const tc of generate_input_test_cases(Input)) {
			if (tc.label === 'non-object body (array)' || tc.label === 'extra unknown key') {
				assert.strictEqual(tc.field, undefined, tc.label);
			} else {
				assert.ok(tc.field === 'a' || tc.field === 'b', tc.label);
				assert.ok(tc.label.includes(tc.field), tc.label);
			}
		}
	});

	test('a declared field owes its reason on every case kind, an undeclared one none', () => {
		const Input = z.strictObject({
			count: z.number().int().min(1).max(5).meta({ invalid_reason: 'count_invalid' }),
			id: z.uuid().optional(),
			mode: z.enum(['a', 'b']).nullish().meta({ invalid_reason: 'mode_invalid' })
		});
		const cases = owed(Input);
		assert.strictEqual(cases.get('extra unknown key'), undefined);
		assert.strictEqual(cases.get('missing: count'), 'count_invalid');
		assert.strictEqual(cases.get('null: count'), 'count_invalid');
		assert.strictEqual(cases.get('wrong type: count (string instead of number)'), 'count_invalid');
		assert.strictEqual(cases.get('below minimum: count (0)'), 'count_invalid');
		assert.strictEqual(cases.get('above maximum: count (6)'), 'count_invalid');
		assert.strictEqual(cases.get('wrong type: mode (number instead of enum)'), 'mode_invalid');
		assert.strictEqual(cases.get('format: id (malformed uuid)'), undefined);
		// and the owed reason is what the schema's own failure resolves to
		for (const tc of generate_rpc_params_test_cases(Input)) {
			assert.ok(!Input.safeParse(tc.body).success, tc.label);
		}
	});

	test('audit_log_list owes the Rust spine its declared reasons', () => {
		const cases = owed(AuditLogListInput);
		assert.strictEqual(
			cases.get('wrong type: limit (string instead of number)'),
			ERROR_LIMIT_INVALID
		);
		assert.strictEqual(
			cases.get('wrong type: offset (string instead of number)'),
			ERROR_OFFSET_INVALID
		);
		assert.strictEqual(
			cases.get('wrong type: since_seq (string instead of number)'),
			ERROR_SINCE_SEQ_INVALID
		);
		assert.strictEqual(
			cases.get('wrong type: outcome (number instead of enum)'),
			ERROR_OUTCOME_INVALID
		);
		assert.strictEqual(cases.get('format: account_id (malformed uuid)'), undefined);
		assert.strictEqual(cases.get('format: acting (malformed uuid)'), undefined);
		assert.strictEqual(cases.get('extra unknown key'), undefined);
	});

	test('account_token_create owes its scope and lifetime reasons', () => {
		const cases = owed(TokenCreateInput);
		assert.strictEqual(cases.get('missing: scope'), ERROR_TOKEN_SCOPE_INVALID);
		assert.strictEqual(cases.get('null: scope'), ERROR_TOKEN_SCOPE_INVALID);
		assert.strictEqual(cases.get('missing: lifetime'), ERROR_TOKEN_LIFETIME_INVALID);
		assert.strictEqual(cases.get('null: lifetime'), ERROR_TOKEN_LIFETIME_INVALID);
		assert.strictEqual(cases.get('null: name'), undefined);
	});
});
