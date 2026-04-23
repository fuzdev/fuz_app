/**
 * Integration tests for invite admin RPC actions and signup flow.
 *
 * Admin-side invite operations (`invite_create` / `invite_list` /
 * `invite_delete`) fire via `rpc_call` against the shared `/api/rpc`
 * endpoint. Signup stays REST — invite claim is a public form POST.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_signup_route_specs} from '$lib/auth/signup_routes.js';
import {create_admin_actions} from '$lib/auth/admin_actions.js';
import {create_account_actions} from '$lib/auth/account_actions.js';
import {app_settings_update_action_spec} from '$lib/auth/admin_action_specs.js';
import {account_verify_action_spec} from '$lib/auth/account_action_specs.js';
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

const RPC_PATH = '/api/rpc';
const rpc_log = new Logger('invite-rpc', {level: 'off'});

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
		...create_signup_route_specs(ctx.deps, {
			session_options,
			ip_rate_limiter: null,
			signup_account_rate_limiter: null,
			app_settings: ctx.app_settings,
		}),
	]),
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: [
			...create_admin_actions(
				{log: rpc_log, on_audit_event: () => undefined},
				{app_settings: ctx.app_settings},
			),
			...create_account_actions({log: rpc_log, on_audit_event: () => undefined}),
		],
		log: rpc_log,
	}),
];

/** JSON POST helper — used by the signup arm of this file. */
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

interface AppLike {
	request: (input: string, init: RequestInit) => Promise<Response> | Response;
}

const invite_rpc_create = (
	app: AppLike,
	params: {email?: string | null; username?: string | null},
	headers: Record<string, string>,
): Promise<RpcCallResult> =>
	rpc_call({app, path: RPC_PATH, method: 'invite_create', params, headers});

const invite_rpc_list = (app: AppLike, headers: Record<string, string>): Promise<RpcCallResult> =>
	rpc_call({app, path: RPC_PATH, method: 'invite_list', headers});

const invite_rpc_delete = (
	app: AppLike,
	invite_id: string,
	headers: Record<string, string>,
): Promise<RpcCallResult> =>
	rpc_call({app, path: RPC_PATH, method: 'invite_delete', params: {invite_id}, headers});

/** Fire `app_settings_update` via RPC — toggles the open-signup setting. */
const set_open_signup = async (
	app: AppLike,
	open_signup: boolean,
	headers: Record<string, string>,
): Promise<void> => {
	const r = await rpc_call({
		app,
		path: RPC_PATH,
		method: app_settings_update_action_spec.method,
		params: {open_signup},
		headers,
	});
	assert.ok(r.ok, `app_settings_update failed: ${r.ok ? '' : JSON.stringify(r.error)}`);
};

/**
 * Assert an RPC call failed with the given error code and `data.reason`.
 * Centralizes the discriminated-union narrowing at every error assertion.
 */
const assert_rpc_error = (
	result: RpcCallResult,
	expected_code: number,
	expected_reason?: string,
): void => {
	assert.strictEqual(result.ok, false, 'expected RPC error response');
	if (result.ok) return;
	assert.strictEqual(result.error.code, expected_code);
	if (expected_reason !== undefined) {
		const data = result.error.data as {reason?: string} | undefined;
		assert.strictEqual(data?.reason, expected_reason);
	}
};

describe_db('invite + signup integration', (get_db) => {
	describe('admin invite RPC actions', () => {
		test('admin can create an invite with email', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const r = await invite_rpc_create(
				test_app.app,
				{email: 'new@example.com'},
				test_app.create_session_headers(),
			);
			assert.ok(r.ok, 'invite_create should succeed');
			const body = r.result as {
				ok: true;
				invite: {
					id: string;
					email: string | null;
					username: string | null;
					claimed_at: string | null;
				};
			};
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
			const r = await invite_rpc_create(
				test_app.app,
				{username: 'newuser'},
				test_app.create_session_headers(),
			);
			assert.ok(r.ok);
			const body = r.result as {invite: {username: string | null}};
			assert.strictEqual(body.invite.username, 'newuser');
		});

		test('creating invite with neither email nor username errors with invalid_params', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const r = await invite_rpc_create(test_app.app, {}, test_app.create_session_headers());
			assert_rpc_error(r, JSONRPC_ERROR_CODES.invalid_params, ERROR_INVITE_MISSING_IDENTIFIER);
		});

		test('creating duplicate unclaimed invite returns conflict', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await invite_rpc_create(
				test_app.app,
				{email: 'dupe@example.com'},
				test_app.create_session_headers(),
			);
			const r = await invite_rpc_create(
				test_app.app,
				{email: 'dupe@example.com'},
				test_app.create_session_headers(),
			);
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_DUPLICATE);
		});

		test('non-admin gets forbidden on invite RPC', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			// Bootstrapped account has keeper role but not admin
			const non_admin = await test_app.create_account({username: 'regular'});
			const r = await invite_rpc_create(
				test_app.app,
				{email: 'nope@example.com'},
				non_admin.create_session_headers(),
			);
			assert_rpc_error(r, JSONRPC_ERROR_CODES.forbidden);
		});

		test('admin can list invites', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await invite_rpc_create(
				test_app.app,
				{email: 'a@example.com'},
				test_app.create_session_headers(),
			);
			await invite_rpc_create(test_app.app, {username: 'buser'}, test_app.create_session_headers());
			const r = await invite_rpc_list(test_app.app, test_app.create_session_headers());
			assert.ok(r.ok);
			const body = r.result as {invites: Array<unknown>};
			assert.strictEqual(body.invites.length, 2);
		});

		test('admin can delete an unclaimed invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const create_r = await invite_rpc_create(
				test_app.app,
				{email: 'del@example.com'},
				test_app.create_session_headers(),
			);
			assert.ok(create_r.ok);
			const {invite} = create_r.result as {invite: {id: string}};

			const del_r = await invite_rpc_delete(
				test_app.app,
				invite.id,
				test_app.create_session_headers(),
			);
			assert.ok(del_r.ok);

			// Verify it's gone
			const list_r = await invite_rpc_list(test_app.app, test_app.create_session_headers());
			assert.ok(list_r.ok);
			const {invites} = list_r.result as {invites: Array<unknown>};
			assert.strictEqual(invites.length, 0);
		});

		test('creating invite for existing username returns conflict', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Try to create invite for the bootstrapped account's username
			const r = await invite_rpc_create(
				test_app.app,
				{username: test_app.backend.account.username},
				test_app.create_session_headers(),
			);
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_ACCOUNT_EXISTS_USERNAME);
		});

		test('creating invite for existing email returns conflict', async () => {
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
			const r = await invite_rpc_create(
				test_app.app,
				{email: 'existing@example.com'},
				test_app.create_session_headers(),
			);
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_ACCOUNT_EXISTS_EMAIL);
		});

		test('creating invite for existing username (case variant) returns conflict', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Try uppercase variant of bootstrapped account's username
			const r = await invite_rpc_create(
				test_app.app,
				{username: test_app.backend.account.username.toUpperCase()},
				test_app.create_session_headers(),
			);
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_ACCOUNT_EXISTS_USERNAME);
		});

		test('creating invite for existing email (case variant) returns conflict', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await get_db().query(`UPDATE account SET email = 'CaseTest@Example.COM' WHERE id = $1`, [
				test_app.backend.account.id,
			]);
			const r = await invite_rpc_create(
				test_app.app,
				{email: 'casetest@example.com'},
				test_app.create_session_headers(),
			);
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_ACCOUNT_EXISTS_EMAIL);
		});

		test('creating invite rejects invalid username format', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const r = await invite_rpc_create(
				test_app.app,
				{username: '123invalid'},
				test_app.create_session_headers(),
			);
			assert_rpc_error(r, JSONRPC_ERROR_CODES.invalid_params);
		});

		test('creating invite rejects invalid email format', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const r = await invite_rpc_create(
				test_app.app,
				{email: 'not-an-email'},
				test_app.create_session_headers(),
			);
			assert_rpc_error(r, JSONRPC_ERROR_CODES.invalid_params);
		});

		test('creating invite with both fields rejects when username has existing account', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Invite with both fields — username matches existing account, email does not
			const r = await invite_rpc_create(
				test_app.app,
				{username: test_app.backend.account.username, email: 'fresh@example.com'},
				test_app.create_session_headers(),
			);
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_ACCOUNT_EXISTS_USERNAME);
		});

		test('creating duplicate unclaimed invite (case variant) returns conflict', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await invite_rpc_create(
				test_app.app,
				{email: 'unique@example.com'},
				test_app.create_session_headers(),
			);
			const r = await invite_rpc_create(
				test_app.app,
				{email: 'UNIQUE@EXAMPLE.COM'},
				test_app.create_session_headers(),
			);
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_DUPLICATE);
		});

		test('delete returns not_found for nonexistent invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const r = await invite_rpc_delete(
				test_app.app,
				'00000000-0000-4000-8000-000000000099',
				test_app.create_session_headers(),
			);
			assert_rpc_error(r, JSONRPC_ERROR_CODES.not_found, ERROR_INVITE_NOT_FOUND);
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
			await invite_rpc_create(
				test_app.app,
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
			await invite_rpc_create(
				test_app.app,
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
			await invite_rpc_create(
				test_app.app,
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
			const list_r = await invite_rpc_list(test_app.app, test_app.create_session_headers());
			assert.ok(list_r.ok);
			const {invites} = list_r.result as {
				invites: Array<{claimed_at: string | null; claimed_by: string | null}>;
			};
			assert.strictEqual(invites.length, 1);
			assert.ok(invites[0]!.claimed_at);
			assert.ok(invites[0]!.claimed_by);
		});

		test('after signup the new account can verify its session', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await invite_rpc_create(
				test_app.app,
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

			// Verify session via RPC
			const verify_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: account_verify_action_spec.method,
				headers: {cookie: cookie_value},
			});
			assert.ok(
				verify_res.ok,
				`account_verify failed: ${verify_res.ok ? '' : JSON.stringify(verify_res.error)}`,
			);
			const verify_body = verify_res.result as {username: string};
			assert.strictEqual(verify_body.username, 'verifyuser');
		});

		test('signup with email-only invite fails when only username matches', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			// Admin creates email-only invite
			await invite_rpc_create(
				test_app.app,
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
			await invite_rpc_create(
				test_app.app,
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
			await invite_rpc_create(
				test_app.app,
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
			await invite_rpc_create(
				test_app.app,
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

		test('duplicate username signup gets 409 even with unclaimed invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await invite_rpc_create(
				test_app.app,
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

			// Insert a second invite for the same username — account already exists
			// from the first signup, so the unique constraint rejects the second signup
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

		test('delete returns not_found for claimed invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const create_r = await invite_rpc_create(
				test_app.app,
				{username: 'claimedel'},
				test_app.create_session_headers(),
			);
			assert.ok(create_r.ok);
			const {invite} = create_r.result as {invite: {id: string}};
			// Sign up to claim it
			await json_request(
				test_app.app,
				'/api/account/signup',
				{username: 'claimedel', password: 'securepassword123'},
				{host: 'localhost', origin: 'http://localhost:5173'},
			);
			// Try to delete the now-claimed invite
			const del_r = await invite_rpc_delete(
				test_app.app,
				invite.id,
				test_app.create_session_headers(),
			);
			assert_rpc_error(del_r, JSONRPC_ERROR_CODES.not_found, ERROR_INVITE_NOT_FOUND);
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
			// Enable open signup via admin RPC
			await set_open_signup(test_app.app, true, test_app.create_session_headers());
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
			await set_open_signup(test_app.app, true, test_app.create_session_headers());
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
			await set_open_signup(test_app.app, true, test_app.create_session_headers());
			// Disable open signup
			await set_open_signup(test_app.app, false, test_app.create_session_headers());
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
			await set_open_signup(test_app.app, true, test_app.create_session_headers());
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
