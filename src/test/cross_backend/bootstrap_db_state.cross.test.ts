/**
 * Bootstrap write parity: the database each parity backend's keeper bootstrap
 * left — the account and its actor, the keeper and admin grants, the
 * session, the burned lock, the audit row — normalized and compared
 * (`db_state_diff.ts`), with no ledger.
 *
 * Bootstrap is one-shot per backend, and every test's `_testing_reset`
 * reseeds the keeper by SQL, so no other test reads what the real
 * `POST /bootstrap` wrote. The project's `globalSetup` reads it right after
 * each backend's bootstrap, before any test
 * (`global_setup_schema_parity.ts`).
 *
 * @module
 */

import { assert, describe, inject, test } from 'vitest';

import { diff_db_states } from '#lib/testing/cross_backend/db_state_diff.ts';

import './cross_test_types.ts';

describe('bootstrap database state', () => {
	const { a, b } = inject('parity_bootstrap_db_state');

	test('the read holds what a bootstrap writes', () => {
		for (const [side, state] of [
			['a', a],
			['b', b]
		] as const) {
			assert.deepEqual(
				state.tables.bootstrap_lock?.map((row) => row.bootstrapped),
				[true],
				`${side}: the lock`
			);
			assert.strictEqual(state.tables.account?.length, 1, `${side}: the keeper's account`);
			assert.ok(
				state.tables.audit_log?.some((row) => row.event_type === 'bootstrap'),
				`${side}: the bootstrap audit row`
			);
		}
	});

	test('both backends wrote the same', () => {
		const diffs = diff_db_states(a, b);
		assert.deepEqual(
			diffs.map((d) => `${d.path}: a=${JSON.stringify(d.a)} b=${JSON.stringify(d.b)}`),
			[]
		);
	});
});
