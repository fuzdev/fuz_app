/**
 * Integration tests for `self_service_role_set`.
 *
 * Covers happy path on both branches (`enabled: true` / `false`), idempotent
 * no-op on both branches, ineligible-role rejection, factory-time typo
 * detection, audit-row shapes (including the `self_service: true` metadata
 * flag), and unauthenticated rejection.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';

import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_test_app } from '$lib/testing/app_server.ts';
import { create_rpc_endpoint } from '$lib/actions/action_rpc.ts';
import { create_role_schema, ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import { create_self_service_role_actions } from '$lib/auth/self_service_role_actions.ts';
import {
	ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE,
	self_service_role_set_action_spec
} from '$lib/auth/self_service_role_action_specs.ts';
import { query_create_role_grant } from '$lib/auth/role_grant_queries.ts';
import { JSONRPC_ERROR_CODES } from '$lib/http/jsonrpc_errors.ts';
import { rpc_call, rpc_call_for_spec } from '$lib/testing/rpc_helpers.ts';
import { create_test_audit_emitter } from '$lib/testing/stubs.ts';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables
} from '$lib/testing/db.ts';
import { run_migrations } from '$lib/db/migrate.ts';
import { auth_migration_ns } from '$lib/auth/migrations.ts';
import type { Db } from '$lib/db/db.ts';
import type { AppServerContext } from '$lib/server/app_server_context.ts';
import type { RouteSpec } from '$lib/http/route_spec.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

const test_roles = create_role_schema([{ name: 'teacher', grant_paths: ['self_service'] }]);

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_self_service_role_actions(ctx.deps, {
			eligible_roles: ['teacher'],
			roles: test_roles
		}),
		log: ctx.deps.log
	})
];

describe_db('self_service_role_actions', (get_db) => {
	describe('factory validation', () => {
		test('throws when eligible_roles entry is not registered in roles', () => {
			assert.throws(
				() =>
					create_self_service_role_actions(
						{ log: console as never, audit: create_test_audit_emitter() },
						{ eligible_roles: ['nonexistent'], roles: test_roles }
					),
				/eligible_roles entry "nonexistent" is not registered/
			);
		});

		test('accepts eligible_roles when no roles schema is supplied', () => {
			// Without `roles`, no validation runs — a typo at startup goes
			// undetected. Documented as the tradeoff for callers without a
			// full role schema.
			assert.doesNotThrow(() =>
				create_self_service_role_actions(
					{ log: console as never, audit: create_test_audit_emitter() },
					{ eligible_roles: ['anything'] }
				)
			);
		});
	});

	describe('self_service_role_set — enabled:true (grant)', () => {
		test('new grant returns changed:true and writes role_grant_create audit row', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const caller = await test_app.create_account({ username: 'set_grant_user' });

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_set_action_spec,
				params: { role: 'teacher', enabled: true },
				headers: caller.create_session_headers()
			});
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.ok, true);
			assert.strictEqual(res.result.enabled, true);
			assert.strictEqual(res.result.changed, true);

			const audit_rows = await get_db().query<{
				event_type: string;
				account_id: string | null;
				target_account_id: string | null;
				target_actor_id: string | null;
				metadata: Record<string, unknown> | null;
			}>(
				`SELECT event_type, account_id, target_account_id, target_actor_id, metadata
				 FROM audit_log
				 WHERE event_type = 'role_grant_create' AND account_id = $1
				 ORDER BY seq DESC LIMIT 1`,
				[caller.account.id]
			);
			assert.strictEqual(audit_rows.length, 1);
			assert.strictEqual(audit_rows[0]!.metadata?.role, 'teacher');
			assert.strictEqual(audit_rows[0]!.metadata?.self_service, true);
			assert.ok(audit_rows[0]!.metadata?.role_grant_id);
			// Self-service `role_grant_create` populates both target columns
			// (== actor_id, account_id) so the audit_log_schema rule
			// "role_grant_create always populates both target columns" holds
			// uniformly across admin, accept, and self-service paths.
			assert.strictEqual(audit_rows[0]!.target_account_id, caller.account.id);
			assert.strictEqual(audit_rows[0]!.target_actor_id, caller.actor.id);
		});

		test('idempotent re-grant returns changed:false and writes no extra audit row', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const caller = await test_app.create_account({ username: 'set_regrant_user' });
			const headers = caller.create_session_headers();

			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_set_action_spec,
				params: { role: 'teacher', enabled: true },
				headers
			});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_set_action_spec,
				params: { role: 'teacher', enabled: true },
				headers
			});
			assert.ok(res.ok);
			assert.strictEqual(res.result.enabled, true);
			assert.strictEqual(res.result.changed, false);

			const audit_rows = await get_db().query<{ event_type: string }>(
				`SELECT event_type FROM audit_log
				 WHERE event_type = 'role_grant_create' AND account_id = $1`,
				[caller.account.id]
			);
			assert.strictEqual(audit_rows.length, 1);
		});
	});

	describe('self_service_role_set — enabled:false (revoke)', () => {
		test('revoke after grant returns changed:true and writes role_grant_revoke audit row', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const caller = await test_app.create_account({ username: 'set_revoke_user' });
			const headers = caller.create_session_headers();

			const grant = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_set_action_spec,
				params: { role: 'teacher', enabled: true },
				headers
			});
			assert.ok(grant.ok);

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_set_action_spec,
				params: { role: 'teacher', enabled: false },
				headers
			});
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.enabled, false);
			assert.strictEqual(res.result.changed, true);

			const audit_rows = await get_db().query<{
				event_type: string;
				target_account_id: string | null;
				target_actor_id: string | null;
				metadata: Record<string, unknown> | null;
			}>(
				`SELECT event_type, target_account_id, target_actor_id, metadata
				 FROM audit_log
				 WHERE event_type = 'role_grant_revoke' AND account_id = $1
				 ORDER BY seq DESC LIMIT 1`,
				[caller.account.id]
			);
			assert.strictEqual(audit_rows.length, 1);
			assert.strictEqual(audit_rows[0]!.metadata?.role, 'teacher');
			assert.strictEqual(audit_rows[0]!.metadata?.self_service, true);
			// Same actor-bound rule as the grant branch — target columns
			// populated even on self-service.
			assert.strictEqual(audit_rows[0]!.target_account_id, caller.account.id);
			assert.strictEqual(audit_rows[0]!.target_actor_id, caller.actor.id);
		});

		test('revoke without prior grant returns changed:false and writes no audit row', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const caller = await test_app.create_account({ username: 'set_idempotent_revoke' });

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_set_action_spec,
				params: { role: 'teacher', enabled: false },
				headers: caller.create_session_headers()
			});
			assert.ok(res.ok);
			assert.strictEqual(res.result.enabled, false);
			assert.strictEqual(res.result.changed, false);

			const audit_rows = await get_db().query<{ event_type: string }>(
				`SELECT event_type FROM audit_log
				 WHERE event_type = 'role_grant_revoke' AND account_id = $1`,
				[caller.account.id]
			);
			assert.strictEqual(audit_rows.length, 0);
		});
	});

	describe('shared guards', () => {
		test('rejects ineligible role with role_not_self_service_eligible', async () => {
			// Eligibility check fires before the `enabled` branch, so testing
			// one direction is sufficient.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const caller = await test_app.create_account({ username: 'set_ineligible_user' });

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_set_action_spec,
				params: { role: ROLE_ADMIN, enabled: true },
				headers: caller.create_session_headers()
			});
			assert.ok(!res.ok, JSON.stringify(res));
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(
				(res.error.data as { reason: string } | undefined)?.reason,
				ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE
			);
		});

		test('unauthenticated call returns -32001', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: self_service_role_set_action_spec.method,
				params: { role: 'teacher', enabled: true }
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.unauthenticated);
		});
	});

	describe('scope isolation', () => {
		// The handler hardcodes `scope_id: null` on grant + filters
		// `p.scope_id === null` on revoke, so self-service is strictly
		// global-scoped. A pre-existing scoped role_grant for the same role must
		// neither satisfy the "already enabled" check nor be touched by a
		// self-revoke. Guards a regression that would silently revoke a
		// caller's scope-bound role_grants.
		test('scoped role_grant neither satisfies enable nor is touched by disable', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const caller = await test_app.create_account({ username: 'set_scope_isolation_user' });
			const headers = caller.create_session_headers();

			const classroom = create_uuid();
			await query_create_role_grant(
				{ db: get_db() },
				{
					actor_id: caller.actor.id,
					role: 'teacher',
					scope_kind: 'classroom',
					scope_id: classroom,
					granted_by: caller.actor.id
				}
			);

			const grant_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_set_action_spec,
				params: { role: 'teacher', enabled: true },
				headers
			});
			assert.ok(grant_res.ok, JSON.stringify(grant_res));
			assert.strictEqual(grant_res.result.changed, true);

			const after_grant = await get_db().query<{ scope_id: string | null }>(
				`SELECT scope_id FROM role_grant
				 WHERE actor_id = $1 AND role = 'teacher' AND revoked_at IS NULL
				 ORDER BY scope_id NULLS FIRST`,
				[caller.actor.id]
			);
			assert.strictEqual(after_grant.length, 2);
			assert.strictEqual(after_grant[0]!.scope_id, null);
			assert.strictEqual(after_grant[1]!.scope_id, classroom);

			const revoke_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_set_action_spec,
				params: { role: 'teacher', enabled: false },
				headers
			});
			assert.ok(revoke_res.ok, JSON.stringify(revoke_res));
			assert.strictEqual(revoke_res.result.changed, true);

			const after_revoke = await get_db().query<{ scope_id: string | null }>(
				`SELECT scope_id FROM role_grant
				 WHERE actor_id = $1 AND role = 'teacher' AND revoked_at IS NULL`,
				[caller.actor.id]
			);
			assert.strictEqual(after_revoke.length, 1);
			assert.strictEqual(after_revoke[0]!.scope_id, classroom);
		});
	});
});
