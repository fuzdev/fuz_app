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

import {
	admin_session_revoke_all_action_spec,
	admin_token_revoke_all_action_spec,
	audit_log_list_action_spec,
} from '$lib/auth/admin_action_specs.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import type {Uuid} from '$lib/uuid.js';
import {
	RPC_PATH,
	create_admin_route_specs,
	describe_db,
	session_options,
} from './admin_rpc_test_helpers.js';

// Valid v4 UUID that won't collide with bootstrap/test accounts. Must be
// version-4 because `Uuid = z.uuid()` rejects non-RFC-4122 shapes.
const missing_account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as Uuid;

describe_db('admin_actions_failure_audit', (get_db) => {
	describe('admin_session_revoke_all — missing target account', () => {
		test('returns 404 and emits an `outcome: "failure"` audit row', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_admin_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_session_revoke_all_action_spec,
				params: {account_id: missing_account_id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 404 for missing account');
			assert.strictEqual(res.status, 404);
			assert.strictEqual((res.error.data as {reason: string}).reason, 'account_not_found');

			const audit_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: audit_log_list_action_spec,
				params: {event_type: 'session_revoke_all'},
				headers: test_app.create_session_headers(),
			});
			assert.ok(audit_res.ok, 'audit_log_list should succeed');
			const failure = audit_res.result.events.find((e) => e.outcome === 'failure');
			assert.ok(failure, 'Expected a failure-outcome session_revoke_all audit event');
			assert.strictEqual(failure.event_type, 'session_revoke_all');
			assert.strictEqual(failure.target_account_id, null);
			// `ip` must carry the trusted-proxy client IP — REST admin handlers
			// emit it, and RPC admin handlers thread `ctx.client_ip` the same
			// way so audit rows are transport-uniform.
			assert.strictEqual(failure.ip, '127.0.0.1');
			const metadata = failure.metadata as {reason?: string; attempted_account_id?: string};
			assert.strictEqual(metadata.reason, 'account_not_found');
			assert.strictEqual(metadata.attempted_account_id, missing_account_id);
		});
	});

	describe('admin_token_revoke_all — missing target account', () => {
		test('returns 404 and emits an `outcome: "failure"` audit row', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_admin_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_token_revoke_all_action_spec,
				params: {account_id: missing_account_id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 404 for missing account');
			assert.strictEqual(res.status, 404);
			assert.strictEqual((res.error.data as {reason: string}).reason, 'account_not_found');

			const audit_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: audit_log_list_action_spec,
				params: {event_type: 'token_revoke_all'},
				headers: test_app.create_session_headers(),
			});
			assert.ok(audit_res.ok, 'audit_log_list should succeed');
			const failure = audit_res.result.events.find((e) => e.outcome === 'failure');
			assert.ok(failure, 'Expected a failure-outcome token_revoke_all audit event');
			assert.strictEqual(failure.event_type, 'token_revoke_all');
			assert.strictEqual(failure.target_account_id, null);
			assert.strictEqual(failure.ip, '127.0.0.1');
			const metadata = failure.metadata as {reason?: string; attempted_account_id?: string};
			assert.strictEqual(metadata.reason, 'account_not_found');
			assert.strictEqual(metadata.attempted_account_id, missing_account_id);
		});
	});
});
