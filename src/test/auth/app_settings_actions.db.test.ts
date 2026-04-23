/**
 * Integration tests for app settings admin RPC actions.
 *
 * Tests `app_settings_get` + `app_settings_update` via `rpc_call` — auth,
 * toggle roundtrip, and audit log creation. End-to-end validation that the
 * update mutates the in-memory `app_settings` ref (which signup middleware
 * reads) lives in `invite_signup.integration.db.test.ts`.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_admin_actions} from '$lib/auth/admin_actions.js';
import {
	app_settings_get_action_spec,
	app_settings_update_action_spec,
} from '$lib/auth/admin_action_specs.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {rpc_call, type RpcCallResult} from '$lib/testing/rpc_helpers.js';
import {
	create_pglite_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
} from '$lib/testing/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import type {Db} from '$lib/db/db.js';
import type {AppServerContext} from '$lib/server/app_server.js';

const session_options = create_session_config('test_session');

const RPC_PATH = '/api/rpc';
const rpc_log = new Logger('app-settings-rpc', {level: 'off'});

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, AUTH_INTEGRATION_TRUNCATE_TABLES);

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...prefix_route_specs('/api/account', [
		...create_account_route_specs(ctx.deps, {
			session_options,
			ip_rate_limiter: ctx.ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
			login_fail_floor_ms: 0,
		}),
	]),
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_admin_actions(
			{log: rpc_log, on_audit_event: () => undefined},
			{app_settings: ctx.app_settings},
		),
		log: rpc_log,
	}),
];

interface AppLike {
	request: (input: string, init: RequestInit) => Promise<Response> | Response;
}

const settings_rpc_get = (app: AppLike, headers: Record<string, string>): Promise<RpcCallResult> =>
	rpc_call({
		app,
		path: RPC_PATH,
		method: app_settings_get_action_spec.method,
		headers,
	});

const settings_rpc_update = (
	app: AppLike,
	open_signup: boolean,
	headers: Record<string, string>,
): Promise<RpcCallResult> =>
	rpc_call({
		app,
		path: RPC_PATH,
		method: app_settings_update_action_spec.method,
		params: {open_signup},
		headers,
	});

describe_db('app settings RPC actions', (get_db) => {
	describe('app_settings_get', () => {
		test('admin can read settings', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const r = await settings_rpc_get(test_app.app, test_app.create_session_headers());
			assert.ok(r.ok);
			const body = r.result as {settings: {open_signup: boolean}};
			assert.strictEqual(body.settings.open_signup, false);
		});

		test('non-admin gets forbidden', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const non_admin = await test_app.create_account({username: 'regular'});
			const r = await settings_rpc_get(test_app.app, non_admin.create_session_headers());
			assert.ok(!r.ok);
			assert.strictEqual(r.status, 403);
		});

		test('unauthenticated gets unauthenticated error', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const r = await settings_rpc_get(test_app.app, {
				host: 'localhost',
				origin: 'http://localhost:5173',
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
			const r = await settings_rpc_update(test_app.app, true, test_app.create_session_headers());
			assert.ok(r.ok);
			const body = r.result as {
				ok: true;
				settings: {open_signup: boolean; updated_at: string | null};
			};
			assert.strictEqual(body.ok, true);
			assert.strictEqual(body.settings.open_signup, true);
			assert.ok(body.settings.updated_at);
		});

		test('toggle roundtrip: on then off', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await settings_rpc_update(test_app.app, true, test_app.create_session_headers());
			const off_r = await settings_rpc_update(
				test_app.app,
				false,
				test_app.create_session_headers(),
			);
			assert.ok(off_r.ok);
			assert.strictEqual(
				(off_r.result as {settings: {open_signup: boolean}}).settings.open_signup,
				false,
			);

			const get_r = await settings_rpc_get(test_app.app, test_app.create_session_headers());
			assert.ok(get_r.ok);
			assert.strictEqual(
				(get_r.result as {settings: {open_signup: boolean}}).settings.open_signup,
				false,
			);
		});

		test('non-admin gets forbidden on update', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const non_admin = await test_app.create_account({username: 'regular'});
			const r = await settings_rpc_update(test_app.app, true, non_admin.create_session_headers());
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
			await settings_rpc_update(test_app.app, true, test_app.create_session_headers());

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
