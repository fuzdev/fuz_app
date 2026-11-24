/**
 * `self_service_role_set` in flight across a removal of the caller's account.
 *
 * The rule is the dead credential's: a toggle authorized before its account is
 * deleted or purged writes nothing after it — no grant enabled or revoked on
 * the tombstone (where an undelete would bring it back), no success row, and
 * no foreign-key 500 on a purged actor. The handler takes the caller's account
 * row first (`query_account_lock_live`), the row a delete's tombstone and a
 * purge's `DELETE` write, so the two are ordered: the toggle is refused with
 * the dead credential's 401, or the removal waits for it to commit.
 *
 * Exact, not hammered. On every driver, a toggle authorized before the removal
 * is held before its transaction begins (`hold_begin`) while the removal
 * commits, then released. On real `pg` only (`FUZ_TEST_POSTGRES_URL`), the lock is
 * shown to serialize in both directions, and the account lock is replayed
 * against the writers that take the caller's row beside other rows — another
 * admin's removal, whose last-admin guard locks every admin's account in id
 * order, and an admin-offer accept that share-locks the caller as its grantor:
 * each commits on both sides, in both orders. The in-memory drivers have one
 * connection, so a second transaction would queue behind the held one whatever
 * it locks.
 *
 * Twin of the Rust `fuz_auth` `tests/self_service_role_races.rs`.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { create_test_app, type TestAccount, type TestApp } from '#lib/testing/test_app.ts';
import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import { create_self_service_role_actions } from '#lib/auth/self_service_role_actions.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import { rpc_call } from '#lib/testing/rpc_helpers.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { create_role_registry, ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { ERROR_AUTHENTICATION_REQUIRED } from '#lib/http/error_schemas.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import { auth_integration_truncate_tables } from '#lib/testing/db.ts';
import { create_describe_db } from '#lib/testing/describe_db.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { Db } from '#lib/db/db.ts';

import { describe_db, pg_factory } from '../db_fixture.ts';
import { create_gated_db, type GatedDb } from '../gated_db.ts';

const RPC_PATH = '/api/rpc';

/** The self-service-eligible role the caller toggles. */
const ROLE = 'race_self_role';

/** How long a lock wait the test arranged may take to show, a bound on a hang only. */
const LOCK_WAIT_DEADLINE_MS = 20_000;

const roles = create_role_registry([{ name: ROLE, grant_paths: ['self_service'] }]);

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_rpc_endpoint({
		notification_sender: ctx.deps.notification_sender,
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: [
			...create_standard_rpc_actions(ctx.deps, { roles, authorize: () => true }),
			...create_self_service_role_actions(ctx.deps, { eligible_roles: [ROLE], roles })
		],
		log: ctx.deps.log
	});

type Answer = Awaited<ReturnType<typeof rpc_call>>;

/** The fixture: the keeper removes; `caller` toggles, holding `caller_roles`. */
const setup = async (gated: GatedDb, caller_roles: Array<string> = []) => {
	const test_app: TestApp = await create_test_app({
		session_cookie_name: 'test_session',
		db: gated.db,
		create_route_specs
	});
	const caller = await test_app.create_account({ username: 'race_caller', roles: caller_roles });
	const call = (method: string, params: unknown, headers: Record<string, string>) =>
		rpc_call({ app: test_app.app, path: RPC_PATH, method, params, headers });
	const toggle = (enabled: boolean) =>
		call('self_service_role_set', { role: ROLE, enabled }, caller.create_session_headers());
	const del = (account_id: string) =>
		call('account_delete', { account_id }, test_app.create_session_headers());
	const purge = (account_id: string) =>
		rpc_call({
			app: test_app.app,
			path: RPC_PATH,
			method: 'account_purge',
			params: { account_id, confirm: true },
			headers: test_app.create_daemon_token_headers(),
			suppress_default_origin: true
		});
	const db = test_app.backend.deps.db;
	const count = async (sql: string, params: Array<unknown>): Promise<number> =>
		Number((await db.query<{ n: string }>(sql, params))[0]!.n);
	/** The caller's unrevoked grants of `ROLE`. */
	const active_grants = () =>
		count(
			`SELECT COUNT(*) AS n FROM role_grant
			 WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
			[caller.actor.id, ROLE]
		);
	/** Success rows of `event_type` naming the caller's account. */
	const success_rows = (event_type: string) =>
		count(
			`SELECT COUNT(*) AS n FROM audit_log
			 WHERE event_type = $1 AND outcome = 'success' AND account_id = $2`,
			[event_type, caller.account.id]
		);
	return { test_app, caller, call, toggle, del, purge, db, active_grants, success_rows };
};

const assert_ok = (answer: Answer, label: string): void => {
	assert.ok(answer.ok, `${label}: ${JSON.stringify(answer)}`);
};

const assert_unauthenticated = (answer: Answer, label: string): void => {
	assert.ok(!answer.ok, `${label} is refused: ${JSON.stringify(answer)}`);
	assert.strictEqual(answer.status, 401, label);
	assert.strictEqual(answer.error.code, JSONRPC_ERROR_CODES.unauthenticated, label);
	assert.deepStrictEqual(answer.error.data, { reason: ERROR_AUTHENTICATION_REQUIRED }, label);
};

describe_db('self_service_role_set authorized before its account is removed', (get_db) => {
	install_audit_drift_guard();

	test('an enable authorized before a delete is refused, writing nothing', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const held = gated.hold_begin();
			const toggled = s.toggle(true);
			await held.reached;
			assert_ok(await s.del(s.caller.account.id), 'the delete');
			held.release();
			assert_unauthenticated(await toggled, 'the enable on the tombstone');
			assert.strictEqual(await s.active_grants(), 0, 'no grant on the tombstone');
			assert.strictEqual(await s.success_rows('role_grant_create'), 0, 'no success row');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a disable authorized before a delete is refused, revoking nothing', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated, [ROLE]);
		try {
			const held = gated.hold_begin();
			const toggled = s.toggle(false);
			await held.reached;
			assert_ok(await s.del(s.caller.account.id), 'the delete');
			held.release();
			assert_unauthenticated(await toggled, 'the disable on the tombstone');
			assert.strictEqual(await s.active_grants(), 1, 'the grant is as the delete left it');
			assert.strictEqual(await s.success_rows('role_grant_revoke'), 0, 'no success row');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('an enable authorized before a purge is refused, writing nothing', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const held = gated.hold_begin();
			const toggled = s.toggle(true);
			await held.reached;
			assert_ok(await s.purge(s.caller.account.id), 'the purge');
			held.release();
			assert_unauthenticated(await toggled, 'the enable on the purged account');
			assert.strictEqual(await s.success_rows('role_grant_create'), 0, 'no success row');
		} finally {
			await s.test_app.cleanup();
		}
	});
});

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

/**
 * Backends waiting on a lock `holder_pid` holds — scoped to the held
 * transaction, so another session's lock wait can't pass for the second's.
 */
const blocked_by = async (db: Db, holder_pid: number): Promise<number> =>
	Number(
		(
			await db.query<{ n: string }>(
				`SELECT COUNT(*) AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
				[holder_pid]
			)
		)[0]!.n
	);

/**
 * Hold `first` at its commit, start `second`, and release the commit once
 * `second` waits on a lock the held transaction holds — or, failing the case,
 * once it has answered without waiting. Returns both answers and whether `second` waited.
 */
const race = async <A, B>(
	gated: GatedDb,
	db: Db,
	first: () => Promise<A>,
	second: () => Promise<B>
): Promise<{ first: A; second: B; waited: boolean }> => {
	const held = gated.hold_commit();
	const a = first();
	await held.reached;
	const [holder] = await (await held.transaction).query<{ pid: number }>(
		'SELECT pg_backend_pid() AS pid'
	);
	const state = { settled: false };
	const b = second();
	b.then(
		() => (state.settled = true),
		() => (state.settled = true)
	);
	let waited = false;
	try {
		const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
		while (!state.settled) {
			if ((await blocked_by(db, holder!.pid)) >= 1) {
				waited = true;
				break;
			}
			assert.ok(Date.now() < deadline, 'the second neither waited nor answered');
			await wait(5);
		}
	} finally {
		// released on a failure too, so no later test waits on its row lock
		held.release();
	}
	return { first: await a, second: await b, waited };
};

describe_pg('self_service_role_set across a removal: the account lock serializes', (get_db) => {
	install_audit_drift_guard();

	test('an enable waits on an uncommitted delete of its account, then is refused', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const r = await race(
				gated,
				s.db,
				() => s.del(s.caller.account.id),
				() => s.toggle(true)
			);
			assert_ok(r.first, 'the delete');
			assert.ok(r.waited, 'the enable waits on the tombstone');
			assert_unauthenticated(r.second, 'the enable that waited');
			assert.strictEqual(await s.active_grants(), 0, 'no grant on the tombstone');
			assert.strictEqual(await s.success_rows('role_grant_create'), 0, 'no success row');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a disable waits on an uncommitted delete of its account, then is refused', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated, [ROLE]);
		try {
			const r = await race(
				gated,
				s.db,
				() => s.del(s.caller.account.id),
				() => s.toggle(false)
			);
			assert_ok(r.first, 'the delete');
			assert.ok(r.waited, 'the disable waits on the tombstone');
			assert_unauthenticated(r.second, 'the disable that waited');
			assert.strictEqual(await s.active_grants(), 1, 'the grant is as the delete left it');
			assert.strictEqual(await s.success_rows('role_grant_revoke'), 0, 'no success row');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a delete waits on an uncommitted enable, which commits on the live account', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const r = await race(
				gated,
				s.db,
				() => s.toggle(true),
				() => s.del(s.caller.account.id)
			);
			assert_ok(r.first, 'the enable');
			assert.ok(r.waited, "the delete waits on the enable's account lock");
			assert_ok(r.second, 'the delete');
			assert.strictEqual(await s.success_rows('role_grant_create'), 1, 'one enable, while live');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a purge waits on an uncommitted enable, then removes its grant with the account', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const r = await race(
				gated,
				s.db,
				() => s.toggle(true),
				() => s.purge(s.caller.account.id)
			);
			assert_ok(r.first, 'the enable');
			assert.ok(r.waited, "the purge waits on the enable's account lock");
			assert_ok(r.second, 'the purge');
			assert.strictEqual(await s.active_grants(), 0, 'the purge removed the grant');
		} finally {
			await s.test_app.cleanup();
		}
	});

	/**
	 * An admin caller and a second admin, so the keeper's removal of the second
	 * runs the last-admin guard, which locks every admin's account row — the
	 * caller's among them — in id order.
	 */
	const setup_admins = async (gated: GatedDb) => {
		const s = await setup(gated, [ROLE_ADMIN]);
		const other: TestAccount = await s.test_app.create_account({
			username: 'race_other_admin',
			roles: [ROLE_ADMIN]
		});
		return { ...s, other };
	};

	for (const removal of ['delete', 'purge'] as const) {
		test(`an admin's enable and another admin's ${removal} commit in either order`, async () => {
			const gated = create_gated_db(get_db());
			const s = await setup_admins(gated);
			const remove = () =>
				removal === 'delete' ? s.del(s.other.account.id) : s.purge(s.other.account.id);
			try {
				const enable_first = await race(gated, s.db, () => s.toggle(true), remove);
				assert_ok(enable_first.first, 'the enable');
				assert.ok(enable_first.waited, "the guard waits on the caller's row");
				assert_ok(enable_first.second, `the ${removal}`);
				// and the other order, against a third admin's removal
				const third = await s.test_app.create_account({
					username: 'race_third_admin',
					roles: [ROLE_ADMIN]
				});
				await s.toggle(false);
				const removal_first = await race(
					gated,
					s.db,
					() => (removal === 'delete' ? s.del(third.account.id) : s.purge(third.account.id)),
					() => s.toggle(true)
				);
				assert_ok(removal_first.first, `the ${removal}`);
				assert.ok(removal_first.waited, "the enable waits on the guard's lock on its row");
				assert_ok(removal_first.second, 'the enable');
				assert.strictEqual(await s.active_grants(), 1, 'the enable landed');
			} finally {
				await s.test_app.cleanup();
			}
		});
	}

	test("an admin's enable and an accept of the admin offer it made commit in either order", async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated, [ROLE_ADMIN]);
		try {
			const recipient = await s.test_app.create_account({ username: 'race_recipient' });
			const offer = async (): Promise<string> => {
				const made = await s.call(
					'role_grant_offer_create',
					{ to_account_id: recipient.account.id, role: ROLE_ADMIN },
					s.caller.create_session_headers()
				);
				assert_ok(made, 'the offer');
				assert.ok(made.ok);
				return (made.result as { offer: { id: string } }).offer.id;
			};
			const accept = (offer_id: string) =>
				s.call('role_grant_offer_accept', { offer_id }, recipient.create_session_headers());

			const first_offer = await offer();
			const enable_first = await race(
				gated,
				s.db,
				() => s.toggle(true),
				() => accept(first_offer)
			);
			assert_ok(enable_first.first, 'the enable');
			assert.ok(enable_first.waited, "the accept waits on its grantor's row");
			assert_ok(enable_first.second, 'the accept');

			await s.toggle(false);
			const second_offer = await offer();
			const accept_first = await race(
				gated,
				s.db,
				() => accept(second_offer),
				() => s.toggle(true)
			);
			assert_ok(accept_first.first, 'the accept');
			assert.ok(accept_first.waited, "the enable waits on the accept's share lock");
			assert_ok(accept_first.second, 'the enable');
		} finally {
			await s.test_app.cleanup();
		}
	});
});
