/**
 * Failure-outcome audit trail for `admin_session_revoke_all` / `admin_token_revoke_all`
 * when the target account is missing.
 *
 * Parity with `permit_offer_create` / `permit_revoke`, which both emit
 * `outcome: 'failure'` audit rows on denial paths — gives operators forensic
 * visibility into who probed a missing id, not just who succeeded. The
 * round-trip + attack-surface suites in `admin_actions.rpc_suites.db.test.ts`
 * don't cover bespoke 404 handler branches; this file does.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_admin_actions} from '$lib/auth/admin_actions.js';
import {
	admin_session_revoke_all_action_spec,
	admin_token_revoke_all_action_spec,
	audit_log_list_action_spec,
} from '$lib/auth/admin_action_specs.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {rpc_call} from '$lib/testing/rpc_helpers.js';
import {
	create_pglite_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
} from '$lib/testing/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import type {Db} from '$lib/db/db.js';
import type {AppServerContext} from '$lib/server/app_server.js';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';
const rpc_log = new Logger('admin-failure-audit', {level: 'off'});
// Valid v4 UUID that won't collide with bootstrap/test accounts. Must be
// version-4 because `Uuid = z.uuid()` rejects non-RFC-4122 shapes.
const missing_account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, AUTH_INTEGRATION_TRUNCATE_TABLES);

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...prefix_route_specs('/api/account', []),
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_admin_actions(
			{log: rpc_log, on_audit_event: () => undefined},
			{app_settings: ctx.app_settings},
		),
		log: rpc_log,
	}),
];

describe_db('admin_actions_failure_audit', (get_db) => {
	describe('admin_session_revoke_all — missing target account', () => {
		test('returns 404 and emits an `outcome: "failure"` audit row', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});

			const res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: admin_session_revoke_all_action_spec.method,
				params: {account_id: missing_account_id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 404 for missing account');
			assert.strictEqual(res.status, 404);
			assert.strictEqual((res.error.data as {reason: string}).reason, 'account_not_found');

			const audit_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: audit_log_list_action_spec.method,
				params: {event_type: 'session_revoke_all'},
				headers: test_app.create_session_headers(),
			});
			assert.ok(audit_res.ok, 'audit_log_list should succeed');
			const body = audit_res.result as {
				events: Array<{
					event_type: string;
					outcome: string;
					target_account_id: string | null;
					metadata: {reason?: string; attempted_account_id?: string};
				}>;
			};
			const failure = body.events.find((e) => e.outcome === 'failure');
			assert.ok(failure, 'Expected a failure-outcome session_revoke_all audit event');
			assert.strictEqual(failure.event_type, 'session_revoke_all');
			assert.strictEqual(failure.target_account_id, null);
			assert.strictEqual(failure.metadata.reason, 'account_not_found');
			assert.strictEqual(failure.metadata.attempted_account_id, missing_account_id);
		});
	});

	describe('admin_token_revoke_all — missing target account', () => {
		test('returns 404 and emits an `outcome: "failure"` audit row', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});

			const res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: admin_token_revoke_all_action_spec.method,
				params: {account_id: missing_account_id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 404 for missing account');
			assert.strictEqual(res.status, 404);
			assert.strictEqual((res.error.data as {reason: string}).reason, 'account_not_found');

			const audit_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: audit_log_list_action_spec.method,
				params: {event_type: 'token_revoke_all'},
				headers: test_app.create_session_headers(),
			});
			assert.ok(audit_res.ok, 'audit_log_list should succeed');
			const body = audit_res.result as {
				events: Array<{
					event_type: string;
					outcome: string;
					target_account_id: string | null;
					metadata: {reason?: string; attempted_account_id?: string};
				}>;
			};
			const failure = body.events.find((e) => e.outcome === 'failure');
			assert.ok(failure, 'Expected a failure-outcome token_revoke_all audit event');
			assert.strictEqual(failure.event_type, 'token_revoke_all');
			assert.strictEqual(failure.target_account_id, null);
			assert.strictEqual(failure.metadata.reason, 'account_not_found');
			assert.strictEqual(failure.metadata.attempted_account_id, missing_account_id);
		});
	});
});
