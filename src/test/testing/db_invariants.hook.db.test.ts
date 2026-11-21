/**
 * The per-test invariant check the in-process setup registers: a test that
 * leaves a broken invariant fails through the hook though its body passed —
 * flagged `test.fails`, so the run passes only when the hook throws — and the
 * setup's `exclude_db_invariants` and the fixture's `assert_db_invariants`
 * behave as documented.
 *
 * @module
 */

import { assert, onTestFinished, test } from 'vitest';

import type { Db } from '#lib/db/db.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import { default_in_process_setup } from '#lib/testing/cross_backend/in_process_setup.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import type { SetupTest } from '#lib/testing/cross_backend/setup.ts';
import type { DbInvariantExclusions } from '#lib/testing/db_invariants.ts';

/** A setup over the spine's surface, handing back the app's database too. */
const create_setup = (
	exclude_db_invariants?: DbInvariantExclusions
): { setup_test: SetupTest; get_db: () => Db } => {
	let db: Db | null = null;
	const setup_test = default_in_process_setup({
		session_options: spine_session_options,
		roles: [ROLE_KEEPER, ROLE_ADMIN],
		// the factory sees the app's database; the fixture exposes none
		audit_factory: (deps) => {
			db = deps.db;
			return create_audit_emitter(deps);
		},
		create_route_specs: create_spine_route_specs,
		rpc_endpoints: spine_rpc_endpoints,
		exclude_db_invariants
	});
	return {
		setup_test,
		get_db: () => {
			assert.ok(db, 'the app was not built');
			return db;
		}
	};
};

/** Tombstone `account_id` by hand, leaving its actor, session and token live. */
const tombstone_by_hand = (db: Db, account_id: string): Promise<unknown> =>
	db.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [account_id]);

const plain = create_setup();

/** The errors the flagged test finished with, read by the test after it. */
let flagged_errors: Array<string> | null = null;

test.fails('a test leaving a tombstone without its cascade fails through the hook', async () => {
	// registered first, so it runs after the setup's hook (they run in stack order)
	onTestFinished(({ task }) => {
		flagged_errors = (task.result?.errors ?? []).map((e) => e.message);
	});
	const fixture = await plain.setup_test();
	const other = await fixture.create_account({ username: 'tombstoned' });
	await tombstone_by_hand(plain.get_db(), other.account.id);
	// the body passes; the check when the test finishes is what fails it
});

test('the flagged test failed on the hook and nothing else', () => {
	assert.ok(flagged_errors, 'the flagged test ran');
	assert.strictEqual(flagged_errors.length, 1, flagged_errors.join('\n'));
	assert.match(flagged_errors[0]!, /^database invariants broken \(in-process\)/);
	assert.include(flagged_errors[0], 'credential_of_tombstoned_account');
	assert.include(flagged_errors[0], 'actor_tombstone_disagrees_with_account');
});

test('a clean test passes the hook', async () => {
	const fixture = await plain.setup_test();
	await fixture.create_account({ username: 'untouched' });
});

test('the fixture checks on demand, against the same exclusions', async () => {
	const fixture = await plain.setup_test();
	const other = await fixture.create_account({ username: 'tombstoned' });
	await fixture.assert_db_invariants();
	await tombstone_by_hand(plain.get_db(), other.account.id);
	let error: unknown = null;
	try {
		await fixture.assert_db_invariants();
	} catch (e) {
		error = e;
	}
	assert.ok(error instanceof Error, 'a broken invariant throws');
	assert.include(error.message, 'credential_of_tombstoned_account');
	assert.include(error.message, 'actor_tombstone_disagrees_with_account');
	// repaired, so the hook passes
	await plain
		.get_db()
		.query(`UPDATE account SET deleted_at = NULL WHERE id = $1`, [other.account.id]);
});

const excluding = create_setup({
	credential_of_tombstoned_account: 'tombstoned by hand in this test',
	actor_tombstone_disagrees_with_account: 'tombstoned by hand in this test'
});

test('an excluded invariant is not checked by the hook', async () => {
	const fixture = await excluding.setup_test();
	const other = await fixture.create_account({ username: 'tombstoned' });
	await tombstone_by_hand(excluding.get_db(), other.account.id);
	await fixture.assert_db_invariants();
});

test('the setup refuses an exclusion without a reason', () => {
	assert.throws(
		() => create_setup({ credential_of_tombstoned_account: '' }),
		/exclude_db_invariants 'credential_of_tombstoned_account' needs a reason/
	);
});
