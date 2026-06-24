/**
 * Integration tests for `role_grant_assign` — the immediate admin-only
 * conferral path (spec-level `auth: {account: 'required', actor: 'required',
 * roles: ['admin']}` — the RPC dispatcher rejects non-admin callers before the
 * handler runs).
 *
 * The TS twin of the Rust `handle_role_grant_assign` PG suite
 * (`private_fuz/crates/fuz_auth/tests/role_grant_offer.rs`): the happy path
 * (admin assigns an admin-grantable role) and the non-grantable rejection
 * (`keeper` carries the bootstrap grant path only). Plus the supporting
 * branches the Rust handler resolves — dispatcher admin gate, target-actor
 * resolution (sole / named / multi-actor / actorless), idempotency.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.ts';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.ts';
import {
	role_grant_assign_action_spec,
	ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH,
} from '$lib/auth/role_grant_offer_action_specs.ts';
import {query_create_actor} from '$lib/auth/account_queries.ts';
import {
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_ROLE_NOT_WEB_GRANTABLE,
} from '$lib/http/error_schemas.ts';
import {create_uuid, type Uuid} from '@fuzdev/fuz_util/id.ts';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.ts';
import {create_audit_emitter} from '$lib/auth/audit_emitter.ts';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.ts';
import {install_audit_drift_guard} from '$lib/testing/audit_drift_guard.ts';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.ts';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './role_grant_offer_test_helpers.ts';

describe_db('role_grant_offer_actions.assign', (get_db) => {
	install_audit_drift_guard();

	describe('role_grant_assign', () => {
		test('admin assigns an admin-grantable role and gets {ok, role_grant_id}', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'assign_target_basic'});
			const db = get_db();

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_assign_action_spec,
				params: {to_account_id: target.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.result.ok, true);

			// The returned id names the active role_grant on the target's sole
			// actor, attributed to the assigning admin.
			const rows = await db.query<{id: Uuid; granted_by: Uuid | null}>(
				`SELECT id, granted_by FROM role_grant
				 WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
				[target.actor.id, ROLE_ADMIN],
			);
			assert.strictEqual(rows.length, 1, 'exactly one active admin grant on the target');
			assert.strictEqual(rows[0]?.id, res.result.role_grant_id);
			assert.strictEqual(rows[0]?.granted_by, test_app.backend.actor.id);
		});

		test('success emits a role_grant_create audit row with the actor-bound envelope', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({
						...params,
						on_audit_event: (event) => {
							events.push(event);
						},
					}),
			});
			const target = await test_app.create_account({username: 'assign_audit_target'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_assign_action_spec,
				params: {to_account_id: target.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);

			const audit = events.find(
				(e) => e.event_type === 'role_grant_create' && e.outcome !== 'failure',
			);
			assert.ok(audit, 'expected a success role_grant_create audit event');
			const metadata = audit.metadata as {
				role?: string;
				role_grant_id?: string;
				scope_id?: unknown;
			};
			assert.strictEqual(metadata.role, ROLE_ADMIN);
			assert.strictEqual(metadata.role_grant_id, res.result.role_grant_id);
			assert.strictEqual(metadata.scope_id, null, 'global grant — scope_id null');
			// Actor-bound subject — both target columns populated (mirrors the
			// Rust assign envelope: target_account = to_account_id, target_actor =
			// the resolved actor).
			assert.strictEqual(audit.target_account_id, target.account.id);
			assert.strictEqual(audit.target_actor_id, target.actor.id);
		});

		test('non-grantable role (keeper) rejected with role_not_web_grantable + failure audit', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({
						...params,
						on_audit_event: (event) => {
							events.push(event);
						},
					}),
			});
			const target = await test_app.create_account({username: 'assign_keeper_target'});
			const db = get_db();

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_assign_action_spec,
				params: {to_account_id: target.account.id, role: ROLE_KEEPER},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_NOT_WEB_GRANTABLE,
			);

			// No grant was created.
			const rows = await db.query(
				`SELECT 1 FROM role_grant WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
				[target.actor.id, ROLE_KEEPER],
			);
			assert.strictEqual(rows.length, 0, 'keeper grant must not be created');

			// A failure-outcome role_grant_create row preserves the forensic trail.
			const failure = events.find(
				(e) => e.event_type === 'role_grant_create' && e.outcome === 'failure',
			);
			assert.ok(failure, 'expected a failure-outcome role_grant_create audit event');
			assert.strictEqual((failure.metadata as {role?: string}).role, ROLE_KEEPER);
		});

		test('non-admin caller forbidden with insufficient_permissions (dispatcher gate)', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const caller = await test_app.create_account({username: 'assign_non_admin'});
			const target = await test_app.create_account({username: 'assign_non_admin_target'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_assign_action_spec,
				params: {to_account_id: target.account.id, role: ROLE_ADMIN},
				headers: caller.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_INSUFFICIENT_PERMISSIONS,
			);
		});

		test('nonexistent account returns 404', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_assign_action_spec,
				params: {to_account_id: create_uuid(), role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
		});

		test('to_actor_id not belonging to to_account_id → actor_account_mismatch', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'assign_mismatch_target'});
			const other = await test_app.create_account({username: 'assign_mismatch_other'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_assign_action_spec,
				// `other`'s actor does not belong to `target`'s account.
				params: {to_account_id: target.account.id, to_actor_id: other.actor.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH,
			);
		});

		test('idempotent — re-assigning an active grant returns the same role_grant_id', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'assign_idempotent_target'});

			const first = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_assign_action_spec,
				params: {to_account_id: target.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			const second = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_assign_action_spec,
				params: {to_account_id: target.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(first.ok && second.ok);
			assert.strictEqual(
				first.result.role_grant_id,
				second.result.role_grant_id,
				're-assign returns the existing grant',
			);
		});

		test('multi-actor account: requires to_actor_id, then assigns the named actor', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'assign_multi_actor_target'});
			const db = get_db();
			const second_actor = await query_create_actor({db}, target.account.id, 'second_persona');

			// No `to_actor_id` on a multi-actor account → invalid_params (no reason).
			const ambiguous = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_assign_action_spec,
				params: {to_account_id: target.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!ambiguous.ok);
			assert.strictEqual(ambiguous.status, 400);

			// Naming an active actor of the account resolves it.
			const named = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_assign_action_spec,
				params: {
					to_account_id: target.account.id,
					to_actor_id: second_actor.id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(named.ok);
			const rows = await db.query(
				`SELECT 1 FROM role_grant WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
				[second_actor.id, ROLE_ADMIN],
			);
			assert.strictEqual(rows.length, 1, 'the named actor holds the new grant');
		});
	});
});
