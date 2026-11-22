/**
 * The REST success rows are written in the transaction of the change they
 * report: `/login` with its session, `/password` with its revocations, and
 * signup with its account — the row last before the commit. So a refused
 * audit INSERT is a 500 that changed nothing, and a committed change is never
 * left unaudited; a response, once sent, has its row already committed, so a
 * read after it sees the row whether or not the server waits for its effects.
 * Bootstrap is pinned in `rate_limiter.bootstrap.db.test.ts` and the db-admin
 * row delete in `http/db_routes.db.test.ts`; `/logout` was already in its
 * route transaction (`session_cookie_commit.db.test.ts`).
 *
 * @module
 */

import { assert, test } from 'vitest';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_account_route_specs } from '#lib/auth/account_routes.ts';
import { create_signup_route_specs } from '#lib/auth/signup_routes.ts';
import { query_app_settings_update } from '#lib/auth/app_settings_queries.ts';
import { prefix_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { ConnectionCloser, ConnectionCloseTarget } from '#lib/actions/connection_closer.ts';
import { create_test_app, type TestApp } from '#lib/testing/test_app.ts';
import { create_test_request_headers } from '#lib/testing/test_origin.ts';
import { DEFAULT_TEST_PASSWORD } from '#lib/testing/test_credentials.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import type { Db } from '#lib/db/db.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { describe_db } from '../auth_db_default.ts';
import { create_gated_db, is_audit_insert, type GatedDb } from '../gated_db.ts';

const session_options = create_session_config('test_session');

/** What the refused audit INSERT throws. */
const audit_refused = (): Error => new Error('audit insert refused');

interface Harness {
	gated: GatedDb;
	test_app: TestApp;
	/** Every close the routes made, through the backend's closer. */
	closes: Array<ConnectionCloseTarget>;
	keeper_id: Uuid;
}

const setup = async (
	get_db: () => Db,
	options: { await_pending_effects?: boolean } = {}
): Promise<Harness> => {
	const gated = create_gated_db(get_db());
	const closes: Array<ConnectionCloseTarget> = [];
	const probe: ConnectionCloser = {
		close_connections: (target) => {
			closes.push(target);
			return 0;
		},
		close_all_connections: () => 0
	};
	const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => {
		ctx.deps.connection_closer.add(probe);
		return prefix_route_specs('/api/account', [
			...create_account_route_specs(ctx.deps, {
				session_options,
				login_ip_rate_limiter: null,
				login_account_rate_limiter: null,
				login_fail_floor_ms: 0
			}),
			...create_signup_route_specs(ctx.deps, {
				session_options,
				signup_ip_rate_limiter: null,
				signup_account_rate_limiter: null,
				signup_fail_floor_ms: 0
			})
		]);
	};
	const test_app = await create_test_app({
		session_options,
		db: gated.db,
		create_route_specs,
		...(options.await_pending_effects !== undefined && {
			app_options: { await_pending_effects: options.await_pending_effects }
		})
	});
	return { gated, test_app, closes, keeper_id: test_app.backend.account.id };
};

const post = (
	h: Harness,
	path: string,
	body: unknown,
	headers?: Record<string, string>
): Promise<Response> =>
	Promise.resolve(
		h.test_app.app.request(path, {
			method: 'POST',
			headers: create_test_request_headers({ 'content-type': 'application/json', ...headers }),
			body: JSON.stringify(body)
		})
	);

const login = (h: Harness): Promise<Response> =>
	post(h, '/api/account/login', { username: 'keeper', password: DEFAULT_TEST_PASSWORD });

const change_password = (h: Harness): Promise<Response> =>
	post(
		h,
		'/api/account/password',
		{ current_password: DEFAULT_TEST_PASSWORD, new_password: 'changed-password-123' },
		{ cookie: `${session_options.cookie_name}=${h.test_app.backend.session_cookie}` }
	);

const signup = (h: Harness): Promise<Response> =>
	post(h, '/api/account/signup', { username: 'newcomer', password: 'newcomer-password-123' });

const count = async (db: Db, sql: string, values: Array<unknown>): Promise<number> => {
	const row = await db.query_one<{ n: number }>(sql, values);
	return row?.n ?? 0;
};

const session_count = (db: Db, account_id: Uuid): Promise<number> =>
	count(db, 'SELECT count(*)::int AS n FROM auth_session WHERE account_id = $1', [account_id]);

const token_count = (db: Db, account_id: Uuid): Promise<number> =>
	count(db, 'SELECT count(*)::int AS n FROM api_token WHERE account_id = $1', [account_id]);

const password_hash = async (db: Db, account_id: Uuid): Promise<string | undefined> =>
	(
		await db.query_one<{ password_hash: string }>(
			'SELECT password_hash FROM account WHERE id = $1',
			[account_id]
		)
	)?.password_hash;

const audit_rows = (
	db: Db,
	event_type: string
): Promise<Array<{ outcome: string; metadata: Record<string, unknown> | null }>> =>
	db.query('SELECT outcome, metadata FROM audit_log WHERE event_type = $1 ORDER BY seq', [
		event_type
	]);

describe_db('REST success audit rows are written in the change transaction', (get_db) => {
	install_audit_drift_guard();

	test('a login whose audit row is refused mints no session', async () => {
		const h = await setup(get_db);
		try {
			const db = get_db();
			const sessions_before = await session_count(db, h.keeper_id);
			h.gated.refuse_in_transaction(is_audit_insert, audit_refused());

			const res = await login(h);

			assert.strictEqual(res.status, 500);
			assert.deepStrictEqual(
				res.headers.getSetCookie(),
				[],
				'no cookie for a session never minted'
			);
			assert.strictEqual(await session_count(db, h.keeper_id), sessions_before);
			assert.deepStrictEqual(await audit_rows(db, 'login'), []);
			assert.deepStrictEqual(h.closes, []);
		} finally {
			await h.test_app.cleanup();
		}
	});

	test('a password change whose audit row is refused changes nothing and closes nothing', async () => {
		const h = await setup(get_db);
		try {
			const db = get_db();
			const hash_before = await password_hash(db, h.keeper_id);
			const sessions_before = await session_count(db, h.keeper_id);
			const tokens_before = await token_count(db, h.keeper_id);
			assert.ok(sessions_before > 0 && tokens_before > 0, 'the keeper has credentials to revoke');
			h.gated.refuse_in_transaction(is_audit_insert, audit_refused());

			const res = await change_password(h);

			assert.strictEqual(res.status, 500);
			assert.deepStrictEqual(
				res.headers.getSetCookie(),
				[],
				'no clear for a change that rolled back'
			);
			assert.strictEqual(await password_hash(db, h.keeper_id), hash_before);
			assert.strictEqual(await session_count(db, h.keeper_id), sessions_before);
			assert.strictEqual(await token_count(db, h.keeper_id), tokens_before);
			assert.deepStrictEqual(h.closes, [], 'no close for a revocation that rolled back');
			assert.deepStrictEqual(await audit_rows(db, 'password_change'), []);
		} finally {
			await h.test_app.cleanup();
		}
	});

	test('a signup whose audit row is refused creates no account and leaves an internal_error row', async () => {
		const h = await setup(get_db);
		try {
			const db = get_db();
			await query_app_settings_update({ db }, true, h.test_app.backend.actor.id);
			h.gated.refuse_in_transaction(is_audit_insert, audit_refused());

			const res = await signup(h);

			assert.strictEqual(res.status, 500);
			assert.deepStrictEqual(res.headers.getSetCookie(), []);
			assert.strictEqual(
				await count(db, 'SELECT count(*)::int AS n FROM account WHERE username = $1', ['newcomer']),
				0
			);
			// the attempt's failure row is written on the pool, outside the rollback
			assert.deepStrictEqual(await audit_rows(db, 'signup'), [
				{
					outcome: 'failure',
					metadata: { username: 'newcomer', reason: 'internal_error', open_signup: true }
				}
			]);
		} finally {
			await h.test_app.cleanup();
		}
	});

	test('a signup whose settings load fails leaves the pre-transaction internal_error row', async () => {
		const h = await setup(get_db);
		try {
			const db = get_db();
			const stalled = h.gated.stall((sql) => sql.includes('FROM app_settings'));
			const pending = signup(h);
			await stalled.reached;
			stalled.fail(new Error('settings load failed'));
			const res = await pending;

			assert.strictEqual(res.status, 500);
			// no `open_signup` (the load is what failed) and no `invite_id`, as
			// the Rust spine's pre-transaction failure row
			assert.deepStrictEqual(await audit_rows(db, 'signup'), [
				{ outcome: 'failure', metadata: { username: 'newcomer', reason: 'internal_error' } }
			]);
		} finally {
			await h.test_app.cleanup();
		}
	});

	test('a signup whose transaction never begins leaves the pre-transaction internal_error row', async () => {
		const h = await setup(get_db);
		try {
			const db = get_db();
			await query_app_settings_update({ db }, true, h.test_app.backend.actor.id);
			// the next transaction is signup's own: fail it before it begins,
			// as a refused `BEGIN` does
			const held = h.gated.hold_begin();
			const pending = signup(h);
			await held.reached;
			held.fail(new Error('BEGIN refused'));
			const res = await pending;

			assert.strictEqual(res.status, 500);
			// no `open_signup`, though signup is open: the transaction never
			// began, which the Rust spine reads as a pre-transaction failure
			assert.deepStrictEqual(await audit_rows(db, 'signup'), [
				{ outcome: 'failure', metadata: { username: 'newcomer', reason: 'internal_error' } }
			]);
		} finally {
			await h.test_app.cleanup();
		}
	});

	test('a login answered without waiting for its effects has its row committed already', async () => {
		const h = await setup(get_db, { await_pending_effects: false });
		try {
			const db = get_db();
			// a pool-level audit INSERT would be held here, so a row written on the
			// pool after the response could not have landed by the read below
			const stalled = h.gated.stall(is_audit_insert);
			const res = await login(h);
			assert.strictEqual(res.status, 200);

			assert.deepStrictEqual(
				(await audit_rows(db, 'login')).map((r) => r.outcome),
				['success'],
				'the row is read back as soon as the response is'
			);
			stalled.release();
		} finally {
			await h.test_app.cleanup();
		}
	});

	test('a password change answered without waiting for its effects has its row committed already', async () => {
		const h = await setup(get_db, { await_pending_effects: false });
		try {
			const db = get_db();
			const stalled = h.gated.stall(is_audit_insert);
			const res = await change_password(h);
			assert.strictEqual(res.status, 200);

			assert.deepStrictEqual(
				(await audit_rows(db, 'password_change')).map((r) => r.outcome),
				['success']
			);
			stalled.release();
		} finally {
			await h.test_app.cleanup();
		}
	});
});
