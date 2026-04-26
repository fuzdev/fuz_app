/**
 * Integration tests for app settings admin RPC actions.
 *
 * Tests `app_settings_get` + `app_settings_update` via `rpc_call_for_spec` —
 * auth, toggle roundtrip, and audit log creation. End-to-end validation that
 * the update mutates the in-memory `app_settings` ref (which signup
 * middleware reads) lives in `invite_signup.integration.db.test.ts`.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {
	app_settings_get_action_spec,
	app_settings_update_action_spec,
} from '$lib/auth/admin_action_specs.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {prefix_route_specs} from '$lib/http/route_spec.js';
import {
	RPC_PATH,
	create_admin_route_specs_with,
	describe_db,
	session_options,
} from './admin_rpc_test_helpers.js';

const create_route_specs = create_admin_route_specs_with((ctx) => [
	...prefix_route_specs('/api/account', [
		...create_account_route_specs(ctx.deps, {
			session_options,
			ip_rate_limiter: ctx.ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
			login_fail_floor_ms: 0,
		}),
	]),
]);

describe_db('app settings RPC actions', (get_db) => {
	describe('app_settings_get', () => {
		test('admin can read settings', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_get_action_spec,
				params: undefined,
				headers: test_app.create_session_headers(),
			});
			assert.ok(r.ok);
			assert.strictEqual(r.result.settings.open_signup, false);
		});

		test('non-admin gets forbidden', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const non_admin = await test_app.create_account({username: 'regular'});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_get_action_spec,
				params: undefined,
				headers: non_admin.create_session_headers(),
			});
			assert.ok(!r.ok);
			assert.strictEqual(r.status, 403);
		});

		test('unauthenticated gets unauthenticated error', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_get_action_spec,
				params: undefined,
				headers: {
					host: 'localhost',
					origin: 'http://localhost:5173',
				},
			});
			assert.ok(!r.ok);
			assert.strictEqual(r.error.code, JSONRPC_ERROR_CODES.unauthenticated);
		});
	});

	describe('app_settings_update', () => {
		test('admin can toggle open_signup on', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_update_action_spec,
				params: {open_signup: true},
				headers: test_app.create_session_headers(),
			});
			assert.ok(r.ok);
			assert.strictEqual(r.result.ok, true);
			assert.strictEqual(r.result.settings.open_signup, true);
			assert.ok(r.result.settings.updated_at);
		});

		test('toggle roundtrip: on then off', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_update_action_spec,
				params: {open_signup: true},
				headers: test_app.create_session_headers(),
			});
			const off_r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_update_action_spec,
				params: {open_signup: false},
				headers: test_app.create_session_headers(),
			});
			assert.ok(off_r.ok);
			assert.strictEqual(off_r.result.settings.open_signup, false);

			const get_r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_get_action_spec,
				params: undefined,
				headers: test_app.create_session_headers(),
			});
			assert.ok(get_r.ok);
			assert.strictEqual(get_r.result.settings.open_signup, false);
		});

		test('non-admin gets forbidden on update', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const non_admin = await test_app.create_account({username: 'regular'});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_update_action_spec,
				params: {open_signup: true},
				headers: non_admin.create_session_headers(),
			});
			assert.ok(!r.ok);
			assert.strictEqual(r.status, 403);
		});

		test('update creates audit log entry', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_update_action_spec,
				params: {open_signup: true},
				headers: test_app.create_session_headers(),
			});

			const rows = await get_db().query<{event_type: string; metadata: unknown}>(
				`SELECT event_type, metadata FROM audit_log WHERE event_type = 'app_settings_update' ORDER BY seq DESC LIMIT 1`,
			);
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.event_type, 'app_settings_update');
			const metadata = rows[0]!.metadata as {
				setting?: string;
				old_value?: boolean;
				new_value?: boolean;
			};
			assert.strictEqual(metadata.setting, 'open_signup');
			assert.strictEqual(metadata.old_value, false);
			assert.strictEqual(metadata.new_value, true);
		});
	});
});
