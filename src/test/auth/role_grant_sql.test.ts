/**
 * Pins the text of the role-grant liveness predicates in `auth/role_grant_sql.ts`
 * — the same strings the Rust spine's `role_grant_active_sql` and
 * `offer_pending_predicate` build. Behavior is covered by the query suites.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	OFFER_TERMINAL_COLUMNS,
	offer_pending_predicate,
	role_grant_active_sql
} from '#lib/auth/role_grant_sql.ts';

describe('role_grant_active_sql', () => {
	test('qualifies both columns with the alias', () => {
		assert.strictEqual(
			role_grant_active_sql('rg'),
			'rg.revoked_at IS NULL AND (rg.expires_at IS NULL OR rg.expires_at > NOW())'
		);
	});

	test('leaves the columns bare for an empty alias', () => {
		assert.strictEqual(
			role_grant_active_sql(''),
			'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())'
		);
	});
});

describe('offer_pending_predicate', () => {
	test('names every terminal column, in order', () => {
		assert.deepEqual(OFFER_TERMINAL_COLUMNS, [
			'accepted_at',
			'declined_at',
			'retracted_at',
			'superseded_at'
		]);
	});

	test('qualifies every terminal column with the alias', () => {
		assert.strictEqual(
			offer_pending_predicate('o'),
			'o.accepted_at IS NULL AND o.declined_at IS NULL AND o.retracted_at IS NULL AND o.superseded_at IS NULL'
		);
	});

	test('leaves the columns bare for an empty alias', () => {
		assert.strictEqual(
			offer_pending_predicate(''),
			'accepted_at IS NULL AND declined_at IS NULL AND retracted_at IS NULL AND superseded_at IS NULL'
		);
	});
});
