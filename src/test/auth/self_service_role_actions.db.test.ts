/**
 * Integration tests for `self_service_role_grant` / `self_service_role_revoke`.
 *
 * Covers the happy path, idempotent re-grant / re-revoke, ineligible-role
 * rejection, factory-time typo detection, audit-row shape (including the
 * `self_service: true` metadata flag), and unauthenticated rejection.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {create_role_schema, ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {create_self_service_role_actions} from '$lib/auth/self_service_role_actions.js';
import {
	ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE,
	self_service_role_grant_action_spec,
	self_service_role_revoke_action_spec,
} from '$lib/auth/self_service_role_action_specs.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {rpc_call, rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {
	create_pglite_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
} from '$lib/testing/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';
import type {Db} from '$lib/db/db.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RouteSpec} from '$lib/http/route_spec.js';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, AUTH_INTEGRATION_TRUNCATE_TABLES);

const test_roles = create_role_schema({teacher: {}});

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_self_service_role_actions(ctx.deps, {
			eligible_roles: ['teacher'],
			roles: test_roles,
		}),
		log: ctx.deps.log,
	}),
];

describe_db('self_service_role_actions', (get_db) => {
	describe('factory validation', () => {
		test('throws when eligible_roles entry is not registered in roles', () => {
			assert.throws(
				() =>
					create_self_service_role_actions(
						{log: console as never, on_audit_event: () => {}},
						{eligible_roles: ['nonexistent'], roles: test_roles},
					),
				/eligible_roles entry "nonexistent" is not registered/,
			);
		});

		test('accepts eligible_roles when no roles schema is supplied', () => {
			// Without `roles`, no validation runs — a typo at startup goes
			// undetected. Documented as the tradeoff for callers without a
			// full role schema.
			assert.doesNotThrow(() =>
				create_self_service_role_actions(
					{log: console as never, on_audit_event: () => {}},
					{eligible_roles: ['anything']},
				),
			);
		});
	});

	describe('self_service_role_grant', () => {
		test('new grant returns granted:true with permit_id and writes audit row', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const caller = await test_app.create_account({username: 'grant_user'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_grant_action_spec,
				params: {role: 'teacher'},
				headers: caller.create_session_headers(),
			});
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.ok, true);
			assert.strictEqual(res.result.granted, true);
			assert.ok(res.result.permit_id);

			const audit_rows = await get_db().query<{
				event_type: string;
				account_id: string | null;
				metadata: Record<string, unknown> | null;
			}>(
				`SELECT event_type, account_id, metadata FROM audit_log
				 WHERE event_type = 'permit_grant' AND account_id = $1
				 ORDER BY seq DESC LIMIT 1`,
				[caller.account.id],
			);
			assert.strictEqual(audit_rows.length, 1);
			assert.strictEqual(audit_rows[0]!.metadata?.role, 'teacher');
			assert.strictEqual(audit_rows[0]!.metadata?.self_service, true);
			assert.strictEqual(audit_rows[0]!.metadata?.permit_id, res.result.permit_id);
		});

		test('idempotent re-grant returns granted:false with no permit_id', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const caller = await test_app.create_account({username: 'regrant_user'});
			const headers = caller.create_session_headers();

			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_grant_action_spec,
				params: {role: 'teacher'},
				headers,
			});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_grant_action_spec,
				params: {role: 'teacher'},
				headers,
			});
			assert.ok(res.ok);
			assert.strictEqual(res.result.granted, false);
			assert.strictEqual(res.result.permit_id, undefined);
		});

		test('rejects ineligible role with role_not_self_service_eligible', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const caller = await test_app.create_account({username: 'ineligible_user'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_grant_action_spec,
				params: {role: ROLE_ADMIN},
				headers: caller.create_session_headers(),
			});
			assert.ok(!res.ok, JSON.stringify(res));
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_NOT_SELF_SERVICE_ELIGIBLE,
			);
		});

		test('unauthenticated grant returns -32001', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: self_service_role_grant_action_spec.method,
				params: {role: 'teacher'},
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.unauthenticated);
		});
	});

	describe('self_service_role_revoke', () => {
		test('revoke after grant returns revoked:true and writes audit row', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const caller = await test_app.create_account({username: 'revoke_user'});
			const headers = caller.create_session_headers();

			const grant = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_grant_action_spec,
				params: {role: 'teacher'},
				headers,
			});
			assert.ok(grant.ok);

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_revoke_action_spec,
				params: {role: 'teacher'},
				headers,
			});
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.revoked, true);

			const audit_rows = await get_db().query<{
				event_type: string;
				metadata: Record<string, unknown> | null;
			}>(
				`SELECT event_type, metadata FROM audit_log
				 WHERE event_type = 'permit_revoke' AND account_id = $1
				 ORDER BY seq DESC LIMIT 1`,
				[caller.account.id],
			);
			assert.strictEqual(audit_rows.length, 1);
			assert.strictEqual(audit_rows[0]!.metadata?.role, 'teacher');
			assert.strictEqual(audit_rows[0]!.metadata?.self_service, true);
		});

		test('revoke without prior grant returns revoked:false (idempotent, no audit)', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const caller = await test_app.create_account({username: 'revoke_idempotent'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: self_service_role_revoke_action_spec,
				params: {role: 'teacher'},
				headers: caller.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.strictEqual(res.result.revoked, false);

			const audit_rows = await get_db().query<{event_type: string}>(
				`SELECT event_type FROM audit_log
				 WHERE event_type = 'permit_revoke' AND account_id = $1`,
				[caller.account.id],
			);
			assert.strictEqual(audit_rows.length, 0);
		});

		test('unauthenticated revoke returns -32001', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: self_service_role_revoke_action_spec.method,
				params: {role: 'teacher'},
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.unauthenticated);
		});
	});
});
