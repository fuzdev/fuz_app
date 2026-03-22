/**
 * Integration tests for app settings admin routes.
 *
 * Tests GET/PATCH /settings auth, toggle roundtrip, and audit log creation.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_app_settings_route_specs} from '$lib/auth/app_settings_routes.js';
import {create_admin_account_route_specs} from '$lib/auth/admin_routes.js';
import {create_test_app} from '$lib/testing/app_server.js';
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
		}),
	]),
	...prefix_route_specs('/api/admin', [
		...create_admin_account_route_specs(ctx.deps),
		...create_app_settings_route_specs(ctx.deps, {app_settings: ctx.app_settings}),
	]),
];

describe_db('app settings routes', (get_db) => {
	describe('GET /settings', () => {
		test('admin can read settings', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const res = await test_app.app.request('/api/admin/settings', {
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.strictEqual(body.settings.open_signup, false);
		});

		test('non-admin gets 403', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const non_admin = await test_app.create_account({username: 'regular'});
			const res = await test_app.app.request('/api/admin/settings', {
				headers: non_admin.create_session_headers(),
			});
			assert.strictEqual(res.status, 403);
		});

		test('unauthenticated gets 401', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const res = await test_app.app.request('/api/admin/settings', {
				headers: {host: 'localhost', origin: 'http://localhost:5173'},
			});
			assert.strictEqual(res.status, 401);
		});
	});

	describe('PATCH /settings', () => {
		test('admin can toggle open_signup on', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const res = await test_app.app.request('/api/admin/settings', {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					...test_app.create_session_headers(),
				},
				body: JSON.stringify({open_signup: true}),
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
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
			// Toggle on
			await test_app.app.request('/api/admin/settings', {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					...test_app.create_session_headers(),
				},
				body: JSON.stringify({open_signup: true}),
			});
			// Toggle off
			const res = await test_app.app.request('/api/admin/settings', {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					...test_app.create_session_headers(),
				},
				body: JSON.stringify({open_signup: false}),
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.strictEqual(body.settings.open_signup, false);

			// Verify GET reflects the update
			const get_res = await test_app.app.request('/api/admin/settings', {
				headers: test_app.create_session_headers(),
			});
			const get_body = await get_res.json();
			assert.strictEqual(get_body.settings.open_signup, false);
		});

		test('non-admin gets 403 on PATCH', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const non_admin = await test_app.create_account({username: 'regular'});
			const res = await test_app.app.request('/api/admin/settings', {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					...non_admin.create_session_headers(),
				},
				body: JSON.stringify({open_signup: true}),
			});
			assert.strictEqual(res.status, 403);
		});

		test('PATCH creates audit log entry', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await test_app.app.request('/api/admin/settings', {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					...test_app.create_session_headers(),
				},
				body: JSON.stringify({open_signup: true}),
			});
			// Check audit log
			const rows = await get_db().query<{event_type: string; metadata: unknown}>(
				`SELECT event_type, metadata FROM audit_log WHERE event_type = 'app_settings_update' ORDER BY seq DESC LIMIT 1`,
			);
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.event_type, 'app_settings_update');
			const metadata = rows[0]!.metadata as any;
			assert.strictEqual(metadata.setting, 'open_signup');
			assert.strictEqual(metadata.old_value, false);
			assert.strictEqual(metadata.new_value, true);
		});
	});
});
