/**
 * Tests for `auth/token_lifetime.ts` — the strict `lifetime` union and its
 * expiry resolution.
 *
 * The acceptance/rejection table is a **cross-spine contract**: the Rust
 * `parse_token_lifetime_param` unit tests pin the same rows
 * (`fuz_auth/src/account_action_specs.rs`), and the wire-level agreement is
 * gated by the `token_lifetime` cross suite — this file keeps the TS side's
 * table explicit so a Zod-shape edit can't silently diverge from the
 * hand-rolled Rust parser.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	TOKEN_TTL_DAYS_MAX,
	TokenLifetimeInput,
	token_lifetime_to_expires_at
} from '$lib/auth/token_lifetime.ts';

describe('TokenLifetimeInput', () => {
	test('parses the strict union', () => {
		assert.deepStrictEqual(TokenLifetimeInput.parse({ kind: 'eternal' }), { kind: 'eternal' });
		assert.deepStrictEqual(TokenLifetimeInput.parse({ kind: 'ttl', days: 30 }), {
			kind: 'ttl',
			days: 30
		});
		// `z.number().int()` accepts integral floats — the Rust parser mirrors
		// this (a JSON `30.0` parses to 30 on both spines)
		assert.deepStrictEqual(TokenLifetimeInput.parse({ kind: 'ttl', days: 30.0 }), {
			kind: 'ttl',
			days: 30
		});
		assert.strictEqual(
			TokenLifetimeInput.parse({ kind: 'ttl', days: TOKEN_TTL_DAYS_MAX }).kind,
			'ttl'
		);
	});

	test('rejections match the Rust parser row for row', () => {
		const rejected: Array<unknown> = [
			undefined, // missing
			null, // wrong type
			'eternal', // not an object
			{}, // no kind
			{ kind: 'forever' }, // unknown kind
			{ kind: 'eternal', days: 5 }, // strict: unknown key
			{ kind: 'ttl' }, // no days
			{ kind: 'ttl', days: 0 }, // below min
			{ kind: 'ttl', days: TOKEN_TTL_DAYS_MAX + 1 }, // above max
			{ kind: 'ttl', days: 5.5 }, // non-integer
			{ kind: 'ttl', days: '30' }, // string
			{ kind: 'ttl', days: 1, and: 2 } // strict: unknown key
		];
		for (const value of rejected) {
			assert.isFalse(
				TokenLifetimeInput.safeParse(value).success,
				`must reject ${JSON.stringify(value)}`
			);
		}
	});
});

describe('token_lifetime_to_expires_at', () => {
	test('eternal resolves to null', () => {
		assert.strictEqual(token_lifetime_to_expires_at({ kind: 'eternal' }), null);
	});

	test('ttl resolves to exactly now + days', () => {
		const now = new Date('2026-08-29T00:00:00Z');
		const expires = token_lifetime_to_expires_at({ kind: 'ttl', days: 30 }, now);
		assert.ok(expires);
		assert.strictEqual(expires.toISOString(), '2026-09-28T00:00:00.000Z');
	});
});
