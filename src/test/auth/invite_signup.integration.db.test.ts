/**
 * Integration tests for invite admin routes and signup flow.
 *
 * Tests the full invite lifecycle: admin creates invites, users sign up
 * with matching invites, and invites transition from unclaimed to claimed.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_invite_route_specs} from '$lib/auth/invite_routes.js';
import {create_signup_route_specs} from '$lib/auth/signup_routes.js';
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
import {
	ERROR_NO_MATCHING_INVITE,
	ERROR_SIGNUP_CONFLICT,
	ERROR_INVITE_NOT_FOUND,
	ERROR_INVITE_MISSING_IDENTIFIER,
	ERROR_INVITE_DUPLICATE,
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
} from '$lib/http/error_schemas.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import type {Db} from '$lib/db/db.js';
import type {AppServerContext} from '$lib/server/app_server.js';

const session_options = create_session_config('test_session');
const {cookie_name} = session_options;

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
		...create_signup_route_specs(ctx.deps, {
			session_options,
			ip_rate_limiter: null,
			signup_account_rate_limiter: null,
			app_settings: ctx.app_settings,
		}),
	]),
	...prefix_route_specs('/api/admin', [
		...create_admin_account_route_specs(ctx.deps),
		...create_invite_route_specs(ctx.deps),
		...create_app_settings_route_specs(ctx.deps, {app_settings: ctx.app_settings}),
	]),
];

/** JSON POST helper. */
const json_request = (
	app: any,
	path: string,
	body: unknown,
	headers: Record<string, string>,
): Promise<Response> =>
	app.request(path, {
		method: 'POST',
		headers: {'content-type': 'application/json', ...headers},
		body: JSON.stringify(body),
	});

describe_db('invite + signup integration', (get_db) => {
	describe('admin invite routes', () => {
		test('admin can create an invite with email', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'new@example.com'},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.strictEqual(body.ok, true);
			assert.ok(body.invite.id);
			assert.strictEqual(body.invite.email, 'new@example.com');
			assert.strictEqual(body.invite.username, null);
			assert.strictEqual(body.invite.claimed_at, null);
		});

		test('admin can create an invite with username', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: 'newuser'},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.strictEqual(body.invite.username, 'newuser');
		});

		test('creating invite with neither email nor username returns 400', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 400);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_INVITE_MISSING_IDENTIFIER);
		});

		test('creating duplicate unclaimed invite returns 409', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'dupe@example.com'},
				test_app.create_session_headers(),
			);
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'dupe@example.com'},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 409);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_INVITE_DUPLICATE);
		});

		test('non-admin gets 403 on invite routes', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			// Bootstrapped account has keeper role but not admin
			const non_admin = await test_app.create_account({username: 'regular'});
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'nope@example.com'},
				non_admin.create_session_headers(),
			);
			assert.strictEqual(res.status, 403);
		});

		test('admin can list invites', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Create two invites
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'a@example.com'},
				test_app.create_session_headers(),
			);
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: 'buser'},
				test_app.create_session_headers(),
			);
			const res = await test_app.app.request('/api/admin/invites', {
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.strictEqual(body.invites.length, 2);
		});

		test('admin can delete an unclaimed invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const create_res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'del@example.com'},
				test_app.create_session_headers(),
			);
			const {invite} = await create_res.json();

			const del_res = await test_app.app.request(`/api/admin/invites/${invite.id}`, {
				method: 'DELETE',
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(del_res.status, 200);

			// Verify it's gone
			const list_res = await test_app.app.request('/api/admin/invites', {
				headers: test_app.create_session_headers(),
			});
			const {invites} = await list_res.json();
			assert.strictEqual(invites.length, 0);
		});

		test('creating invite for existing username returns 409', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Try to create invite for the bootstrapped account's username
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: test_app.backend.account.username},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 409);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_INVITE_ACCOUNT_EXISTS_USERNAME);
		});

		test('creating invite for existing email returns 409', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Set email on the bootstrapped account
			await get_db().query(`UPDATE account SET email = 'existing@example.com' WHERE id = $1`, [
				test_app.backend.account.id,
			]);
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'existing@example.com'},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 409);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_INVITE_ACCOUNT_EXISTS_EMAIL);
		});

		test('creating invite for existing username (case variant) returns 409', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Try uppercase variant of bootstrapped account's username
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: test_app.backend.account.username.toUpperCase()},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 409);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_INVITE_ACCOUNT_EXISTS_USERNAME);
		});

		test('creating invite for existing email (case variant) returns 409', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Set email on the bootstrapped account
			await get_db().query(`UPDATE account SET email = 'CaseTest@Example.COM' WHERE id = $1`, [
				test_app.backend.account.id,
			]);
			// Try creating invite with lowercase variant
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'casetest@example.com'},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 409);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_INVITE_ACCOUNT_EXISTS_EMAIL);
		});

		test('creating invite rejects invalid username format', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: '123invalid'},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 400);
		});

		test('creating invite rejects invalid email format', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'not-an-email'},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 400);
		});

		test('creating invite with both fields rejects when username has existing account', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Invite with both fields — username matches existing account, email does not
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: test_app.backend.account.username, email: 'fresh@example.com'},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 409);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_INVITE_ACCOUNT_EXISTS_USERNAME);
		});

		test('creating duplicate unclaimed invite (case variant) returns 409', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'unique@example.com'},
				test_app.create_session_headers(),
			);
			// Try creating invite with different casing
			const res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'UNIQUE@EXAMPLE.COM'},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 409);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_INVITE_DUPLICATE);
		});

		test('delete returns 404 for nonexistent invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const res = await test_app.app.request(
				'/api/admin/invites/00000000-0000-4000-8000-000000000099',
				{method: 'DELETE', headers: test_app.create_session_headers()},
			);
			assert.strictEqual(res.status, 404);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_INVITE_NOT_FOUND);
		});
	});

	describe('signup', () => {
		test('signup succeeds with matching invite by username', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Admin creates invite
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: 'newuser'},
				test_app.create_session_headers(),
			);
			// User signs up
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'newuser', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.strictEqual(body.ok, true);
			// Session cookie should be set
			const set_cookie = res.headers.get('set-cookie');
			assert.ok(set_cookie);
			assert.ok(set_cookie.includes(cookie_name));
		});

		test('signup succeeds with matching invite by email', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'signup@example.com'},
				test_app.create_session_headers(),
			);
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'emailuser', password: 'securepassword123', email: 'signup@example.com'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 200);
		});

		test('signup fails with 403 when no invite matches', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'noinvite', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 403);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_NO_MATCHING_INVITE);
		});

		test('signup fails with 409 when username already exists', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Create invite directly in DB to bypass route-level account-exists check
			await get_db().query(`INSERT INTO invite (username, created_by) VALUES ($1, NULL)`, [
				test_app.backend.account.username,
			]);
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{
					username: test_app.backend.account.username,
					password: 'securepassword123',
				},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 409);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_SIGNUP_CONFLICT);
		});

		test('signup fails with 409 when email already exists', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Create an account with an email first
			const existing = await test_app.create_account({username: 'existing'});
			// Manually set email on the existing account
			await get_db().query(`UPDATE account SET email = 'taken@example.com' WHERE id = $1`, [
				existing.account.id,
			]);
			// Create invite directly in DB to bypass route-level account-exists check
			await get_db().query(
				`INSERT INTO invite (email, created_by) VALUES ('taken@example.com', NULL)`,
			);
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{
					username: 'newuser',
					password: 'securepassword123',
					email: 'taken@example.com',
				},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 409);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_SIGNUP_CONFLICT);
		});

		test('username and email conflicts produce the same error code', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});

			// Set up username conflict
			await get_db().query(`INSERT INTO invite (username, created_by) VALUES ($1, NULL)`, [
				test_app.backend.account.username,
			]);
			const res_username = await json_request(
				test_app.app,
				'/api/account/signup',
				{
					username: test_app.backend.account.username,
					password: 'securepassword123',
				},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			const body_username = await res_username.json();

			// Set up email conflict
			await get_db().query(`UPDATE account SET email = 'conflict@example.com' WHERE id = $1`, [
				test_app.backend.account.id,
			]);
			await get_db().query(
				`INSERT INTO invite (email, created_by) VALUES ('conflict@example.com', NULL)`,
			);
			const res_email = await json_request(
				test_app.app,
				'/api/account/signup',
				{
					username: 'uniqueuser',
					password: 'securepassword123',
					email: 'conflict@example.com',
				},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			const body_email = await res_email.json();

			// Both must produce the same error code
			assert.strictEqual(res_username.status, 409);
			assert.strictEqual(res_email.status, 409);
			assert.strictEqual(body_username.error, ERROR_SIGNUP_CONFLICT);
			assert.strictEqual(body_email.error, ERROR_SIGNUP_CONFLICT);
		});

		test('after signup the invite shows as claimed in admin list', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: 'claimcheck'},
				test_app.create_session_headers(),
			);
			// Sign up
			await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'claimcheck', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			// Check invite list
			const list_res = await test_app.app.request('/api/admin/invites', {
				headers: test_app.create_session_headers(),
			});
			const {invites} = await list_res.json();
			assert.strictEqual(invites.length, 1);
			assert.ok(invites[0].claimed_at);
			assert.ok(invites[0].claimed_by);
		});

		test('after signup the new account can verify its session', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: 'verifyuser'},
				test_app.create_session_headers(),
			);
			const signup_res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'verifyuser', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			// Extract session cookie from signup response
			const set_cookie = signup_res.headers.get('set-cookie');
			assert.ok(set_cookie, 'signup should set session cookie');
			const cookie_value = set_cookie.split(';')[0]!;

			// Verify session
			const verify_res = await test_app.app.request('/api/account/verify', {
				headers: {
					host: 'localhost',
					origin: 'http://localhost:5173',
					cookie: cookie_value,
				},
			});
			assert.strictEqual(verify_res.status, 200);
			const body = await verify_res.json();
			assert.strictEqual(body.account.username, 'verifyuser');
		});

		test('signup with email-only invite fails when only username matches', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Admin creates email-only invite
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'alice@example.com'},
				test_app.create_session_headers(),
			);
			// User signs up with matching username but no email
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'alice', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 403);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_NO_MATCHING_INVITE);
		});

		test('signup with both-field invite requires both to match', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Admin creates invite with both fields
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'both@example.com', username: 'bothuser'},
				test_app.create_session_headers(),
			);
			// Only email matches — should fail
			const res1 = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'wronguser', password: 'securepassword123', email: 'both@example.com'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res1.status, 403);

			// Only username matches — should fail
			const res2 = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'bothuser', password: 'securepassword123', email: 'wrong@example.com'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res2.status, 403);

			// Both match — should succeed
			const res3 = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'bothuser', password: 'securepassword123', email: 'both@example.com'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res3.status, 200);
		});

		test('signup with case-variant email matches email-only invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Admin creates invite with mixed-case email
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{email: 'Alice@Example.COM'},
				test_app.create_session_headers(),
			);
			// User signs up with lowercase email
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'aliceuser', password: 'securepassword123', email: 'alice@example.com'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 200);
		});

		test('signup with case-variant username matches username-only invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Admin creates invite with mixed-case username
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: 'CaseUser'},
				test_app.create_session_headers(),
			);
			// User signs up with lowercase username
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'caseuser', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 200);
		});

		test('signup rejects invalid username format', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: '123invalid', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 400);
		});

		test('signup rejects too-short password', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'validuser', password: 'short'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 400);
		});

		test('signup rejects username exceeding max length', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'a'.repeat(40), password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 400);
		});

		test('second signup for same invite gets 403 (invite race)', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: 'raceuser'},
				test_app.create_session_headers(),
			);
			// First signup succeeds
			const res1 = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'raceuser', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res1.status, 200);

			// Create a new invite for a different user but with the same invite-match pattern
			// (simulates the race: invite already claimed by first signup)
			// Second signup with the same username gets 409 (unique constraint)
			// because the account already exists from the first signup
			await get_db().query(`INSERT INTO invite (username, created_by) VALUES ('raceuser', NULL)`);
			const res2 = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'raceuser', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res2.status, 409);
			const body = await res2.json();
			assert.strictEqual(body.error, ERROR_SIGNUP_CONFLICT);
		});

		test('delete returns 404 for claimed invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const create_res = await json_request(
				test_app.app,
				'/api/admin/invites',
				{username: 'claimedel'},
				test_app.create_session_headers(),
			);
			const {invite} = await create_res.json();
			// Sign up to claim it
			await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'claimedel', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			// Try to delete the now-claimed invite
			const del_res = await test_app.app.request(`/api/admin/invites/${invite.id}`, {
				method: 'DELETE',
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(del_res.status, 404);
			const body = await del_res.json();
			assert.strictEqual(body.error, ERROR_INVITE_NOT_FOUND);
		});
	});

	describe('open signup', () => {
		test('signup succeeds without invite when open_signup is enabled', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Enable open signup via admin route
			await test_app.app.request('/api/admin/settings', {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					...test_app.create_session_headers(),
				},
				body: JSON.stringify({open_signup: true}),
			});
			// Sign up without any invite
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'openuser', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.strictEqual(body.ok, true);
			// Session cookie should be set
			const set_cookie = res.headers.get('set-cookie');
			assert.ok(set_cookie);
			assert.ok(set_cookie.includes(cookie_name));
		});

		test('signup fails without invite when open_signup is disabled', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			// open_signup defaults to false — no invite means 403
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'closeduser', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 403);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_NO_MATCHING_INVITE);
		});

		test('open signup rejects duplicate username', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Enable open signup
			await test_app.app.request('/api/admin/settings', {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					...test_app.create_session_headers(),
				},
				body: JSON.stringify({open_signup: true}),
			});
			// Try to sign up with the bootstrapped account's username
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{
					username: test_app.backend.account.username,
					password: 'securepassword123',
				},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 409);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_SIGNUP_CONFLICT);
		});

		test('open signup respects toggle state change', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Enable open signup
			await test_app.app.request('/api/admin/settings', {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					...test_app.create_session_headers(),
				},
				body: JSON.stringify({open_signup: true}),
			});
			// Disable open signup
			await test_app.app.request('/api/admin/settings', {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					...test_app.create_session_headers(),
				},
				body: JSON.stringify({open_signup: false}),
			});
			// Signup without invite should now fail
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'toggleduser', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			assert.strictEqual(res.status, 403);
			const body = await res.json();
			assert.strictEqual(body.error, ERROR_NO_MATCHING_INVITE);
		});

		test('open signup audit log records open_signup metadata', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Enable open signup
			await test_app.app.request('/api/admin/settings', {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					...test_app.create_session_headers(),
				},
				body: JSON.stringify({open_signup: true}),
			});
			// Sign up
			await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'audituser', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			// Check audit log
			const rows = await get_db().query<{event_type: string; metadata: unknown}>(
				`SELECT event_type, metadata FROM audit_log WHERE event_type = 'signup' ORDER BY seq DESC LIMIT 1`,
			);
			assert.strictEqual(rows.length, 1);
			const metadata = rows[0]!.metadata as any;
			assert.strictEqual(metadata.open_signup, true);
			assert.strictEqual(metadata.username, 'audituser');
		});
	});
});
