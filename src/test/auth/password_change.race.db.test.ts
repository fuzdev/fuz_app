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
 * The race is built, not hoped for (`race`): the winner is held just before
 * its commit (`create_gated_db`'s `hold_commit`) — its UPDATE and its
 * revoke-all cascade written, uncommitted — while the loser passes the auth
 * middleware (its session still reads as live) and verifies against the
 * pre-update hash it loaded there. Only once the loser has opened its own
 * transaction is the winner's commit released, so the loser's conditional
 * UPDATE meets a changed hash. Left to scheduling, the winner can commit its
 * cascade before the loser's middleware reads the session, and the loser
 * 401s there with `authentication_required` — the same status, but the
 * password verify never runs and no `password_change` row is written.
 *
 * Real `pg` only: the loser's middleware read needs a second database
 * connection while the winner's transaction is open. The in-memory drivers
 * have one connection — the read would queue behind the held transaction and
 * the case would deadlock. Skipped when `TEST_DATABASE_URL` is unset.
 *
 * @module
 */

import { assert, beforeEach, afterEach, test } from 'vitest';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { create_test_app, type TestApp } from '#lib/testing/app_server.ts';
import { TEST_ORIGIN } from '#lib/testing/test_origin.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_account_route_specs } from '#lib/auth/account_routes.ts';
import { prefix_route_specs } from '#lib/http/route_spec.ts';
import { query_audit_log_list } from '#lib/auth/audit_log_queries.ts';
import { ERROR_INVALID_CREDENTIALS } from '#lib/http/error_schemas.ts';
import { create_describe_db, auth_integration_truncate_tables } from '#lib/testing/db.ts';

import { pg_factory } from '../db_fixture.ts';
import { create_gated_db, type GatedDb } from '../gated_db.ts';

const session_options = create_session_config('test_session');
const ORIGINAL_PW = 'original-pw-12345';
const RACE_A_NEW_PW = 'race-a-pw-9876543';
const RACE_B_NEW_PW = 'race-b-pw-1234567';

const login_headers = {
	'Content-Type': 'application/json',
	host: 'localhost',
	origin: TEST_ORIGIN
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

/**
 * Run `winner` up to its commit, then `loser` until it has opened its own
 * transaction — past the auth middleware and the password verify, both of
 * which read the pre-commit state — then release the winner's commit.
 */
const race = async (
	gated: GatedDb,
	winner: () => Response | Promise<Response>,
	loser: () => Response | Promise<Response>
): Promise<{ winner: Response; loser: Response }> => {
	const held = gated.hold_commit();
	const winner_request = Promise.resolve(winner());
	await held.reached;
	let loser_request: Promise<Response> | undefined;
	try {
		loser_request = Promise.resolve(loser());
		const deadline = Date.now() + 2000;
		// a failed request settles before opening a transaction
		let loser_settled = false;
		const settle = () => {
			loser_settled = true;
		};
		loser_request.then(settle, settle);
		while (gated.open_transactions() < 2) {
			assert.ok(!loser_settled, 'the loser settled without opening its transaction');
			assert.ok(Date.now() < deadline, 'the loser opened no transaction within 2s');
			await wait(5);
		}
	} finally {
		held.release();
	}
	return { winner: await winner_request, loser: await loser_request };
};

describe_pg('password change concurrent race', (get_db) => {
	let test_app: TestApp;
	let gated: GatedDb;
	let cookie_a: string;
	let cookie_b: string;

	beforeEach(async () => {
		gated = create_gated_db(get_db());
		test_app = await create_test_app({
			session_options,
			db: gated.db,
			db_type: 'postgres',
			password_value: ORIGINAL_PW,
			create_route_specs: (ctx) => [
				...prefix_route_specs(
					'/api/account',
					create_account_route_specs(ctx.deps, {
						session_options,
						login_ip_rate_limiter: null,
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
		const { winner, loser } = await race(
			gated,
			() => post_password(test_app.app, cookie_a, ORIGINAL_PW, RACE_A_NEW_PW),
			() => post_password(test_app.app, cookie_b, ORIGINAL_PW, RACE_B_NEW_PW)
		);

		assert.strictEqual(
			winner.status,
			200,
			'the first password change to commit succeeds (the racer must not silently clobber)'
		);
		assert.strictEqual(
			loser.status,
			401,
			'the racing loser must return 401 (current_password stale at commit time)'
		);
		assert.deepStrictEqual(
			await loser.json(),
			{ error: ERROR_INVALID_CREDENTIALS },
			'the loser is refused by the conditional UPDATE, not the auth middleware'
		);

		const login_with_a = await try_login(test_app.app, RACE_A_NEW_PW);
		assert.strictEqual(login_with_a.status, 200, "the winner's new_password authenticates");

		const login_with_original = await try_login(test_app.app, ORIGINAL_PW);
		assert.strictEqual(
			login_with_original.status,
			401,
			'original password must not authenticate after the winner committed'
		);

		const login_with_loser = await try_login(test_app.app, RACE_B_NEW_PW);
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
		assert.strictEqual(
			failure_rows[0]!.metadata?.reason,
			'concurrent_change',
			'the failure row names the race, not a wrong password'
		);
	});

	test('same new_password on both racers — winner lands, loser still 401s', async () => {
		// Edge case: both submit identical `new_password`. The conditional-UPDATE
		// fix must still split them — first commits with `WHERE password_hash = X`,
		// second sees `password_hash` already changed and gets 0 rows affected.
		const SHARED_NEW_PW = 'shared-new-pw-7777';

		const { winner, loser } = await race(
			gated,
			() => post_password(test_app.app, cookie_a, ORIGINAL_PW, SHARED_NEW_PW),
			() => post_password(test_app.app, cookie_b, ORIGINAL_PW, SHARED_NEW_PW)
		);

		assert.strictEqual(winner.status, 200, 'the first password change to commit succeeds');
		assert.strictEqual(loser.status, 401, 'the loser 401s even with an identical new_password');
		assert.deepStrictEqual(
			await loser.json(),
			{ error: ERROR_INVALID_CREDENTIALS },
			'the loser is refused by the conditional UPDATE, not the auth middleware'
		);

		const failure_rows = (
			await query_audit_log_list(
				{ db: test_app.backend.deps.db },
				{ event_type: 'password_change' }
			)
		).filter((e) => e.outcome === 'failure');
		assert.strictEqual(failure_rows.length, 1, 'the loser emits one password_change failure row');
		assert.strictEqual(
			failure_rows[0]!.metadata?.reason,
			'concurrent_change',
			'the failure row names the race, not a wrong password'
		);

		const login_after = await try_login(test_app.app, SHARED_NEW_PW);
		assert.strictEqual(login_after.status, 200, 'shared new_password should authenticate');
	});
});
