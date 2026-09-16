/**
 * Concurrent-race test for `POST /password`.
 *
 * Asserts the verify-write-atomic contract: when two requests submit the
 * same correct `current_password` with different `new_password`s, exactly
 * one must land — the loser's `current_password` was correct at read-time
 * but stale at commit-time (the winner's UPDATE intervened), and the
 * route must surface that as 401 rather than silently overwriting the
 * winner's change.
 *
 * Real `pg` only — PGlite serializes transactions tightly enough that the
 * winner's `query_session_revoke_all_for_account` cascade deletes the
 * loser's session row before its middleware reads it, so the loser 401s
 * at session middleware (different mechanism, same status code, but
 * password verify is never reached and the audit envelope says nothing
 * about a password attempt). The race we want to exercise — both requests
 * pass middleware concurrently, both verify against the pre-update hash,
 * second UPDATE silently clobbers — only surfaces on parallel pool
 * connections. Skipped when `TEST_DATABASE_URL` is unset.
 *
 * @module
 */

import { assert, beforeEach, afterEach, test } from 'vitest';

import { create_test_app, type TestApp } from '$lib/testing/app_server.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_account_route_specs } from '$lib/auth/account_routes.ts';
import { prefix_route_specs } from '$lib/http/route_spec.ts';
import { query_audit_log_list } from '$lib/auth/audit_log_queries.ts';
import { create_describe_db, auth_integration_truncate_tables } from '$lib/testing/db.ts';

import { pg_factory } from '../db_fixture.ts';

const session_options = create_session_config('test_session');
const ORIGINAL_PW = 'original-pw-12345';
const RACE_A_NEW_PW = 'race-a-pw-9876543';
const RACE_B_NEW_PW = 'race-b-pw-1234567';

const login_headers = {
	'Content-Type': 'application/json',
	host: 'localhost',
	origin: 'http://localhost:5173'
};

const post_password = (
	app: TestApp['app'],
	cookie: string,
	current_password: string,
	new_password: string
) =>
	app.request('/api/account/password', {
		method: 'POST',
		headers: { ...login_headers, cookie },
		body: JSON.stringify({ current_password, new_password })
	});

const try_login = (app: TestApp['app'], password: string) =>
	app.request('/api/account/login', {
		method: 'POST',
		headers: login_headers,
		body: JSON.stringify({ username: 'keeper', password })
	});

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

describe_pg('password change concurrent race', (get_db) => {
	let test_app: TestApp;
	let cookie_a: string;
	let cookie_b: string;

	beforeEach(async () => {
		test_app = await create_test_app({
			session_options,
			db: get_db(),
			db_type: 'postgres',
			password_value: ORIGINAL_PW,
			create_route_specs: (ctx) => [
				...prefix_route_specs(
					'/api/account',
					create_account_route_specs(ctx.deps, {
						session_options,
						ip_rate_limiter: null,
						login_account_rate_limiter: null,
						login_fail_floor_ms: 0
					})
				)
			]
		});

		const login_a = await test_app.app.request('/api/account/login', {
			method: 'POST',
			headers: login_headers,
			body: JSON.stringify({ username: 'keeper', password: ORIGINAL_PW })
		});
		assert.strictEqual(login_a.status, 200);
		cookie_a = login_a.headers.get('set-cookie')!.split(';')[0]!;

		const login_b = await test_app.app.request('/api/account/login', {
			method: 'POST',
			headers: login_headers,
			body: JSON.stringify({ username: 'keeper', password: ORIGINAL_PW })
		});
		assert.strictEqual(login_b.status, 200);
		cookie_b = login_b.headers.get('set-cookie')!.split(';')[0]!;
	});

	afterEach(() => test_app.cleanup());

	test('exactly one of two concurrent password changes lands; loser must observe 401', async () => {
		const [res_a, res_b] = await Promise.all([
			post_password(test_app.app, cookie_a, ORIGINAL_PW, RACE_A_NEW_PW),
			post_password(test_app.app, cookie_b, ORIGINAL_PW, RACE_B_NEW_PW)
		]);

		const successes = [res_a, res_b].filter((r) => r.status === 200);
		const failures = [res_a, res_b].filter((r) => r.status === 401);
		assert.strictEqual(
			successes.length,
			1,
			'exactly one concurrent password change should succeed (the racer must not silently clobber)'
		);
		assert.strictEqual(
			failures.length,
			1,
			'the racing loser must return 401 (current_password stale at commit time)'
		);

		const login_with_a = await try_login(test_app.app, RACE_A_NEW_PW);
		const login_with_b = await try_login(test_app.app, RACE_B_NEW_PW);
		const a_works = login_with_a.status === 200;
		const b_works = login_with_b.status === 200;
		assert.ok(
			a_works !== b_works,
			'exactly one of (RACE_A_NEW_PW, RACE_B_NEW_PW) must authenticate'
		);

		const login_with_original = await try_login(test_app.app, ORIGINAL_PW);
		assert.strictEqual(
			login_with_original.status,
			401,
			'original password must not authenticate after the winner committed'
		);

		const losing_new_pw = a_works ? RACE_B_NEW_PW : RACE_A_NEW_PW;
		const login_with_loser = await try_login(test_app.app, losing_new_pw);
		assert.strictEqual(
			login_with_loser.status,
			401,
			"the racing loser's new_password must not have landed — verify-write must be atomic"
		);

		// Audit completeness: exactly one success + one failure for password_change.
		const audit_events = await query_audit_log_list(
			{ db: test_app.backend.deps.db },
			{ event_type: 'password_change' }
		);
		const success_rows = audit_events.filter((e) => e.outcome === 'success');
		const failure_rows = audit_events.filter((e) => e.outcome === 'failure');
		assert.strictEqual(
			success_rows.length,
			1,
			'exactly one password_change success row should be audited'
		);
		assert.strictEqual(
			failure_rows.length,
			1,
			'the racing loser must emit a password_change failure audit row'
		);
	});

	test('same new_password on both racers — winner lands, loser still 401s', async () => {
		// Edge case: both submit identical `new_password`. The conditional-UPDATE
		// fix must still split them — first commits with `WHERE password_hash = X`,
		// second sees `password_hash` already changed and gets 0 rows affected.
		const SHARED_NEW_PW = 'shared-new-pw-7777';

		const [res_a, res_b] = await Promise.all([
			post_password(test_app.app, cookie_a, ORIGINAL_PW, SHARED_NEW_PW),
			post_password(test_app.app, cookie_b, ORIGINAL_PW, SHARED_NEW_PW)
		]);

		const statuses = [res_a.status, res_b.status].sort((a, b) => a - b);
		assert.deepStrictEqual(
			statuses,
			[200, 401],
			'one 200 + one 401 even with identical new_passwords'
		);

		const login_after = await try_login(test_app.app, SHARED_NEW_PW);
		assert.strictEqual(login_after.status, 200, 'shared new_password should authenticate');
	});
});
