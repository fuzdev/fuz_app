/**
 * `account_undelete` — admin-only reactivation of a soft-deleted account.
 *
 * The inverse of `account_delete`: clears the `deleted_at` tombstone on the
 * account + its soft-deleted actors so auth resolution finds it again.
 * Admin-only — there is no self path (a tombstoned account can't
 * authenticate). Does not restore revoked sessions/tokens
 * (delete = soft, purge = hard).
 */

import {test, assert} from 'vitest';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.js';
import {
	account_delete_action_spec,
	account_undelete_action_spec,
} from '$lib/auth/admin_action_specs.js';
import {account_verify_action_spec} from '$lib/auth/account_action_specs.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {ERROR_ACCOUNT_NOT_FOUND, ERROR_INSUFFICIENT_PERMISSIONS} from '$lib/http/error_schemas.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {auth_migration_ns} from '$lib/auth/migrations.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables,
} from '$lib/testing/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {install_audit_drift_guard} from '$lib/testing/audit_drift_guard.js';
import {query_account_by_id} from '$lib/auth/account_queries.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RouteSpec} from '$lib/http/route_spec.js';

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

describe_db('account_undelete', (get_db) => {
	install_audit_drift_guard();

	test('admin reactivates a soft-deleted account; auth resolves again', async () => {
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		const admin = await test_app.create_account({username: 'admin1', roles: [ROLE_ADMIN]});
		const victim = await test_app.create_account({username: 'victim'});

		// Admin soft-deletes the victim.
		const del = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {account_id: victim.account.id},
			headers: admin.create_session_headers(),
		});
		assert.strictEqual(del.ok, true);
		const gone = await query_account_by_id({db: test_app.backend.deps.db}, victim.account.id);
		assert.strictEqual(gone, undefined, 'soft-deleted account excluded from auth lookup');

		// Admin reactivates it.
		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_undelete_action_spec,
			params: {account_id: victim.account.id},
			headers: admin.create_session_headers(),
		});
		assert.strictEqual(res.ok, true);
		if (res.ok) assert.strictEqual(res.result.undeleted, true);
		const back = await query_account_by_id({db: test_app.backend.deps.db}, victim.account.id);
		assert.ok(back, 'reactivated account resolves through auth again');

		await test_app.cleanup();
	});

	test('undeleting a non-deleted account is a not-found no-op', async () => {
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		const admin = await test_app.create_account({username: 'admin1', roles: [ROLE_ADMIN]});
		const live = await test_app.create_account({username: 'still_here'});

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_undelete_action_spec,
			params: {account_id: live.account.id},
			headers: admin.create_session_headers(),
		});
		assert.strictEqual(res.ok, false);
		if (!res.ok)
			assert.strictEqual((res.error.data as {reason?: string})?.reason, ERROR_ACCOUNT_NOT_FOUND);
		await test_app.cleanup();
	});

	test('a non-admin cannot reactivate an account (admin-gated)', async () => {
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		const admin = await test_app.create_account({username: 'admin1', roles: [ROLE_ADMIN]});
		const victim = await test_app.create_account({username: 'victim'});
		const non_admin = await test_app.create_account({username: 'rando'});

		const del = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {account_id: victim.account.id},
			headers: admin.create_session_headers(),
		});
		assert.strictEqual(del.ok, true);

		// `account_undelete` is admin-only (roles: ['admin']) — a plain
		// authenticated account is rejected by the authorization phase.
		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_undelete_action_spec,
			params: {account_id: victim.account.id},
			headers: non_admin.create_session_headers(),
		});
		assert.strictEqual(res.ok, false);
		if (!res.ok)
			assert.strictEqual(
				(res.error.data as {reason?: string})?.reason,
				ERROR_INSUFFICIENT_PERMISSIONS,
			);
		// The blocked attempt left the tombstone intact.
		const still_gone = await query_account_by_id({db: test_app.backend.deps.db}, victim.account.id);
		assert.strictEqual(still_gone, undefined, 'victim stays tombstoned after the denied undelete');
		await test_app.cleanup();
	});

	test('undelete does not restore the revoked session', async () => {
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		const admin = await test_app.create_account({username: 'admin1', roles: [ROLE_ADMIN]});
		const victim = await test_app.create_account({username: 'victim'});

		// The victim's session authenticates before deletion.
		const before = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_verify_action_spec,
			params: undefined,
			headers: victim.create_session_headers(),
		});
		assert.strictEqual(before.ok, true);

		// Soft-delete revokes all the victim's sessions; undelete reactivates
		// the account but does NOT restore them (delete = soft, purge = hard).
		const del = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_delete_action_spec,
			params: {account_id: victim.account.id},
			headers: admin.create_session_headers(),
		});
		assert.strictEqual(del.ok, true);
		const undeleted = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_undelete_action_spec,
			params: {account_id: victim.account.id},
			headers: admin.create_session_headers(),
		});
		assert.strictEqual(undeleted.ok, true);

		// The account resolves again, but the old session cookie no longer
		// authenticates — the principal must re-auth fresh.
		const back = await query_account_by_id({db: test_app.backend.deps.db}, victim.account.id);
		assert.ok(back, 'reactivated account resolves through auth again');
		const after = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: account_verify_action_spec,
			params: undefined,
			headers: victim.create_session_headers(),
		});
		assert.strictEqual(after.ok, false, 'revoked session is not restored by undelete');
		await test_app.cleanup();
	});
});
