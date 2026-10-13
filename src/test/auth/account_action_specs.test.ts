/**
 * Tests for `account_action_specs.ts` — the length cap on
 * `account_token_create`'s `name`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { API_TOKEN_NAME_LENGTH_MAX, TokenCreateInput } from '#lib/auth/account_action_specs.ts';

const base = { scope: { kind: 'full' }, lifetime: { kind: 'eternal' } } as const;

describe('TokenCreateInput name', () => {
	test('defaults when omitted', () => {
		const parsed = TokenCreateInput.safeParse(base);
		assert.ok(parsed.success);
		assert.strictEqual(parsed.data.name, 'CLI token');
	});

	test('admits a name at the cap and refuses one past it', () => {
		const at_cap = TokenCreateInput.safeParse({
			...base,
			name: 'a'.repeat(API_TOKEN_NAME_LENGTH_MAX)
		});
		assert.ok(at_cap.success);
		assert.strictEqual(at_cap.data.name.length, API_TOKEN_NAME_LENGTH_MAX);
		assert.ok(
			!TokenCreateInput.safeParse({ ...base, name: 'a'.repeat(API_TOKEN_NAME_LENGTH_MAX + 1) })
				.success
		);
	});

	test('counts UTF-16 code units, so an astral character costs two', () => {
		const astral = '\u{1F600}';
		// the cap is odd: the largest whole number of astral characters, plus one unit
		const at_cap = astral.repeat((API_TOKEN_NAME_LENGTH_MAX - 1) / 2) + 'a';
		assert.strictEqual(at_cap.length, API_TOKEN_NAME_LENGTH_MAX);
		assert.ok(TokenCreateInput.safeParse({ ...base, name: at_cap }).success);
		assert.ok(!TokenCreateInput.safeParse({ ...base, name: at_cap + 'a' }).success);
		assert.ok(
			!TokenCreateInput.safeParse({
				...base,
				name: astral.repeat((API_TOKEN_NAME_LENGTH_MAX + 1) / 2)
			}).success
		);
	});
});
