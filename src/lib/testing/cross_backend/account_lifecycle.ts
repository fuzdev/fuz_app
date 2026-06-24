import '../assert_dev_env.ts';

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
	AuditLogListOutput,
	ERROR_CANNOT_DELETE_KEEPER,
} from '../../auth/admin_action_specs.ts';
import {ERROR_ACCOUNT_NOT_FOUND, ERROR_AUTHENTICATION_REQUIRED} from '../../http/error_schemas.ts';
import {test_if} from './capabilities.ts';
import {cross_rpc_call, error_reason, expect_output} from './cell_cross_helpers.ts';
import type {RpcPathCrossSuiteOptions} from './setup.ts';
import {SPINE_RPC_PATH} from './spine_surface_constants.ts';

/**
 * Options for the account-lifecycle parity suite. The standard
 * RPC-dispatched cross-suite shape (`setup_test` / `capabilities` /
 * `rpc_path`); aliases `RpcPathCrossSuiteOptions` rather than duplicating.
 */
export type AccountLifecycleCrossTestOptions = RpcPathCrossSuiteOptions;

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
			'fail-closed: a soft-deleted account’s session + bearer credentials no longer authenticate',
			async () => {
				const fixture = await setup_test();
				const victim = await fixture.create_account({username: 'lifecycle_failclosed'});
				const admin_headers = fixture.create_session_headers();

				// Sanity: the victim's session authenticates while active, so the
				// post-deletion 401 is a real fail-closed transition, not a
				// never-valid credential passing vacuously.
				const before = await cross_rpc_call(
					fixture.fresh_transport(),
					rpc_path,
					'account_verify',
					undefined,
					victim.create_session_headers(),
				);
				assert.ok(before.ok, 'victim session authenticates before deletion');

				const deleted = expect_output(
					await cross_rpc_call(
						fixture.fresh_transport(),
						rpc_path,
						'account_delete',
						{account_id: victim.account.id},
						admin_headers,
					),
					AccountDeleteOutput,
				);
				assert.strictEqual(deleted.deleted, true);

				// The tombstone blocks auth resolution (and the soft-delete
				// revoked sessions/tokens) — the stale session credential must
				// fail closed with a generic 401, not partially authenticate.
				const session_probe = await cross_rpc_call(
					fixture.fresh_transport(),
					rpc_path,
					'account_verify',
					undefined,
					victim.create_session_headers(),
				);
				assert.strictEqual(
					session_probe.ok,
					false,
					'soft-deleted account session must not authenticate',
				);
				assert.strictEqual(error_reason(session_probe), ERROR_AUTHENTICATION_REQUIRED);

				// The victim's bearer token must fail closed too.
				const bearer_probe = await cross_rpc_call(
					fixture.fresh_transport({origin: null}),
					rpc_path,
					'account_verify',
					undefined,
					victim.create_bearer_headers(),
				);
				assert.strictEqual(
					bearer_probe.ok,
					false,
					'soft-deleted account bearer token must not authenticate',
				);
				assert.strictEqual(error_reason(bearer_probe), ERROR_AUTHENTICATION_REQUIRED);
			},
		);

		test_if(
			capabilities.account_lifecycle,
			'keeper guard emits a fail-loud failure-audit row (drained, cross-impl)',
			async () => {
				const fixture = await setup_test();
				const t = fixture.fresh_transport();

				// Refused keeper self-delete — the guard fires before any mutation
				// and emits a forensic `outcome: failure` audit row.
				const del = await cross_rpc_call(
					t,
					rpc_path,
					'account_delete',
					{account_id: fixture.account.id},
					fixture.create_session_headers(),
				);
				assert.strictEqual(error_reason(del), ERROR_CANNOT_DELETE_KEEPER);

				// Deterministic barrier before reading: await in-flight
				// fire-and-forget audit writes (the real await on the Rust spine;
				// satisfied-by-construction on the TS spine via await_pending_effects).
				const td = fixture.fresh_transport({origin: null});
				const drained = await cross_rpc_call(
					td,
					rpc_path,
					'_testing_drain_effects',
					undefined,
					fixture.create_daemon_token_headers(),
				);
				assert.ok(drained.ok, `_testing_drain_effects failed: ${JSON.stringify(drained.error)}`);

				// The failure row is now authoritative on both spines. `_testing_reset`
				// wiped audit_log at setup, so the refused delete is the only
				// account_delete event.
				const listed = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'audit_log_list',
						{event_type: 'account_delete'},
						fixture.create_session_headers(),
					),
					AuditLogListOutput,
				);
				const failure = listed.events.find(
					(e) =>
						e.outcome === 'failure' &&
						(e.metadata as {reason?: unknown} | null)?.reason === ERROR_CANNOT_DELETE_KEEPER,
				);
				assert.ok(
					failure,
					'keeper-removal guard must emit an account_delete outcome=failure audit row with reason cannot_delete_keeper',
				);
			},
		);

		test_if(
			capabilities.account_lifecycle,
			'deterministic: double-undelete → second call is not_found',
			async () => {
				const fixture = await setup_test();
				const victim = await fixture.create_account({username: 'lifecycle_double'});
				const t = fixture.fresh_transport();
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

				// First undelete clears the tombstone.
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

				// Second undelete on the now-active account is a deterministic
				// not_found — the query only matches soft-deleted rows, so the
				// outcome is the same on both spines (no silent idempotent ok).
				const again = await cross_rpc_call(
					t,
					rpc_path,
					'account_undelete',
					{account_id: victim.account.id},
					admin_headers,
				);
				assert.strictEqual(again.ok, false, 'double-undelete must not silently succeed');
				assert.strictEqual(error_reason(again), ERROR_ACCOUNT_NOT_FOUND);
			},
		);

		// The last-admin guard (`ERROR_CANNOT_DELETE_LAST_ADMIN`) is **not**
		// cross-process-testable against this fixture: the per-test keeper
		// permanently holds `ROLE_ADMIN` (bootstrap seeds `[ROLE_KEEPER,
		// ROLE_ADMIN]` and there is no remove-admin-from-keeper path), so a
		// non-keeper admin is never the *sole* active admin and the guard
		// never fires here. Its logic is covered in-process by
		// `src/test/auth/account_keeper_guard.db.test.ts`.

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
