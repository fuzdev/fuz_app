/**
 * `role_grant_assign` in flight across a removal of either party's account.
 *
 * The rule is offer-create's: an assign writes no grant to a recipient deleted
 * or purged before it — none on the tombstone, where an undelete would bring it
 * back, and no foreign-key 500 on a purged actor — and none by a caller whose
 * own account was removed since its credential was read. The handler locks
 * both parties' account rows in one statement in id order
 * (`query_account_lock_live_many`, `FOR SHARE`) after its authority gates and
 * before it reads the recipient's actors, so the two are ordered: a removed
 * recipient answers as a missing one (404, or the actor mismatch when an actor
 * was named), a removed caller as the dead credential (401), neither audited —
 * or the removal waits for the assign to commit.
 *
 * On every driver, an assign authorized before its caller is deleted, or
 * before its caller's actor is tombstoned by hand (its account left live), is
 * held before its transaction begins (`hold_begin`) while that commits, then
 * released; and an admin assigns to its own account, one id twice in the lock
 * statement. On real `pg` only (`FUZ_TEST_POSTGRES_URL`), the lock is shown to
 * serialize in both directions against a delete of the recipient, and an
 * assign is shown to wait on a purge (a purge waits on an uncommitted assign
 * through the grant's foreign key, lock or not); the lock is replayed in both
 * orders against the writers that take one of the parties' rows: another
 * admin's removal, whose last-admin guard locks every admin's account in id
 * order, the caller's among them, and the recipient's accept, a revoke of its
 * other grant, and its own toggle — each commits on both sides. The in-memory
 * drivers have one connection, so a second transaction would queue behind the
 * held one whatever it locks.
 *
 * One mutation these tests can't see: the lock split into one statement per
 * party, which opens a lock-order cycle only against a transaction that takes
 * both rows in the opposite order between the two statements.
 *
 * Twin of the Rust `fuz_auth` `tests/role_grant_assign_races.rs`.
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
import { ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH } from '#lib/auth/role_grant_offer_action_specs.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import { auth_integration_truncate_tables } from '#lib/testing/db.ts';
import { create_describe_db } from '#lib/testing/describe_db.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { Db } from '#lib/db/db.ts';
import type { DbInvariantExclusions } from '#lib/testing/db_invariant_queries.ts';

import { describe_db, pg_factory } from '../db_fixture.ts';
import { create_gated_db, type GatedDb } from '../gated_db.ts';

const RPC_PATH = '/api/rpc';

/** The admin-grantable role the caller assigns. */
const ROLE = 'race_assign_role';

/** Admin-grantable roles the recipient holds or is offered beside it. */
const OTHER_ROLES = ['race_other_one', 'race_other_two'] as const;

/** The self-service-eligible role the recipient toggles. */
const SELF_ROLE = 'race_self_role';

/** How long a lock wait the test arranged may take to show, a bound on a hang only. */
const LOCK_WAIT_DEADLINE_MS = 20_000;

const roles = create_role_registry([
	{ name: ROLE, grant_paths: ['admin'] },
	...OTHER_ROLES.map((name) => ({ name, grant_paths: ['admin'] })),
	{ name: SELF_ROLE, grant_paths: ['self_service'] }
]);

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_rpc_endpoint({
		notification_sender: ctx.deps.notification_sender,
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: [
			...create_standard_rpc_actions(ctx.deps, { roles, authorize: () => true }),
			...create_self_service_role_actions(ctx.deps, { eligible_roles: [SELF_ROLE], roles })
		],
		log: ctx.deps.log
	});

type Answer = Awaited<ReturnType<typeof rpc_call>>;

/**
 * The fixture: the keeper removes; `caller` (a global admin) assigns to
 * `recipient`, who holds `recipient_roles`.
 */
const setup = async (
	gated: GatedDb,
	recipient_roles: Array<string> = [],
	exclude_db_invariants?: DbInvariantExclusions
) => {
	const test_app: TestApp = await create_test_app({
		session_cookie_name: 'test_session',
		db: gated.db,
		create_route_specs,
		exclude_db_invariants
	});
	const caller = await test_app.create_account({
		username: 'race_caller',
		roles: [ROLE_ADMIN]
	});
	const recipient = await test_app.create_account({
		username: 'race_recipient',
		roles: recipient_roles
	});
	const call = (method: string, params: unknown, headers: Record<string, string>) =>
		rpc_call({ app: test_app.app, path: RPC_PATH, method, params, headers });
	const assign = (to_actor_id?: string) =>
		call(
			'role_grant_assign',
			{
				to_account_id: recipient.account.id,
				role: ROLE,
				...(to_actor_id === undefined ? {} : { to_actor_id })
			},
			caller.create_session_headers()
		);
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
	/** The recipient's unrevoked grants of `ROLE`. */
	const active_grants = () =>
		count(
			`SELECT COUNT(*) AS n FROM role_grant
			 WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
			[recipient.actor.id, ROLE]
		);
	/** `role_grant_create` success rows targeting the recipient's account. */
	const success_rows = () =>
		count(
			`SELECT COUNT(*) AS n FROM audit_log
			 WHERE event_type = 'role_grant_create' AND outcome = 'success'
			 AND target_account_id = $1`,
			[recipient.account.id]
		);
	/** `role_grant_create` rows of any outcome targeting the recipient's account — a refusal here writes none, failure rows included. */
	const audit_rows = () =>
		count(
			`SELECT COUNT(*) AS n FROM audit_log
			 WHERE event_type = 'role_grant_create' AND target_account_id = $1`,
			[recipient.account.id]
		);
	return {
		test_app,
		caller,
		recipient,
		call,
		assign,
		del,
		purge,
		db,
		active_grants,
		success_rows,
		audit_rows
	};
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

/** The answer a missing recipient gets, with no actor named. */
const assert_recipient_not_found = (answer: Answer, label: string): void => {
	assert.ok(!answer.ok, `${label} is refused: ${JSON.stringify(answer)}`);
	assert.strictEqual(answer.status, 404, label);
	assert.strictEqual(answer.error.code, JSONRPC_ERROR_CODES.not_found, label);
};

/** The answer a missing recipient gets, with an actor named. */
const assert_actor_mismatch = (answer: Answer, label: string): void => {
	assert.ok(!answer.ok, `${label} is refused: ${JSON.stringify(answer)}`);
	assert.strictEqual(answer.status, 400, label);
	assert.strictEqual(answer.error.code, JSONRPC_ERROR_CODES.invalid_params, label);
	assert.deepStrictEqual(
		answer.error.data,
		{ reason: ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH },
		label
	);
};

describe_db(
	'role_grant_assign authorized before its caller is removed',
	(get_db) => {
		install_audit_drift_guard();

		test('an assign authorized before a delete of its caller is refused, writing nothing', async () => {
			const gated = create_gated_db(get_db());
			const s = await setup(gated);
			try {
				const held = gated.hold_begin();
				const assigned = s.assign();
				await held.reached;
				assert_ok(await s.del(s.caller.account.id), 'the delete');
				held.release();
				assert_unauthenticated(await assigned, 'the assign by the deleted admin');
				assert.strictEqual(await s.active_grants(), 0, 'no grant');
				assert.strictEqual(await s.success_rows(), 0, 'no success row');
				assert.strictEqual(await s.audit_rows(), 0, 'no audit row, failure rows included');
			} finally {
				await s.test_app.cleanup();
			}
		});

		test('an assign authorized before its caller actor is tombstoned is refused, writing nothing', async () => {
			const gated = create_gated_db(get_db());
			const s = await setup(gated, [], {
				actor_tombstone_disagrees_with_account:
					'the caller actor is soft-deleted by hand, its account left live — a state no handler produces yet'
			});
			try {
				const held = gated.hold_begin();
				const assigned = s.assign();
				await held.reached;
				await s.db.query(`UPDATE actor SET deleted_at = NOW() WHERE id = $1`, [s.caller.actor.id]);
				held.release();
				assert_unauthenticated(await assigned, 'the assign by the tombstoned actor');
				assert.strictEqual(await s.active_grants(), 0, 'no grant');
				assert.strictEqual(await s.success_rows(), 0, 'no success row');
				assert.strictEqual(await s.audit_rows(), 0, 'no audit row, failure rows included');
			} finally {
				await s.test_app.cleanup();
			}
		});

		test('an admin assigns to its own account, by account and by actor', async () => {
			const gated = create_gated_db(get_db());
			const s = await setup(gated);
			try {
				// one id twice in the lock statement
				for (const to_actor_id of [undefined, s.caller.actor.id]) {
					const assigned = await s.call(
						'role_grant_assign',
						{
							to_account_id: s.caller.account.id,
							role: ROLE,
							...(to_actor_id === undefined ? {} : { to_actor_id })
						},
						s.caller.create_session_headers()
					);
					assert_ok(assigned, `the self-assign, actor ${to_actor_id ?? 'resolved'}`);
				}
				const held = await s.db.query<{ n: string }>(
					`SELECT COUNT(*) AS n FROM role_grant
				 WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
					[s.caller.actor.id, ROLE]
				);
				assert.strictEqual(Number(held[0]!.n), 1, 'one grant, on the caller');
			} finally {
				await s.test_app.cleanup();
			}
		});
	},
	{
		exclude_db_invariants: {
			actor_tombstone_disagrees_with_account:
				'a test tombstones an actor or account by query, without the account delete that tombstones both'
		}
	}
);

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

describe_pg('role_grant_assign across a removal of its recipient', (get_db) => {
	install_audit_drift_guard();

	test('an assign waits on an uncommitted delete of its recipient, then 404s', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const r = await race(
				gated,
				s.db,
				() => s.del(s.recipient.account.id),
				() => s.assign()
			);
			assert_ok(r.first, 'the delete');
			assert.ok(r.waited, 'the assign waits on the tombstone');
			assert_recipient_not_found(r.second, 'the assign that waited');
			assert.strictEqual(await s.active_grants(), 0, 'no grant on the tombstone');
			assert.strictEqual(await s.success_rows(), 0, 'no success row');
			assert.strictEqual(await s.audit_rows(), 0, 'no audit row, failure rows included');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('an assign naming an actor waits on an uncommitted delete of its recipient, then is the mismatch', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const r = await race(
				gated,
				s.db,
				() => s.del(s.recipient.account.id),
				() => s.assign(s.recipient.actor.id)
			);
			assert_ok(r.first, 'the delete');
			assert.ok(r.waited, 'the assign waits on the tombstone');
			assert_actor_mismatch(r.second, 'the assign that waited');
			assert.strictEqual(await s.active_grants(), 0, 'no grant on the tombstone');
			assert.strictEqual(await s.success_rows(), 0, 'no success row');
			assert.strictEqual(await s.audit_rows(), 0, 'no audit row, failure rows included');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('an assign waits on an uncommitted purge of its recipient, then 404s, not 500s', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const r = await race(
				gated,
				s.db,
				() => s.purge(s.recipient.account.id),
				() => s.assign()
			);
			assert_ok(r.first, 'the purge');
			assert.ok(r.waited, 'the assign waits on the purge');
			assert_recipient_not_found(r.second, 'the assign that waited');
			assert.strictEqual(await s.success_rows(), 0, 'no success row');
			assert.strictEqual(await s.audit_rows(), 0, 'no audit row, failure rows included');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a delete of the recipient waits on an uncommitted assign, which commits while live', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const r = await race(
				gated,
				s.db,
				() => s.assign(),
				() => s.del(s.recipient.account.id)
			);
			assert_ok(r.first, 'the assign');
			assert.ok(r.waited, "the delete waits on the assign's lock");
			assert_ok(r.second, 'the delete');
			assert.strictEqual(await s.success_rows(), 1, 'one assign, while live');
			assert.strictEqual(
				await s.active_grants(),
				1,
				"the grant is kept with the tombstoned account's other grants"
			);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a purge of the recipient waits on an uncommitted assign, then removes its grant', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const r = await race(
				gated,
				s.db,
				() => s.assign(),
				() => s.purge(s.recipient.account.id)
			);
			assert_ok(r.first, 'the assign');
			assert.ok(r.waited, 'the purge waits on the assign');
			assert_ok(r.second, 'the purge');
			assert.strictEqual(
				await s.success_rows(),
				1,
				'the assign committed: its audit row, which names no foreign key, outlives the purge'
			);
			assert.strictEqual(await s.active_grants(), 0, 'the purge removed the grant');
		} finally {
			await s.test_app.cleanup();
		}
	});
});

describe_pg('role_grant_assign beside the writers of either party: no cycle', (get_db) => {
	install_audit_drift_guard();

	/**
	 * Play `assign_with` and `other` in both orders, `other` built fresh per
	 * order: each waits on the one held, and both commit.
	 */
	const both_orders = async (
		gated: GatedDb,
		s: Awaited<ReturnType<typeof setup>>,
		label: string,
		other: (order: 0 | 1) => () => Promise<Answer>
	): Promise<void> => {
		const assign_first = await race(gated, s.db, () => s.assign(), other(0));
		assert_ok(assign_first.first, 'the assign');
		assert.ok(assign_first.waited, `${label} waits on the assign`);
		assert_ok(assign_first.second, label);
		const other_first = await race(gated, s.db, other(1), () => s.assign());
		assert_ok(other_first.first, label);
		assert.ok(other_first.waited, `the assign waits on ${label}`);
		assert_ok(other_first.second, 'the assign');
		assert.strictEqual(await s.active_grants(), 1, 'the grant landed');
	};

	for (const removal of ['delete', 'purge'] as const) {
		test(`an assign and another admin's ${removal} commit in either order`, async () => {
			const gated = create_gated_db(get_db());
			const s = await setup(gated);
			try {
				const others: Array<TestAccount> = [
					await s.test_app.create_account({ username: 'race_other_admin', roles: [ROLE_ADMIN] }),
					await s.test_app.create_account({ username: 'race_third_admin', roles: [ROLE_ADMIN] })
				];
				await both_orders(gated, s, `the ${removal}`, (order) => () => {
					const id = others[order]!.account.id;
					return removal === 'delete' ? s.del(id) : s.purge(id);
				});
			} finally {
				await s.test_app.cleanup();
			}
		});
	}

	test("an assign and the recipient's accept commit in either order", async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const offer_ids: Array<string> = [];
			for (const role of OTHER_ROLES) {
				const made = await s.call(
					'role_grant_offer_create',
					{ to_account_id: s.recipient.account.id, role },
					s.test_app.create_session_headers()
				);
				assert_ok(made, 'the offer');
				assert.ok(made.ok);
				offer_ids.push((made.result as { offer: { id: string } }).offer.id);
			}
			await both_orders(
				gated,
				s,
				'the accept',
				(order) => () =>
					s.call(
						'role_grant_offer_accept',
						{ offer_id: offer_ids[order] },
						s.recipient.create_session_headers()
					)
			);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test("an assign and a revoke of the recipient's other grant commit in either order", async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated, [...OTHER_ROLES]);
		try {
			const grant_ids = await Promise.all(
				OTHER_ROLES.map(
					async (role) =>
						(
							await s.db.query<{ id: string }>(
								`SELECT id FROM role_grant WHERE actor_id = $1 AND role = $2`,
								[s.recipient.actor.id, role]
							)
						)[0]!.id
				)
			);
			await both_orders(
				gated,
				s,
				'the revoke',
				(order) => () =>
					s.call(
						'role_grant_revoke',
						{ actor_id: s.recipient.actor.id, role_grant_id: grant_ids[order] },
						s.test_app.create_session_headers()
					)
			);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test("an assign and the recipient's own toggle commit in either order", async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			await both_orders(
				gated,
				s,
				'the toggle',
				(order) => () =>
					s.call(
						'self_service_role_set',
						{ role: SELF_ROLE, enabled: order === 0 },
						s.recipient.create_session_headers()
					)
			);
		} finally {
			await s.test_app.cleanup();
		}
	});
});
