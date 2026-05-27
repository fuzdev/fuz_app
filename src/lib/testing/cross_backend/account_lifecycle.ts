import '../assert_dev_env.js';

/**
 * Cross-backend parity suite for the account-lifecycle admin verbs:
 * `account_delete` (soft), `account_undelete` (reactivation), and
 * `account_purge` (keeper hard-delete), plus the keeper guard.
 *
 * Like the cell suites, these verbs can't ride the generic
 * `describe_rpc_round_trip_tests`: they're stateful and destructive (a
 * generic round-trip would tombstone the bootstrapped keeper). They
 * live-mount on every spine's RPC path but stay off the declared surface,
 * so this dedicated suite is their cross-impl validator. Every success
 * `result` is parsed against the verb's declared Zod **output** schema, so
 * a TS↔Rust envelope drift fails the assertion.
 *
 * `$lib`-free by contract (relative specifiers only) so it can be imported
 * from the spawnable cross-process test files.
 *
 * @module
 */

import {describe, assert} from 'vitest';

import {
	AccountDeleteOutput,
	AccountUndeleteOutput,
	AccountPurgeOutput,
	AdminAccountListOutput,
	ERROR_CANNOT_DELETE_KEEPER,
} from '../../auth/admin_action_specs.js';
import {test_if} from './capabilities.js';
import {
	cross_rpc_call,
	error_reason,
	expect_output,
	type CellCrossTestOptions,
} from './cell_cross_helpers.js';
import {SPINE_RPC_PATH} from './default_spine_surface.js';

/**
 * Options for the account-lifecycle parity suite. Shares the shape of the
 * cell suites (`setup_test` / `capabilities` / `rpc_path`); reuses
 * `CellCrossTestOptions` rather than minting a structural duplicate.
 */
export type AccountLifecycleCrossTestOptions = CellCrossTestOptions;

export const describe_account_lifecycle_cross_tests = (
	options: AccountLifecycleCrossTestOptions,
): void => {
	const {setup_test, capabilities} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('account lifecycle parity', () => {
		test_if(
			capabilities.account_lifecycle,
			'soft-delete → undelete round-trip (admin)',
			async () => {
				const fixture = await setup_test();
				const victim = await fixture.create_account({username: 'lifecycle_victim'});
				const t = fixture.fresh_transport();
				// Keeper account holds ROLE_ADMIN — its session is admin-capable.
				const admin_headers = fixture.create_session_headers();

				const deleted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'account_delete',
						{account_id: victim.account.id},
						admin_headers,
					),
					AccountDeleteOutput,
				);
				assert.strictEqual(deleted.deleted, true);

				const undeleted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'account_undelete',
						{account_id: victim.account.id},
						admin_headers,
					),
					AccountUndeleteOutput,
				);
				assert.strictEqual(undeleted.undeleted, true);
			},
		);

		test_if(capabilities.account_lifecycle, 'purge (keeper, confirmed)', async () => {
			const fixture = await setup_test();
			const victim = await fixture.create_account({username: 'lifecycle_purge'});
			const t = fixture.fresh_transport({origin: null});
			// Purge is keeper-gated: daemon-token credential, not a session.
			const purged = expect_output(
				await cross_rpc_call(
					t,
					rpc_path,
					'account_purge',
					{account_id: victim.account.id, confirm: true},
					fixture.create_daemon_token_headers(),
				),
				AccountPurgeOutput,
			);
			assert.strictEqual(purged.purged, true);
		});

		test_if(
			capabilities.account_lifecycle,
			'keeper guard: delete + purge refuse the keeper account',
			async () => {
				const fixture = await setup_test();
				const t = fixture.fresh_transport();

				const del = await cross_rpc_call(
					t,
					rpc_path,
					'account_delete',
					{account_id: fixture.account.id},
					fixture.create_session_headers(),
				);
				assert.strictEqual(del.ok, false, 'delete of keeper account must be refused');
				assert.strictEqual(error_reason(del), ERROR_CANNOT_DELETE_KEEPER);

				const tp = fixture.fresh_transport({origin: null});
				const purge = await cross_rpc_call(
					tp,
					rpc_path,
					'account_purge',
					{account_id: fixture.account.id, confirm: true},
					fixture.create_daemon_token_headers(),
				);
				assert.strictEqual(purge.ok, false, 'purge of keeper account must be refused');
				assert.strictEqual(error_reason(purge), ERROR_CANNOT_DELETE_KEEPER);
			},
		);

		test_if(
			capabilities.account_lifecycle,
			'admin_account_list include_deleted surfaces tombstoned rows with deleted_at set',
			async () => {
				const fixture = await setup_test();
				const victim = await fixture.create_account({username: 'lifecycle_listed'});
				const admin_headers = fixture.create_session_headers();

				const t = fixture.fresh_transport();
				const deleted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'account_delete',
						{account_id: victim.account.id},
						admin_headers,
					),
					AccountDeleteOutput,
				);
				assert.strictEqual(deleted.deleted, true);

				// Default listing excludes the tombstone.
				const active_only = expect_output(
					await cross_rpc_call(t, rpc_path, 'admin_account_list', {}, admin_headers),
					AdminAccountListOutput,
				);
				assert.ok(
					!active_only.accounts.some((a) => a.account.id === victim.account.id),
					'default listing excludes the soft-deleted account',
				);

				// `include_deleted` surfaces it with `deleted_at` populated.
				const with_deleted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'admin_account_list',
						{include_deleted: true},
						admin_headers,
					),
					AdminAccountListOutput,
				);
				const row = with_deleted.accounts.find((a) => a.account.id === victim.account.id);
				assert.ok(row, 'include_deleted surfaces the tombstoned row');
				assert.ok(
					row.account.deleted_at !== null,
					'tombstoned row carries a non-null deleted_at on both spines',
				);
			},
		);
	});
};
