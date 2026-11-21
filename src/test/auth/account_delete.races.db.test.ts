/**
 * An offer-create or an invite-create in flight while an account it names is
 * deleted: the offer's recipient, the offer's grantor, the invite's issuer.
 *
 * The rule is that nothing is left standing for a deleted account — an offer
 * pending to or from it, an invite it issued. `query_role_grant_offer_create`
 * reads both parties' account rows under `FOR SHARE`, and `invite_create`
 * its issuer's, before they insert; a delete writes its tombstone first, so
 * the two are ordered: the create is refused, or the delete supersedes the
 * offer or deletes the invite.
 *
 * Exact, not hammered. On every driver, a create authorized before a delete
 * is held before its transaction begins (`hold_begin`) while the delete
 * commits, then released: it is refused — 404 `not_found` for a deleted
 * recipient, the dead credential's 401 for a deleted grantor or issuer — and
 * writes nothing; and an invite committed before its issuer's delete is
 * deleted by it. On real `pg` only (`TEST_DATABASE_URL`), each lock is shown
 * to serialize: a create waits on an uncommitted delete and is then refused,
 * and a delete waits on an uncommitted create and then ends what it wrote.
 * The in-memory drivers have one connection, so the second transaction would
 * queue behind the held one whatever it locks.
 *
 * And the last-admin guard against an admin-offer accept: the accept holds
 * its grantor's account row shared and key-shares the grantor's actor, the
 * guard takes the grantor's account first, and neither may deadlock the other
 * — real `pg` only, its two stalls set by a holder of the recipient's actor.
 * The other interleaving, the removal ahead of the accept, takes the
 * grantor's account before the offer row on both sides, so the accept waits
 * holding nothing the removal needs and is refused. The accept's own locks
 * are pinned in `role_grant_offer.lock_order.db.test.ts`.
 *
 * Twin of the Rust `fuz_auth` `tests/account_delete_races.rs`.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { create_test_app, type TestApp } from '#lib/testing/test_app.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import { rpc_call } from '#lib/testing/rpc_helpers.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { create_role_registry, ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { ERROR_AUTHENTICATION_REQUIRED } from '#lib/http/error_schemas.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import { auth_integration_truncate_tables } from '#lib/testing/db.ts';
import { create_describe_db } from '#lib/testing/describe_db.ts';
import { query_count_active_accounts_with_global_role_locked } from '#lib/auth/role_grant_queries.ts';
import { query_role_grant_offer_supersede_outgoing } from '#lib/auth/role_grant_offer_queries.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';

import { describe_db, pg_factory } from '../db_fixture.ts';
import { create_gated_db, type GatedDb } from '../gated_db.ts';

const RPC_PATH = '/api/rpc';

/** How long a blocked request is given to show it is blocked. */
const HOLD_MS = 300;

/**
 * An app role any caller may offer. The grantor's authority comes from this
 * `authorize`, not from an `admin` grant in the database: an admin target's
 * delete runs the last-admin guard, which locks the grantor's account row
 * itself and would order the delete against the offer whether or not the
 * offer locks it — so a pin of that lock must not lean on it.
 */
const OFFERED_ROLE = 'race_role';

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_rpc_endpoint({
		notification_sender: ctx.deps.notification_sender,
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: create_standard_rpc_actions(ctx.deps, {
			roles: create_role_registry([{ name: OFFERED_ROLE, grant_paths: ['admin'] }]),
			authorize: () => true
		}),
		log: ctx.deps.log
	});

/**
 * The fixture: a grantor whose authority is the `authorize` above, an issuer
 * holding `admin` (`invite_create` is gated on the role), and a recipient; the
 * keeper deletes.
 */
const setup = async (gated: GatedDb) => {
	const test_app: TestApp = await create_test_app({
		session_options: create_session_config('test_session'),
		db: gated.db,
		create_route_specs
	});
	const grantor = await test_app.create_account({ username: 'race_grantor' });
	const recipient = await test_app.create_account({ username: 'race_recipient' });
	const issuer = await test_app.create_account({ username: 'race_issuer', roles: [ROLE_ADMIN] });
	const call = (method: string, params: unknown, headers: Record<string, string>) =>
		rpc_call({ app: test_app.app, path: RPC_PATH, method, params, headers });
	const offer = () =>
		call(
			'role_grant_offer_create',
			{ to_account_id: recipient.account.id, role: OFFERED_ROLE },
			grantor.create_session_headers()
		);
	const invite = () =>
		call('invite_create', { username: 'race_invitee' }, issuer.create_session_headers());
	const del = (account_id: string) =>
		call('account_delete', { account_id }, test_app.create_session_headers());
	const count = async (sql: string, params: Array<unknown>): Promise<number> =>
		Number((await test_app.backend.deps.db.query<{ n: string }>(sql, params))[0]!.n);
	const pending_offers = () =>
		count(
			`SELECT COUNT(*) AS n FROM role_grant_offer
			 WHERE (to_account_id = $1 OR from_actor_id = $2)
			   AND accepted_at IS NULL AND declined_at IS NULL
			   AND retracted_at IS NULL AND superseded_at IS NULL`,
			[recipient.account.id, grantor.actor.id]
		);
	const invites = () =>
		count(`SELECT COUNT(*) AS n FROM invite WHERE created_by = $1`, [issuer.actor.id]);
	// Once the issuer's request is authorized, its `admin` grant can go: the
	// delete then runs no last-admin guard, so the issuer's own account lock is
	// the one ordering the invite against the delete.
	const revoke_issuer_admin = () =>
		test_app.backend.deps.db.query(
			`UPDATE role_grant SET revoked_at = NOW() WHERE actor_id = $1 AND revoked_at IS NULL`,
			[issuer.actor.id]
		);
	return {
		test_app,
		grantor,
		recipient,
		issuer,
		offer,
		invite,
		del,
		pending_offers,
		invites,
		revoke_issuer_admin
	};
};

type Answer = Awaited<ReturnType<typeof rpc_call>>;

const assert_ok = (answer: Answer, label: string): void => {
	assert.ok(answer.ok, `${label}: ${JSON.stringify(answer)}`);
};

const assert_recipient_not_found = (answer: Answer, label: string): void => {
	assert.ok(!answer.ok, `${label} is refused`);
	assert.strictEqual(answer.status, 404, label);
	assert.strictEqual(answer.error.code, JSONRPC_ERROR_CODES.not_found, label);
	assert.strictEqual(answer.error.data, undefined, label);
};

const assert_unauthenticated = (answer: Answer, label: string): void => {
	assert.ok(!answer.ok, `${label} is refused`);
	assert.strictEqual(answer.status, 401, label);
	assert.strictEqual(answer.error.code, JSONRPC_ERROR_CODES.unauthenticated, label);
	assert.deepStrictEqual(answer.error.data, { reason: ERROR_AUTHENTICATION_REQUIRED }, label);
};

describe_db('a create in flight across a delete', (get_db) => {
	install_audit_drift_guard();

	test('an offer-create authorized before its recipient is deleted is refused, writing nothing', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const held = gated.hold_begin();
			const created = s.offer();
			await held.reached;
			assert_ok(await s.del(s.recipient.account.id), 'the delete');
			held.release();
			assert_recipient_not_found(await created, 'the offer to the deleted recipient');
			assert.strictEqual(await s.pending_offers(), 0, 'no pending offer');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('an offer-create authorized before its grantor is deleted is refused, writing nothing', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const held = gated.hold_begin();
			const created = s.offer();
			await held.reached;
			assert_ok(await s.del(s.grantor.account.id), 'the delete');
			held.release();
			assert_unauthenticated(await created, 'the offer from the deleted grantor');
			assert.strictEqual(await s.pending_offers(), 0, 'no pending offer');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('an invite-create authorized before its issuer is deleted is refused, writing nothing', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const held = gated.hold_begin();
			const created = s.invite();
			await held.reached;
			assert_ok(await s.del(s.issuer.account.id), 'the delete');
			held.release();
			assert_unauthenticated(await created, 'the invite from the deleted issuer');
			assert.strictEqual(await s.invites(), 0, 'no invite row');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('an invite committed before its issuer is deleted is deleted by it', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			assert_ok(await s.invite(), 'the invite');
			assert.strictEqual(await s.invites(), 1);
			assert_ok(await s.del(s.issuer.account.id), 'the delete');
			assert.strictEqual(await s.invites(), 0, 'the delete deleted it');
		} finally {
			await s.test_app.cleanup();
		}
	});
});

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

/**
 * Start `blocked` while `gated` holds a transaction at its commit, wait until
 * `blocked` has opened its own transaction and is still unsettled after
 * `HOLD_MS`, then release the commit.
 */
const assert_waits_on_held_commit = async (
	gated: GatedDb,
	held: { release: () => void },
	blocked: Promise<Answer>
): Promise<void> => {
	let settled = false;
	const settle = () => {
		settled = true;
	};
	blocked.then(settle, settle);
	try {
		const deadline = Date.now() + 2000;
		while (gated.open_transactions() < 2) {
			assert.ok(!settled, 'settled without opening its transaction');
			assert.ok(Date.now() < deadline, 'opened no transaction within 2s');
			await wait(5);
		}
		await wait(HOLD_MS);
		assert.ok(!settled, 'waits on the held transaction');
	} finally {
		// released on a failure too, so no later test waits on its row lock
		held.release();
	}
};

describe_pg('a create in flight across a delete: the locks serialize', (get_db) => {
	install_audit_drift_guard();

	/** Hold `first` at its commit, start `second`, show it waits, then release. */
	const race = async (
		gated: GatedDb,
		first: () => Promise<Answer>,
		second: () => Promise<Answer>,
		between?: () => Promise<unknown>
	): Promise<[Answer, Answer]> => {
		const held = gated.hold_commit();
		const a = first();
		await held.reached;
		await between?.();
		const b = second();
		await assert_waits_on_held_commit(gated, held, b);
		return [await a, await b];
	};

	test('a delete waits on an uncommitted offer to the account, then supersedes it', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const [created, deleted] = await race(gated, s.offer, () => s.del(s.recipient.account.id));
			assert_ok(created, 'the offer committed first');
			assert_ok(deleted, 'the delete');
			assert.strictEqual(await s.pending_offers(), 0, 'the delete superseded the offer');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('an offer-create waits on an uncommitted delete of its recipient, then is refused', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const [deleted, created] = await race(gated, () => s.del(s.recipient.account.id), s.offer);
			assert_ok(deleted, 'the delete');
			assert_recipient_not_found(created, 'the offer that waited');
			assert.strictEqual(await s.pending_offers(), 0, 'nothing pending');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a delete waits on an uncommitted offer from the account, then supersedes it', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const [created, deleted] = await race(gated, s.offer, () => s.del(s.grantor.account.id));
			assert_ok(created, 'the offer committed first');
			assert_ok(deleted, 'the delete');
			assert.strictEqual(await s.pending_offers(), 0, 'the delete superseded the offer');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('an offer-create waits on an uncommitted delete of its grantor, then is refused', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const [deleted, created] = await race(gated, () => s.del(s.grantor.account.id), s.offer);
			assert_ok(deleted, 'the delete');
			assert_unauthenticated(created, 'the offer that waited');
			assert.strictEqual(await s.pending_offers(), 0, 'nothing pending');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a delete waits on an uncommitted invite from the account, then deletes it', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const [created, deleted] = await race(
				gated,
				s.invite,
				() => s.del(s.issuer.account.id),
				s.revoke_issuer_admin
			);
			assert_ok(created, 'the invite committed first');
			assert_ok(deleted, 'the delete');
			assert.strictEqual(await s.invites(), 0, 'the delete deleted the invite');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('an invite-create waits on an uncommitted delete of its issuer, then is refused', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const [deleted, created] = await race(gated, () => s.del(s.issuer.account.id), s.invite);
			assert_ok(deleted, 'the delete');
			assert_unauthenticated(created, 'the invite that waited');
			assert.strictEqual(await s.invites(), 0, 'no invite row');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test("an offer between two admins and a third admin's delete never deadlock", async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		// resolved in `finally` too, so a failed wait never leaves the holder open
		let release = Promise.withResolvers<void>();
		try {
			const db = s.test_app.backend.deps.db;
			// Two admins written in the reverse of their id order: an unordered
			// guard reaches them in the order they were written, so it disagrees
			// with an id-ordered offer — the case where only both orders hold.
			const admins = [];
			for (let i = 0; i < 12; i++) {
				admins.push(
					await s.test_app.create_account({ username: `guard_admin_${i}`, roles: [ROLE_ADMIN] })
				);
				if (admins.length > 1 && admins[0]!.account.id > admins.at(-1)!.account.id) break;
				if (admins.length > 1) admins.splice(0, admins.length - 1);
			}
			const a = admins[0]!;
			const b = admins.at(-1)!;
			assert.ok(a.account.id > b.account.id, 'an admin pair written against its id order');
			const lock_waiters = async (): Promise<number> =>
				Number(
					(
						await db.query<{ n: string }>(
							`SELECT COUNT(*) AS n FROM pg_stat_activity
							 WHERE wait_event_type = 'Lock' AND datname = current_database()`
						)
					)[0]!.n
				);
			// both directions, so each party is once the lower id and once the higher
			for (const [grantor, recipient, third] of [
				[a, b, 'guard_third_1'],
				[b, a, 'guard_third_2']
			] as const) {
				const removed = await s.test_app.create_account({ username: third, roles: [ROLE_ADMIN] });
				// Another holder of the recipient's row (an offer create's `FOR SHARE`) makes the
				// guard of the third admin's delete stop at that row while holding the
				// rows it locked before it — the grantor's, when it reaches the grantor
				// first. The offer then runs into the guard. Locked in the guard's order,
				// it waits holding nothing the guard needs; locked one account at a time,
				// it held the recipient while waiting on the grantor — a deadlock.
				release = Promise.withResolvers<void>();
				const locked = Promise.withResolvers<void>();
				const holder = db.transaction(async (tx) => {
					await tx.query(`SELECT id FROM account WHERE id = $1 FOR SHARE`, [recipient.account.id]);
					locked.resolve();
					await release.promise;
				});
				await locked.promise;
				const deleted = s.del(removed.account.id);
				const deadline = Date.now() + 2000;
				while ((await lock_waiters()) < 1) {
					assert.ok(Date.now() < deadline, "the delete's guard waits on the held row");
					await wait(5);
				}
				const created = s.test_app.app.request(RPC_PATH, {
					method: 'POST',
					headers: { ...grantor.create_session_headers(), 'content-type': 'application/json' },
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method: 'role_grant_offer_create',
						params: { to_account_id: recipient.account.id, role: ROLE_ADMIN }
					})
				});
				// past Postgres's `deadlock_timeout` (one second by default), so a
				// cycle would have been found and broken by now
				await wait(1500);
				release.resolve();
				await holder;
				assert_ok(await deleted, "the third admin's delete");
				const answer = await created;
				assert.strictEqual(answer.status, 200, `the offer: ${await answer.text()}`);
				assert.strictEqual(
					await count_pending_from(db, grantor.actor.id, recipient.account.id),
					1,
					'the offer is pending'
				);
			}
		} finally {
			release.resolve();
			await s.test_app.cleanup();
		}
		// two holds past `deadlock_timeout` alone take three seconds
	}, 30_000);

	// The accept share-locks its grantor's account row, then inserts a grant
	// naming the grantor's actor — a foreign-key key share on it. A holder of
	// the recipient's actor stalls the accept's insert after its locks, and the
	// removal's last-admin guard then stalls at the grantor's account; released,
	// the accept commits and the removal goes on. One delete, one revoke of the
	// grantor's grant, one purge.
	for (const removal of ['delete', 'revoke', 'purge'] as const) {
		test(`an admin-offer accept and a removal (${removal}) of its grantor never deadlock`, async () => {
			const gated = create_gated_db(get_db());
			const s = await setup(gated);
			// resolved in `finally` too, so a failed wait never leaves the holder open
			const release = Promise.withResolvers<void>();
			try {
				const db = s.test_app.backend.deps.db;
				const grantor = await s.test_app.create_account({
					username: `accept_grantor_${removal}`,
					roles: [ROLE_ADMIN]
				});
				const recipient = await s.test_app.create_account({
					username: `accept_recipient_${removal}`
				});
				const call = (
					method: string,
					params: unknown,
					headers: Record<string, string>,
					suppress_default_origin = false
				) =>
					rpc_call({
						app: s.test_app.app,
						path: RPC_PATH,
						method,
						params,
						headers,
						suppress_default_origin
					});
				const offered = await call(
					'role_grant_offer_create',
					{ to_account_id: recipient.account.id, role: ROLE_ADMIN },
					grantor.create_session_headers()
				);
				assert.ok(offered.ok, `the admin offer: ${JSON.stringify(offered)}`);
				const offer_id = (offered.result as { offer: { id: string } }).offer.id;
				const grant_id = (
					await db.query<{ id: string }>(
						`SELECT id FROM role_grant WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
						[grantor.actor.id, ROLE_ADMIN]
					)
				)[0]!.id;
				const until_waiters = (n: number, what: string) => until_lock_waiters(db, n, what);

				const locked = Promise.withResolvers<void>();
				const holder = db.transaction(async (tx) => {
					await tx.query(`SELECT id FROM actor WHERE id = $1 FOR UPDATE`, [recipient.actor.id]);
					locked.resolve();
					await release.promise;
				});
				await locked.promise;
				const accepted = call(
					'role_grant_offer_accept',
					{ offer_id },
					recipient.create_session_headers()
				);
				await until_waiters(1, "the accept holds the grantor's account and waits at its insert");
				const removed =
					removal === 'delete'
						? s.del(grantor.account.id)
						: removal === 'revoke'
							? call(
									'role_grant_revoke',
									{ actor_id: grantor.actor.id, role_grant_id: grant_id },
									s.test_app.create_session_headers()
								)
							: call(
									'account_purge',
									{ account_id: grantor.account.id, confirm: true },
									s.test_app.create_daemon_token_headers(),
									true
								);
				await until_waiters(2, "the guard waits on the grantor's account");
				release.resolve();
				await holder;
				assert_ok(await accepted, `the accept (${removal})`);
				assert_ok(await removed, `the ${removal}`);
				// the recipient holds the admin grant the offer conferred
				const conferred = await db.query<{ id: string }>(
					`SELECT rg.id FROM role_grant rg JOIN actor act ON act.id = rg.actor_id
					 WHERE act.account_id = $1 AND rg.role = $2 AND rg.revoked_at IS NULL`,
					[recipient.account.id, ROLE_ADMIN]
				);
				assert.strictEqual(conferred.length, 1, `the recipient is an admin (${removal})`);
				// and the grantor is removed as asked
				const grantor_left = await db.query<{ deleted: boolean; revoked: boolean }>(
					`SELECT a.deleted_at IS NOT NULL AS deleted,
					        (SELECT revoked_at IS NOT NULL FROM role_grant WHERE id = $2) AS revoked
					 FROM account a WHERE a.id = $1`,
					[grantor.account.id, grant_id]
				);
				if (removal === 'purge') {
					assert.strictEqual(grantor_left.length, 0, 'the grantor is purged');
				} else if (removal === 'delete') {
					assert.ok(grantor_left[0]?.deleted, 'the grantor is deleted');
				} else {
					assert.ok(grantor_left[0]?.revoked, "the grantor's grant is revoked");
				}
			} finally {
				release.resolve();
				await s.test_app.cleanup();
			}
		}, 30_000);
	}

	// The other interleaving: the removal ahead. Its guard locks the grantor's
	// account, actor and grant, and its write runs; the accept is sent and
	// waits; the removal then ends the grantor's pending offers (a delete or
	// revoke supersedes them, a purge's cascade deletes them) and commits. The
	// accept takes the grantor's account before it reads the grantor's
	// authority or claims the offer, so it waits there holding nothing the
	// removal needs and is refused once the removal commits; one that claimed
	// the offer first would hold the row the removal's supersede needs, and the
	// two deadlock.
	for (const removal of ['delete', 'revoke', 'purge'] as const) {
		test(`an admin-offer accept sent across a removal (${removal}) of its grantor is refused`, async () => {
			const gated = create_gated_db(get_db());
			const s = await setup(gated);
			// resolved in `finally` too, so a failed wait never leaves the holder open
			const release = Promise.withResolvers<void>();
			try {
				const db = s.test_app.backend.deps.db;
				const grantor = await s.test_app.create_account({
					username: `ahead_grantor_${removal}`,
					roles: [ROLE_ADMIN]
				});
				const recipient = await s.test_app.create_account({
					username: `ahead_recipient_${removal}`
				});
				const offered = await rpc_call({
					app: s.test_app.app,
					path: RPC_PATH,
					method: 'role_grant_offer_create',
					params: { to_account_id: recipient.account.id, role: ROLE_ADMIN },
					headers: grantor.create_session_headers()
				});
				assert.ok(offered.ok, `the admin offer: ${JSON.stringify(offered)}`);
				const offer_id = (offered.result as { offer: { id: string } }).offer.id;
				const grant_id = (
					await db.query<{ id: string }>(
						`SELECT id FROM role_grant WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
						[grantor.actor.id, ROLE_ADMIN]
					)
				)[0]!.id;

				const written = Promise.withResolvers<void>();
				const removed = db.transaction(async (tx) => {
					await query_count_active_accounts_with_global_role_locked({ db: tx }, ROLE_ADMIN);
					if (removal === 'delete') {
						await tx.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [
							grantor.account.id
						]);
						await tx.query(`UPDATE actor SET deleted_at = NOW() WHERE account_id = $1`, [
							grantor.account.id
						]);
					} else if (removal === 'revoke') {
						await tx.query(`UPDATE role_grant SET revoked_at = NOW() WHERE id = $1`, [grant_id]);
					}
					written.resolve();
					await release.promise;
					if (removal === 'purge') {
						await tx.query(`DELETE FROM account WHERE id = $1`, [grantor.account.id]);
					} else {
						await query_role_grant_offer_supersede_outgoing({ db: tx }, [grantor.actor.id]);
					}
				});
				await written.promise;
				const accepted = rpc_call({
					app: s.test_app.app,
					path: RPC_PATH,
					method: 'role_grant_offer_accept',
					params: { offer_id },
					headers: recipient.create_session_headers()
				});
				await until_lock_waiters(db, 1, 'the accept waits on the removal');
				release.resolve();
				await removed;
				const answer = await accepted;
				assert.ok(!answer.ok, `the accept went through: ${JSON.stringify(answer)}`);
				assert.ok(
					answer.status >= 400 && answer.status < 500,
					`the accept is refused, not failed: ${JSON.stringify(answer)}`
				);
				const conferred = await db.query<{ id: string }>(
					`SELECT rg.id FROM role_grant rg JOIN actor act ON act.id = rg.actor_id
					 WHERE act.account_id = $1 AND rg.role = $2`,
					[recipient.account.id, ROLE_ADMIN]
				);
				assert.strictEqual(conferred.length, 0, 'no admin grant conferred');
			} finally {
				release.resolve();
				await s.test_app.cleanup();
			}
		}, 30_000);
	}
});

const lock_waiters = async (db: GatedDb['db']): Promise<number> =>
	Number(
		(
			await db.query<{ n: string }>(
				`SELECT COUNT(*) AS n FROM pg_stat_activity
				 WHERE wait_event_type = 'Lock' AND datname = current_database()`
			)
		)[0]!.n
	);

/**
 * Wait until `n` sessions of the database wait on a lock. The deadline fails a
 * wait that never comes; it is no timing assertion, so it is set far past any
 * scheduling delay.
 */
const until_lock_waiters = async (db: GatedDb['db'], n: number, what: string): Promise<void> => {
	const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
	while ((await lock_waiters(db)) < n) {
		assert.ok(Date.now() < deadline, what);
		await wait(5);
	}
};

/** How long a lock wait a test arranged may take to show, a bound on a hang only. */
const LOCK_WAIT_DEADLINE_MS = 20_000;

const count_pending_from = async (
	db: GatedDb['db'],
	from_actor_id: string,
	to_account_id: string
): Promise<number> =>
	Number(
		(
			await db.query<{ n: string }>(
				`SELECT COUNT(*) AS n FROM role_grant_offer
				 WHERE from_actor_id = $1 AND to_account_id = $2
				   AND accepted_at IS NULL AND declined_at IS NULL
				   AND retracted_at IS NULL AND superseded_at IS NULL`,
				[from_actor_id, to_account_id]
			)
		)[0]!.n
	);
