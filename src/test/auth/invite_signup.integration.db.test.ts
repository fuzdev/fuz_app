/**
 * Integration tests for invite admin RPC actions and signup flow.
 *
 * Admin-side invite operations (`invite_create` / `invite_list` /
 * `invite_delete`) fire via `rpc_call_for_spec` against the shared
 * `/api/rpc` endpoint. Signup stays REST — invite claim is a public
 * form POST.
 *
 * @module
 */

import { describe, test, assert, vi, afterEach } from 'vitest';

import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_account_route_specs } from '$lib/auth/account_routes.ts';
import { create_signup_route_specs } from '$lib/auth/signup_routes.ts';
import { create_admin_actions } from '$lib/auth/admin_actions.ts';
import { create_account_actions } from '$lib/auth/account_actions.ts';
import { query_create_invite } from '$lib/auth/invite_queries.ts';
import {
	app_settings_update_action_spec,
	invite_create_action_spec,
	invite_delete_action_spec,
	invite_list_action_spec
} from '$lib/auth/admin_action_specs.ts';
import { account_verify_action_spec } from '$lib/auth/account_action_specs.ts';
import { create_rpc_endpoint } from '$lib/actions/action_rpc.ts';
import { create_test_app } from '$lib/testing/app_server.ts';
import { rpc_call_for_spec, type RpcCallResult } from '$lib/testing/rpc_helpers.ts';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables
} from '$lib/testing/db.ts';
import { run_migrations } from '$lib/db/migrate.ts';
import { auth_migration_ns } from '$lib/auth/migrations.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import { JSONRPC_ERROR_CODES } from '$lib/http/jsonrpc_errors.ts';
import {
	ERROR_NO_MATCHING_INVITE,
	ERROR_SIGNUP_CONFLICT,
	ERROR_INVITE_NOT_FOUND,
	ERROR_INVITE_DUPLICATE,
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_ACCOUNT_EXISTS_EMAIL
} from '$lib/http/error_schemas.ts';
import { prefix_route_specs, type RouteSpec } from '$lib/http/route_spec.ts';
import type { Db } from '$lib/db/db.ts';
import type { AppServerContext } from '$lib/server/app_server_context.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

const session_options = create_session_config('test_session');
const { cookie_name } = session_options;

const RPC_PATH = '/api/rpc';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...prefix_route_specs('/api/account', [
		...create_account_route_specs(ctx.deps, {
			session_options,
			ip_rate_limiter: ctx.ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
			login_fail_floor_ms: 0
		}),
		...create_signup_route_specs(ctx.deps, {
			session_options,
			ip_rate_limiter: null,
			signup_account_rate_limiter: null,
			// disable the denial-time floor so the failure-shape tests don't
			// each wait ~250ms; the floor is exercised separately in its own
			// describe block
			signup_fail_floor_ms: 0
		})
	]),
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: [...create_admin_actions(ctx.deps), ...create_account_actions(ctx.deps)],
		log: ctx.deps.log
	})
];

/** JSON POST helper — used by the signup arm of this file. */
const json_request = (
	app: any,
	path: string,
	body: unknown,
	headers: Record<string, string>
): Promise<Response> =>
	app.request(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body)
	});

/**
 * Assert an RPC call failed with the given error code and `data.reason`.
 * Centralizes the discriminated-union narrowing at every error assertion.
 * Accepts either the untyped `RpcCallResult` or a spec-typed result — the
 * error branch shape is identical.
 */
const assert_rpc_error = (
	result: RpcCallResult,
	expected_code: number,
	expected_reason?: string
): void => {
	assert.strictEqual(result.ok, false, 'expected RPC error response');
	if (result.ok) return;
	assert.strictEqual(result.error.code, expected_code);
	if (expected_reason !== undefined) {
		const data = result.error.data as { reason?: string } | undefined;
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
				roles: [ROLE_ADMIN]
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'new@example.com' },
				headers: test_app.create_session_headers()
			});
			assert.ok(r.ok, 'invite_create should succeed');
			assert.strictEqual(r.result.ok, true);
			assert.ok(r.result.invite.id);
			assert.strictEqual(r.result.invite.email, 'new@example.com');
			assert.strictEqual(r.result.invite.username, null);
			assert.strictEqual(r.result.invite.claimed_at, null);
		});

		test('admin can create an invite with username', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: 'newuser' },
				headers: test_app.create_session_headers()
			});
			assert.ok(r.ok);
			assert.strictEqual(r.result.invite.username, 'newuser');
		});

		test('creating invite with neither email nor username errors with invalid_params', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: {},
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.invalid_params);
		});

		test('creating duplicate unclaimed invite returns conflict', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'dupe@example.com' },
				headers: test_app.create_session_headers()
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'dupe@example.com' },
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_DUPLICATE);
		});

		test('non-admin gets forbidden on invite RPC', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			// Bootstrapped account has keeper role but not admin
			const non_admin = await test_app.create_account({ username: 'regular' });
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'nope@example.com' },
				headers: non_admin.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.forbidden);
		});

		test('admin can list invites', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'a@example.com' },
				headers: test_app.create_session_headers()
			});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: 'buser' },
				headers: test_app.create_session_headers()
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_list_action_spec,
				params: {},
				headers: test_app.create_session_headers()
			});
			assert.ok(r.ok);
			assert.strictEqual(r.result.invites.length, 2);
		});

		test('admin can delete an unclaimed invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const create_r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'del@example.com' },
				headers: test_app.create_session_headers()
			});
			assert.ok(create_r.ok);

			const del_r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_delete_action_spec,
				params: { invite_id: create_r.result.invite.id },
				headers: test_app.create_session_headers()
			});
			assert.ok(del_r.ok);

			// Verify it's gone
			const list_r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_list_action_spec,
				params: {},
				headers: test_app.create_session_headers()
			});
			assert.ok(list_r.ok);
			assert.strictEqual(list_r.result.invites.length, 0);
		});

		test('creating invite for existing username returns conflict', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Try to create invite for the bootstrapped account's username
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: test_app.backend.account.username },
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_ACCOUNT_EXISTS_USERNAME);
		});

		test('creating invite for existing email returns conflict', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Set email on the bootstrapped account
			await get_db().query(`UPDATE account SET email = 'existing@example.com' WHERE id = $1`, [
				test_app.backend.account.id
			]);
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'existing@example.com' },
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_ACCOUNT_EXISTS_EMAIL);
		});

		test('creating invite for existing username (case variant) returns conflict', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Try uppercase variant of bootstrapped account's username
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: test_app.backend.account.username.toUpperCase() },
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_ACCOUNT_EXISTS_USERNAME);
		});

		test('creating invite for existing email (case variant) returns conflict', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			await get_db().query(`UPDATE account SET email = 'CaseTest@Example.COM' WHERE id = $1`, [
				test_app.backend.account.id
			]);
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'casetest@example.com' },
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_ACCOUNT_EXISTS_EMAIL);
		});

		test('creating invite rejects invalid username format', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: '123invalid' },
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.invalid_params);
		});

		test('creating invite rejects invalid email format', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'not-an-email' },
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.invalid_params);
		});

		test('creating invite with both fields rejects when username has existing account', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Invite with both fields — username matches existing account, email does not
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: test_app.backend.account.username, email: 'fresh@example.com' },
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_ACCOUNT_EXISTS_USERNAME);
		});

		test('creating duplicate unclaimed invite (case variant) returns conflict', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'unique@example.com' },
				headers: test_app.create_session_headers()
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'UNIQUE@EXAMPLE.COM' },
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.conflict, ERROR_INVITE_DUPLICATE);
		});

		test('delete returns not_found for nonexistent invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_delete_action_spec,
				params: { invite_id: '00000000-0000-4000-8000-000000000099' as Uuid },
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(r, JSONRPC_ERROR_CODES.not_found, ERROR_INVITE_NOT_FOUND);
		});
	});

	describe('signup', () => {
		test('signup succeeds with matching invite by username', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Admin creates invite
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: 'newuser' },
				headers: test_app.create_session_headers()
			});
			// User signs up
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'newuser', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
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
				roles: [ROLE_ADMIN]
			});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'signup@example.com' },
				headers: test_app.create_session_headers()
			});
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'emailuser', password: 'securepassword123', email: 'signup@example.com' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res.status, 200);
		});

		test('signup fails with 403 when no invite matches', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'noinvite', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
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
				roles: [ROLE_ADMIN]
			});
			// Create invite directly via query to bypass route-level account-exists check
			await query_create_invite(
				{ db: get_db() },
				{ username: test_app.backend.account.username, created_by: null }
			);
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{
					username: test_app.backend.account.username,
					password: 'securepassword123'
				},
				{ host: 'localhost', origin: 'http://localhost:5173' }
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
				roles: [ROLE_ADMIN]
			});
			// Create an account with an email first
			const existing = await test_app.create_account({ username: 'existing' });
			// Manually set email on the existing account
			await get_db().query(`UPDATE account SET email = 'taken@example.com' WHERE id = $1`, [
				existing.account.id
			]);
			// Create invite directly via query to bypass route-level account-exists check
			await query_create_invite({ db: get_db() }, { email: 'taken@example.com', created_by: null });
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{
					username: 'newuser',
					password: 'securepassword123',
					email: 'taken@example.com'
				},
				{ host: 'localhost', origin: 'http://localhost:5173' }
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
				roles: [ROLE_ADMIN]
			});

			// Set up username conflict
			await query_create_invite(
				{ db: get_db() },
				{ username: test_app.backend.account.username, created_by: null }
			);
			const res_username = await json_request(
				test_app.app,
				'/api/account/signup',
				{
					username: test_app.backend.account.username,
					password: 'securepassword123'
				},
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			const body_username = await res_username.json();

			// Set up email conflict
			await get_db().query(`UPDATE account SET email = 'conflict@example.com' WHERE id = $1`, [
				test_app.backend.account.id
			]);
			await query_create_invite(
				{ db: get_db() },
				{ email: 'conflict@example.com', created_by: null }
			);
			const res_email = await json_request(
				test_app.app,
				'/api/account/signup',
				{
					username: 'uniqueuser',
					password: 'securepassword123',
					email: 'conflict@example.com'
				},
				{ host: 'localhost', origin: 'http://localhost:5173' }
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
				roles: [ROLE_ADMIN]
			});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: 'claimcheck' },
				headers: test_app.create_session_headers()
			});
			// Sign up
			await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'claimcheck', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			// Check invite list
			const list_r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_list_action_spec,
				params: {},
				headers: test_app.create_session_headers()
			});
			assert.ok(list_r.ok);
			assert.strictEqual(list_r.result.invites.length, 1);
			assert.ok(list_r.result.invites[0]!.claimed_at);
			assert.ok(list_r.result.invites[0]!.claimed_by);
		});

		test('after signup the new account can verify its session', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: 'verifyuser' },
				headers: test_app.create_session_headers()
			});
			const signup_res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'verifyuser', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			// Extract session cookie from signup response
			const set_cookie = signup_res.headers.get('set-cookie');
			assert.ok(set_cookie, 'signup should set session cookie');
			const cookie_value = set_cookie.split(';')[0]!;

			// Verify session via RPC
			const verify_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_verify_action_spec,
				params: undefined,
				headers: { cookie: cookie_value }
			});
			assert.ok(
				verify_res.ok,
				`account_verify failed: ${verify_res.ok ? '' : JSON.stringify(verify_res.error)}`
			);
			assert.strictEqual(verify_res.result.username, 'verifyuser');
		});

		test('signup with email-only invite fails when only username matches', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Admin creates email-only invite
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'alice@example.com' },
				headers: test_app.create_session_headers()
			});
			// User signs up with matching username but no email
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'alice', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
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
				roles: [ROLE_ADMIN]
			});
			// Admin creates invite with both fields
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'both@example.com', username: 'bothuser' },
				headers: test_app.create_session_headers()
			});
			// Only email matches — should fail
			const res1 = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'wronguser', password: 'securepassword123', email: 'both@example.com' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res1.status, 403);

			// Only username matches — should fail
			const res2 = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'bothuser', password: 'securepassword123', email: 'wrong@example.com' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res2.status, 403);

			// Both match — should succeed
			const res3 = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'bothuser', password: 'securepassword123', email: 'both@example.com' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res3.status, 200);
		});

		test('signup with case-variant email matches email-only invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Admin creates invite with mixed-case email
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { email: 'Alice@Example.COM' },
				headers: test_app.create_session_headers()
			});
			// User signs up with lowercase email
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'aliceuser', password: 'securepassword123', email: 'alice@example.com' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res.status, 200);
		});

		test('signup with case-variant username matches username-only invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Admin creates invite with mixed-case username
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: 'CaseUser' },
				headers: test_app.create_session_headers()
			});
			// User signs up with lowercase username
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'caseuser', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res.status, 200);
		});

		test('signup rejects invalid username format', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: '123invalid', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res.status, 400);
		});

		test('signup rejects too-short password', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'validuser', password: 'short' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res.status, 400);
		});

		test('signup rejects username exceeding max length', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'a'.repeat(40), password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res.status, 400);
		});

		test('duplicate username signup gets 409 even with unclaimed invite', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: 'raceuser' },
				headers: test_app.create_session_headers()
			});
			// First signup succeeds
			const res1 = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'raceuser', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res1.status, 200);

			// Insert a second invite for the same username — account already exists
			// from the first signup, so the unique constraint rejects the second signup
			await query_create_invite({ db: get_db() }, { username: 'raceuser', created_by: null });
			const res2 = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'raceuser', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
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
				roles: [ROLE_ADMIN]
			});
			const create_r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_create_action_spec,
				params: { username: 'claimedel' },
				headers: test_app.create_session_headers()
			});
			assert.ok(create_r.ok);
			// Sign up to claim it
			await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'claimedel', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			// Try to delete the now-claimed invite
			const del_r = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: invite_delete_action_spec,
				params: { invite_id: create_r.result.invite.id },
				headers: test_app.create_session_headers()
			});
			assert_rpc_error(del_r, JSONRPC_ERROR_CODES.not_found, ERROR_INVITE_NOT_FOUND);
		});
	});

	describe('open signup', () => {
		test('signup succeeds without invite when open_signup is enabled', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Enable open signup via admin RPC
			const enable_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_update_action_spec,
				params: { open_signup: true },
				headers: test_app.create_session_headers()
			});
			assert.ok(enable_res.ok);
			// Sign up without any invite
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'openuser', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
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
				db: get_db()
			});
			// open_signup defaults to false — no invite means 403
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'closeduser', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
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
				roles: [ROLE_ADMIN]
			});
			// Enable open signup
			const enable_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_update_action_spec,
				params: { open_signup: true },
				headers: test_app.create_session_headers()
			});
			assert.ok(enable_res.ok);
			// Try to sign up with the bootstrapped account's username
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{
					username: test_app.backend.account.username,
					password: 'securepassword123'
				},
				{ host: 'localhost', origin: 'http://localhost:5173' }
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
				roles: [ROLE_ADMIN]
			});
			// Enable open signup
			const enable_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_update_action_spec,
				params: { open_signup: true },
				headers: test_app.create_session_headers()
			});
			assert.ok(enable_res.ok);
			// Disable open signup
			const disable_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_update_action_spec,
				params: { open_signup: false },
				headers: test_app.create_session_headers()
			});
			assert.ok(disable_res.ok);
			// Signup without invite should now fail
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'toggleduser', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
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
				roles: [ROLE_ADMIN]
			});
			// Enable open signup
			const enable_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_update_action_spec,
				params: { open_signup: true },
				headers: test_app.create_session_headers()
			});
			assert.ok(enable_res.ok);
			// Sign up
			await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'audituser', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			// Check audit log
			const rows = await get_db().query<{ event_type: string; metadata: unknown }>(
				`SELECT event_type, metadata FROM audit_log WHERE event_type = 'signup' ORDER BY seq DESC LIMIT 1`
			);
			assert.strictEqual(rows.length, 1);
			const metadata = rows[0]!.metadata as any;
			assert.strictEqual(metadata.open_signup, true);
			assert.strictEqual(metadata.username, 'audituser');
		});

		// --- Failure-outcome audit emissions ---
		//
		// Parity with `admin_actions.failure_audit.db.test.ts` and `role_grant_offer`'s
		// failure-row coverage — every signup denial path emits an `outcome:
		// 'failure'` row so operators have forensic visibility into who tried to
		// sign up and why it failed, not just who succeeded. Find + claim run
		// inside the same tx under `SELECT ... FOR UPDATE` (see
		// `query_invite_find_unclaimed_match_for_update` in `invite_queries.ts`),
		// so there is no race window between find and claim — the
		// `no_match`, `signup_conflict`, and `internal_error` failure reasons
		// are the entire denial taxonomy.

		test('signup failure with no matching invite emits outcome=failure audit row', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'nomatch', password: 'securepassword123', email: 'nomatch@example.com' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res.status, 403);
			const rows = await get_db().query<{
				event_type: string;
				outcome: string;
				account_id: string | null;
				actor_id: string | null;
				metadata: unknown;
			}>(
				`SELECT event_type, outcome, account_id, actor_id, metadata
				 FROM audit_log WHERE event_type = 'signup' ORDER BY seq DESC LIMIT 1`
			);
			assert.strictEqual(rows.length, 1);
			const row = rows[0]!;
			assert.strictEqual(row.outcome, 'failure');
			assert.strictEqual(row.account_id, null);
			assert.strictEqual(row.actor_id, null);
			const metadata = row.metadata as any;
			assert.strictEqual(metadata.reason, 'no_match');
			assert.strictEqual(metadata.username, 'nomatch');
			assert.strictEqual(metadata.email, 'nomatch@example.com');
			assert.strictEqual(metadata.invite_id, undefined);
		});

		test('signup_conflict (invite-gated) emits outcome=failure audit row with invite_id', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Create an invite directly to bypass the route-level account-exists check.
			// The invite carries the bootstrapped account's username so the find succeeds
			// but the account insert collides on the case-insensitive username unique.
			const { id: invite_id } = await query_create_invite(
				{ db: get_db() },
				{ username: test_app.backend.account.username, created_by: null }
			);
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: test_app.backend.account.username, password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res.status, 409);
			const rows = await get_db().query<{
				event_type: string;
				outcome: string;
				account_id: string | null;
				actor_id: string | null;
				metadata: unknown;
			}>(
				`SELECT event_type, outcome, account_id, actor_id, metadata
				 FROM audit_log WHERE event_type = 'signup' ORDER BY seq DESC LIMIT 1`
			);
			assert.strictEqual(rows.length, 1);
			const row = rows[0]!;
			assert.strictEqual(row.outcome, 'failure');
			// Transaction rolled back — no account was persisted.
			assert.strictEqual(row.account_id, null);
			assert.strictEqual(row.actor_id, null);
			const metadata = row.metadata as any;
			assert.strictEqual(metadata.reason, 'signup_conflict');
			assert.strictEqual(metadata.username, test_app.backend.account.username);
			assert.strictEqual(metadata.invite_id, invite_id);
			assert.strictEqual(metadata.open_signup, undefined);
		});

		test('open-signup conflict emits outcome=failure with open_signup=true', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Enable open signup
			const enable_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: app_settings_update_action_spec,
				params: { open_signup: true },
				headers: test_app.create_session_headers()
			});
			assert.ok(enable_res.ok);
			// Collide on the bootstrapped account's username
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: test_app.backend.account.username, password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			assert.strictEqual(res.status, 409);
			const rows = await get_db().query<{ outcome: string; metadata: unknown }>(
				`SELECT outcome, metadata FROM audit_log WHERE event_type = 'signup' ORDER BY seq DESC LIMIT 1`
			);
			assert.strictEqual(rows.length, 1);
			const row = rows[0]!;
			assert.strictEqual(row.outcome, 'failure');
			const metadata = row.metadata as any;
			assert.strictEqual(metadata.reason, 'signup_conflict');
			assert.strictEqual(metadata.open_signup, true);
			// No invite_id under open_signup — the find never ran.
			assert.strictEqual(metadata.invite_id, undefined);
		});
	});

	// --- Denial-time floor ---
	//
	// Without a floor, an attacker can distinguish `no_match` (cheap — bails
	// before tx) from `signup_conflict` (Argon2 + tx + rollback) by response
	// time and use the gap as a username-enumeration oracle. The floor races
	// failure work against `setTimeout(floor + jitter)` so observed time is
	// `max(work, delay)`. Mirrors login's `DEFAULT_LOGIN_FAIL_FLOOR_MS`.
	describe('signup denial timing floor', () => {
		// Use a dedicated route-spec factory with a non-zero floor — the
		// suite-wide factory disables the floor (`signup_fail_floor_ms: 0`)
		// so unrelated failure tests don't each wait ~250ms.
		const FLOOR_MS = 80;
		const create_route_specs_floored = (ctx: AppServerContext): Array<RouteSpec> => [
			...prefix_route_specs('/api/account', [
				...create_signup_route_specs(ctx.deps, {
					session_options,
					ip_rate_limiter: null,
					signup_account_rate_limiter: null,
					signup_fail_floor_ms: FLOOR_MS,
					signup_fail_jitter_ms: 0 // determinism for the assertion
				})
			]),
			...create_rpc_endpoint({
				path: RPC_PATH,
				actions: [...create_admin_actions(ctx.deps), ...create_account_actions(ctx.deps)],
				log: ctx.deps.log
			})
		];

		test('no_match (403) takes at least the floor', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_route_specs_floored,
				db: get_db()
			});
			const t0 = performance.now();
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'nomatchfloor', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			const elapsed = performance.now() - t0;
			assert.strictEqual(res.status, 403);
			// Generous lower bound — setTimeout granularity is ~1-15ms across
			// platforms, and `performance.now()` is monotonic but bucketed.
			assert.ok(
				elapsed >= FLOOR_MS - 10,
				`expected elapsed (${elapsed.toFixed(1)}ms) >= ${FLOOR_MS - 10}ms (floor=${FLOOR_MS})`
			);
		});

		test('signup_conflict (409) takes at least the floor', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_route_specs_floored,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			// Seed an invite for the bootstrapped account's username so the
			// find succeeds inside the tx and the unique constraint fires
			// on the account insert.
			await query_create_invite(
				{ db: get_db() },
				{ username: test_app.backend.account.username, created_by: null }
			);
			const t0 = performance.now();
			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: test_app.backend.account.username, password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);
			const elapsed = performance.now() - t0;
			assert.strictEqual(res.status, 409);
			assert.ok(
				elapsed >= FLOOR_MS - 10,
				`expected elapsed (${elapsed.toFixed(1)}ms) >= ${FLOOR_MS - 10}ms (floor=${FLOOR_MS})`
			);
		});
	});

	// --- Internal-error fallback failure audit ---
	//
	// The catch handler classifies thrown errors as `NoMatchingInviteError`,
	// `is_pg_unique_violation`, or everything else. The else branch is the
	// catch-all: tx rolled back, no account persisted, but the *attempt*
	// must leave a forensic trail. Emit an `outcome: 'failure'` row with
	// `reason: 'internal_error'` before the rethrow.
	describe('internal_error fallback audit', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		test('a tx rejection emits outcome=failure reason=internal_error before rethrow', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			await query_create_invite({ db: get_db() }, { username: 'internalerr', created_by: null });

			// Make the signup tx body reject with a generic Error — the catch
			// handler should treat this as an `internal_error` and emit the
			// failure audit before rethrowing.
			const db = get_db();
			vi.spyOn(db, 'transaction').mockImplementation(async () => {
				throw new Error('simulated tx fault');
			});
			// Silence the rethrow's log output so the test report stays clean.
			vi.spyOn(console, 'error').mockImplementation(() => {});

			const res = await json_request(
				test_app.app,
				'/api/account/signup',
				{ username: 'internalerr', password: 'securepassword123' },
				{ host: 'localhost', origin: 'http://localhost:5173' }
			);

			// Status is not 200 — the rethrow propagates. Hono's default
			// surfaces a 500 when nothing catches, but the framework's exact
			// behavior isn't load-bearing here; the audit row is.
			assert.notStrictEqual(res.status, 200);

			const rows = await db.query<{
				event_type: string;
				outcome: string;
				account_id: string | null;
				metadata: unknown;
			}>(
				`SELECT event_type, outcome, account_id, metadata
				 FROM audit_log WHERE event_type = 'signup' ORDER BY seq DESC LIMIT 1`
			);
			assert.strictEqual(rows.length, 1);
			const row = rows[0]!;
			assert.strictEqual(row.outcome, 'failure');
			// Tx rolled back — no account persisted.
			assert.strictEqual(row.account_id, null);
			const metadata = row.metadata as any;
			assert.strictEqual(metadata.reason, 'internal_error');
			assert.strictEqual(metadata.username, 'internalerr');
			// `invite` is assigned inside the tx body, which never executed
			// (we mocked `transaction` to throw before invoking the callback),
			// so no invite_id is recorded.
			assert.strictEqual(metadata.invite_id, undefined);
		});
	});
});
