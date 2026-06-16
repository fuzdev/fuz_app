/**
 * Keeper guard on `account_delete` / `account_purge`.
 *
 * The keeper account is never removable through the API: auth resolution
 * (`query_account_by_id`) and daemon-token resolution both pivot on it, so
 * tombstoning or cascading it away would brick keeper/daemon auth with no
 * recovery path (the keeper role is not web-revocable, and `account_purge`
 * itself requires keeper auth). Both handlers refuse a target holding an
 * active keeper grant with `ERROR_CANNOT_DELETE_KEEPER` (403). Keeper-account
 * removal stays out-of-band (bootstrap / DB; delete = soft, purge = hard).
 */

import {test, assert} from 'vitest';

import {create_session_config} from '$lib/auth/session_cookie.ts';
import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.ts';
import {
	account_delete_action_spec,
	account_purge_action_spec,
	ERROR_CANNOT_DELETE_KEEPER,
	ERROR_CANNOT_DELETE_LAST_ADMIN,
} from '$lib/auth/admin_action_specs.ts';
import {ROLE_ADMIN} from '$lib/auth/role_schema.ts';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.ts';
import {auth_migration_ns} from '$lib/auth/migrations.ts';
import {create_test_app} from '$lib/testing/app_server.ts';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables,
} from '$lib/testing/db.ts';
import {run_migrations} from '$lib/db/migrate.ts';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.ts';
import {install_audit_drift_guard} from '$lib/testing/audit_drift_guard.ts';
import type {AppServerContext} from '$lib/server/app_server_context.ts';
import type {RouteSpec} from '$lib/http/route_spec.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const factory = create_pglite_factory(async (db) => {
	await run_migrations(db, [auth_migration_ns]);
});
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_standard_rpc_actions(ctx.deps),
		log: ctx.deps.log,
	});

describe_db('account_delete keeper guard', (get_db) => {
	install_audit_drift_guard();

	test('keeper self-delete is refused (cannot_delete_keeper)', async () => {
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
		});
		// The bootstrapped account holds ROLE_KEEPER. Self-delete (no
		// account_id) reaches the keeper guard before the tombstone.
		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {},
			headers: test_app.create_session_headers(),
		});
		assert.strictEqual(res.ok, false);
		if (!res.ok)
			assert.strictEqual((res.error.data as {reason?: string})?.reason, ERROR_CANNOT_DELETE_KEEPER);
		await test_app.cleanup();
	});

	test('admin cannot soft-delete the keeper account', async () => {
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
		});
		const keeper_account_id = test_app.backend.account.id;
		const admin = await test_app.create_account({username: 'admin1', roles: [ROLE_ADMIN]});
		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {account_id: keeper_account_id},
			headers: admin.create_session_headers(),
		});
		assert.strictEqual(res.ok, false);
		if (!res.ok)
			assert.strictEqual((res.error.data as {reason?: string})?.reason, ERROR_CANNOT_DELETE_KEEPER);

		// The denial emits a forensic failure-audit row (fail-loud) —
		// `await_pending_effects` guarantees it lands before the response.
		const failure_row = await test_app.backend.deps.db.query_one<{reason: string}>(
			`SELECT metadata->>'reason' AS reason FROM audit_log
			 WHERE event_type = 'account_delete' AND outcome = 'failure'
			   AND target_account_id = $1`,
			[keeper_account_id],
		);
		assert.strictEqual(failure_row?.reason, ERROR_CANNOT_DELETE_KEEPER);

		// The keeper row is untouched — still resolves through auth.
		const verify = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {},
			headers: test_app.create_session_headers(),
		});
		assert.strictEqual(
			verify.ok,
			false,
			'keeper session still authenticates after the blocked delete',
		);
		await test_app.cleanup();
	});

	test('the sole active admin cannot be deleted; a second admin lifts the guard', async () => {
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		// The bootstrap keeper is keeper-only here (no admin grant), so a
		// created admin account is genuinely the only active admin.
		const admin = await test_app.create_account({username: 'sole_admin', roles: [ROLE_ADMIN]});

		// Self-delete the lone admin → refused as the last admin.
		const blocked = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {},
			headers: admin.create_session_headers(),
		});
		assert.strictEqual(blocked.ok, false);
		if (!blocked.ok)
			assert.strictEqual(
				(blocked.error.data as {reason?: string})?.reason,
				ERROR_CANNOT_DELETE_LAST_ADMIN,
			);

		// The last-admin denial emits a fail-loud failure-audit row, mirroring
		// the keeper guard (`await_pending_effects` lands it before the response).
		const failure_row = await test_app.backend.deps.db.query_one<{reason: string}>(
			`SELECT metadata->>'reason' AS reason FROM audit_log
			 WHERE event_type = 'account_delete' AND outcome = 'failure'
			   AND target_account_id = $1`,
			[admin.account.id],
		);
		assert.strictEqual(failure_row?.reason, ERROR_CANNOT_DELETE_LAST_ADMIN);

		// Add a second admin — now neither is the last admin.
		await test_app.create_account({username: 'second_admin', roles: [ROLE_ADMIN]});
		const allowed = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {},
			headers: admin.create_session_headers(),
		});
		assert.strictEqual(allowed.ok, true);
		if (allowed.ok) assert.strictEqual(allowed.result.deleted, true);
		await test_app.cleanup();
	});

	test('purging a soft-deleted admin succeeds while another active admin remains', async () => {
		// Regression: the last-admin guard used to test the target with the
		// tombstone-blind `query_account_has_global_role`, while the active
		// count excludes soft-deleted admins. Purging a tombstoned admin with
		// exactly one *other* active admin therefore saw `has_role=true` +
		// `count=1` and was falsely blocked as `cannot_delete_last_admin`,
		// even though a tombstoned admin can't lower the active count. The
		// admin branch now uses the active-account predicate.
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		const admin_a = await test_app.create_account({username: 'admin_a', roles: [ROLE_ADMIN]});
		const admin_b = await test_app.create_account({username: 'admin_b', roles: [ROLE_ADMIN]});

		// Soft-delete admin B while both are active (guard sees two admins → allowed).
		const deleted = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {account_id: admin_b.account.id},
			headers: admin_a.create_session_headers(),
		});
		assert.strictEqual(deleted.ok, true);

		// B is now a tombstoned admin; A is the only active admin (count = 1).
		// Keeper purges B — must NOT be blocked as the last admin.
		const purged = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_purge_action_spec,
			params: {account_id: admin_b.account.id, confirm: true},
			headers: test_app.create_daemon_token_headers(),
		});
		assert.strictEqual(
			purged.ok,
			true,
			purged.ok ? '' : `purge blocked: ${(purged.error.data as {reason?: string})?.reason}`,
		);
		if (purged.ok) assert.strictEqual(purged.result.purged, true);
		await test_app.cleanup();
	});

	test('the last active admin is still blocked even when a tombstoned admin exists', async () => {
		// Safety counterpart to the regression above: the active-account
		// predicate must not swing too far. A tombstoned admin doesn't rescue
		// the sole *active* admin — deleting it would leave no admin that can
		// authenticate, so it stays blocked.
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		const admin_a = await test_app.create_account({username: 'admin_a', roles: [ROLE_ADMIN]});
		const admin_b = await test_app.create_account({username: 'admin_b', roles: [ROLE_ADMIN]});

		// Soft-delete B (two active admins → allowed); A is now the sole active admin.
		const deleted = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {account_id: admin_b.account.id},
			headers: admin_a.create_session_headers(),
		});
		assert.strictEqual(deleted.ok, true);

		// A tries to self-delete → still refused as the last admin.
		const blocked = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {},
			headers: admin_a.create_session_headers(),
		});
		assert.strictEqual(blocked.ok, false);
		if (!blocked.ok)
			assert.strictEqual(
				(blocked.error.data as {reason?: string})?.reason,
				ERROR_CANNOT_DELETE_LAST_ADMIN,
			);
		await test_app.cleanup();
	});
});
