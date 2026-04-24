/**
 * Error-branch RPC integration coverage for `invite_create` / `invite_delete`.
 *
 * `error_schemas.test.ts` asserts the `ERROR_INVITE_*` constants are exported
 * with the right string values, but does not fire them through the dispatcher.
 * These tests round-trip each denial path through a real RPC call against a
 * PGlite-backed admin surface and assert `error.data.reason`.
 *
 * Unlike `admin_actions.failure_audit.db.test.ts`, the invite handlers do not
 * emit `outcome: 'failure'` audit rows on denial paths — so only the JSON-RPC
 * error envelope is asserted here.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_admin_actions} from '$lib/auth/admin_actions.js';
import {
	invite_create_action_spec,
	invite_delete_action_spec,
} from '$lib/auth/admin_action_specs.js';
import {
	ERROR_INVITE_MISSING_IDENTIFIER,
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
	ERROR_INVITE_DUPLICATE,
	ERROR_INVITE_NOT_FOUND,
} from '$lib/http/error_schemas.js';
import {query_create_account_with_actor} from '$lib/auth/account_queries.js';
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
const rpc_log = new Logger('invite-actions-failure', {level: 'off'});
// Valid v4 UUID that won't collide with any real invite row.
const missing_invite_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

describe_db('invite_actions_failure', (get_db) => {
	describe('invite_create', () => {
		test('rejects empty input with `invite_missing_identifier`', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});

			const res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: invite_create_action_spec.method,
				params: {},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 400 for missing identifier');
			assert.strictEqual(res.status, 400);
			assert.strictEqual(
				(res.error.data as {reason: string}).reason,
				ERROR_INVITE_MISSING_IDENTIFIER,
			);
		});

		test('rejects username colliding with an existing account', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const existing_username = test_app.backend.account.username;

			const res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: invite_create_action_spec.method,
				params: {username: existing_username},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 409 for existing username');
			assert.strictEqual(res.status, 409);
			assert.strictEqual(
				(res.error.data as {reason: string}).reason,
				ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
			);
		});

		test('rejects email colliding with an existing account', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const existing_email = 'existing@example.test';
			await query_create_account_with_actor(
				{db: test_app.backend.deps.db},
				{
					username: 'account_with_email',
					password_hash: 'stub_hash_irrelevant',
					email: existing_email,
				},
			);

			const res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: invite_create_action_spec.method,
				params: {email: existing_email},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 409 for existing email');
			assert.strictEqual(res.status, 409);
			assert.strictEqual(
				(res.error.data as {reason: string}).reason,
				ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
			);
		});

		test('rejects a duplicate unclaimed invite for the same identifier', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const invitee_username = 'prospective_user';

			const first = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: invite_create_action_spec.method,
				params: {username: invitee_username},
				headers: test_app.create_session_headers(),
			});
			assert.ok(first.ok, 'First invite should succeed');

			const second = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: invite_create_action_spec.method,
				params: {username: invitee_username},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!second.ok, 'Expected 409 for duplicate unclaimed invite');
			assert.strictEqual(second.status, 409);
			assert.strictEqual((second.error.data as {reason: string}).reason, ERROR_INVITE_DUPLICATE);
		});
	});

	describe('invite_delete', () => {
		test('returns 404 `invite_not_found` for a missing invite id', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});

			const res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: invite_delete_action_spec.method,
				params: {invite_id: missing_invite_id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok, 'Expected 404 for missing invite');
			assert.strictEqual(res.status, 404);
			assert.strictEqual((res.error.data as {reason: string}).reason, ERROR_INVITE_NOT_FOUND);
		});
	});
});
