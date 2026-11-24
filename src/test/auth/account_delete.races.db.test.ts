/**
 * An offer-create or an invite-create in flight while an account it names is
 * deleted: the offer's recipient, the offer's grantor, the invite's issuer.
 *
 * The rule is that nothing is left standing for a deleted account — an offer
 * pending to or from it, an invite it issued. `query_role_grant_offer_create`
 * reads both parties' account rows under `FOR SHARE`, and `query_create_invite`
 * its issuer's, before they insert; a delete writes its tombstone first, so
 * the two are ordered: the create is refused, or the delete supersedes the
 * offer or deletes the invite. The invite rule is pinned through the handler
 * and through the query called directly, as a consumer minting invites on its
 * own path calls it.
 *
 * Exact, not hammered. On every driver, a create authorized before a delete
 * is held before its transaction begins (`hold_begin`) while the delete
 * commits, then released: it is refused — 404 `not_found` for a deleted
 * recipient, the dead credential's 401 for a deleted grantor or issuer — and
 * writes nothing; and an invite committed before its issuer's delete is
 * deleted by it. On real `pg` only (`FUZ_TEST_POSTGRES_URL`), each lock is shown
 * to serialize: a create waits on an uncommitted delete and is then refused,
 * and a delete waits on an uncommitted create and then ends what it wrote.
 * The in-memory drivers have one connection, so the second transaction would
 * queue behind the held one whatever it locks.
 *
 * And the last-admin guard against an admin-offer accept: the accept holds
 * its grantor's account row shared, the guard takes the grantor's account
 * first, and neither may deadlock the other — real `pg` only, its two stalls
 * set by a holder of the recipient's actor.
 * The other interleaving, the removal ahead of the accept, takes the
 * grantor's account before the offer row on both sides, so the accept waits
 * holding nothing the removal needs and is refused. The accept's own locks
 * are pinned in `role_grant_offer.lock_order.db.test.ts`.
 *
 * And a purge against the rows its cascade reaches, each pinned mid-cascade by
 * a third transaction holding one row of it (real `pg` only): an admin's
 * revoke of a grant they granted, across their purge, stamps `revoked_by`
 * without waiting on the purged actor — the provenance stamps carry no foreign
 * key; two purges whose accounts' offers and invites cross take turns at the
 * purge lock.
 *
 * Twin of the Rust `fuz_auth` `tests/account_delete_races.rs`.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { create_test_app, type TestApp } from '#lib/testing/test_app.ts';
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
import {
	query_revoke_role_grant,
	query_role_grant_offer_supersede_outgoing
} from '#lib/auth/role_grant_offer_queries.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import { InviteIssuerNotActiveError, query_create_invite } from '#lib/auth/invite_queries.ts';
import { ERROR_CANNOT_DELETE_LAST_ADMIN } from '#lib/auth/admin_action_specs.ts';
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
		session_cookie_name: 'test_session',
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
	// `query_create_invite` called directly, as a consumer minting on its own
	// path does, in a transaction of its own; settles to its outcome.
	const invite_direct = (): Promise<Outcome> =>
		gated.db
			.transaction((tx) =>
				query_create_invite({ db: tx }, { username: 'race_invitee', created_by: issuer.actor.id })
			)
			.then(
				(invite) => ({ ok: true as const, value: invite }),
				(error: unknown) => ({ ok: false as const, error })
			);
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
		invite_direct,
		revoke_issuer_admin
	};
};

type Answer = Awaited<ReturnType<typeof rpc_call>>;

/** The keeper's purge of `account_id`, over the daemon token a purge needs. */
const purge = (s: Awaited<ReturnType<typeof setup>>, account_id: string) =>
	rpc_call({
		app: s.test_app.app,
		path: RPC_PATH,
		method: 'account_purge',
		params: { account_id, confirm: true },
		headers: s.test_app.create_daemon_token_headers(),
		suppress_default_origin: true
	});

/** A direct query call's outcome, settled so a race can hold it. */
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

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

	test('query_create_invite refuses an issuer deleted before it, writing nothing', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			assert_ok(await s.del(s.issuer.account.id), 'the delete');
			const outcome = await s.invite_direct();
			assert.ok(!outcome.ok, `the query refuses a deleted issuer: ${JSON.stringify(outcome)}`);
			assert.instanceOf(outcome.error, InviteIssuerNotActiveError);
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
	blocked: Promise<unknown>
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
	const race = async <A, B>(
		gated: GatedDb,
		first: () => Promise<A>,
		second: () => Promise<B>,
		between?: () => Promise<unknown>
	): Promise<[A, B]> => {
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

	test('query_create_invite waits on an uncommitted delete of its issuer, then is refused', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const [deleted, created] = await race(
				gated,
				() => s.del(s.issuer.account.id),
				s.invite_direct
			);
			assert_ok(deleted, 'the delete');
			assert.ok(!created.ok, `the query that waited is refused: ${JSON.stringify(created)}`);
			assert.instanceOf(created.error, InviteIssuerNotActiveError);
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

	// The accept share-locks its grantor's account row, then inserts the grant
	// to the recipient's actor — a foreign-key key share on that actor
	// (`actor_id` keeps its foreign key; the grant's `granted_by` stamp has
	// none). A holder of the recipient's actor stalls the accept's insert after
	// its locks, and the removal's last-admin guard then stalls at the grantor's
	// account; released, the accept commits and the removal goes on. One delete,
	// one revoke of the grantor's grant, one purge.
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
						// a delete ends the account's credentials, as the handler's does
						await tx.query(`DELETE FROM auth_session WHERE account_id = $1`, [grantor.account.id]);
						await tx.query(`DELETE FROM api_token WHERE account_id = $1`, [grantor.account.id]);
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

describe_pg('a purge against the rows its cascade reaches', (get_db) => {
	install_audit_drift_guard();

	/**
	 * Hold `pin` (one row the cascade reaches) in a transaction of its own, start
	 * `first`, and once it waits on the pin, `second`; once `second` waits too or
	 * has settled, commit the pin. Returns both results.
	 */
	const pinned = async <A, B>(
		db: GatedDb['db'],
		pin: { sql: string; params: Array<unknown> },
		first: () => Promise<A>,
		second: () => Promise<B>
	): Promise<[A, B]> => {
		const locked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holder = db.transaction(async (tx) => {
			await tx.query(pin.sql, pin.params);
			locked.resolve();
			await release.promise;
		});
		await locked.promise;
		try {
			const a = first();
			await until_lock_waiters(db, 1, 'the first waits on the pinned row');
			const state = { settled: false };
			const b = second().finally(() => {
				state.settled = true;
			});
			const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
			while (!state.settled && (await lock_waiters(db)) < 2) {
				assert.ok(Date.now() < deadline, 'the second neither waits nor finishes');
				await wait(5);
			}
			release.resolve();
			await holder;
			return [await a, await b];
		} finally {
			// released on a failure too, so no later test waits on its row lock
			release.resolve();
		}
	};

	// The admin's own grant pinned, so the purge waits in its cascade, past its
	// delete of the admin's actor; the revoke, authorized before the purge, then
	// writes the grant it revokes and stamps `revoked_by` with the admin's actor.
	// With a foreign key on the stamp, the write waited on the deleted actor
	// while holding the grant, whose `granted_by` the cascade then set null: a
	// deadlock. The stamp has none, so the revoke commits, the purge's cascade
	// never writes the grant, and the stamps keep the purged actor's id.
	test("an admin's revoke of a grant they granted, across their purge: both commit", async () => {
		const s = await setup(create_gated_db(get_db()));
		try {
			const db = s.test_app.backend.deps.db;
			const admin = await s.test_app.create_account({
				username: 'purged_admin',
				roles: [ROLE_ADMIN]
			});
			const grantee = await s.test_app.create_account({ username: 'purged_admins_grantee' });
			const insert_grant = async (actor_id: string, granted_by: string | null) =>
				(
					await db.query<{ id: Uuid }>(
						`INSERT INTO role_grant (actor_id, role, granted_by) VALUES ($1, $2, $3) RETURNING id`,
						[actor_id, OFFERED_ROLE, granted_by]
					)
				)[0]!.id;
			const own = await insert_grant(admin.actor.id, null);
			const granted = await insert_grant(grantee.actor.id, admin.actor.id);

			const [purged, revoked] = await pinned(
				db,
				{ sql: `SELECT id FROM role_grant WHERE id = $1 FOR UPDATE`, params: [own] },
				() => purge(s, admin.account.id),
				() =>
					db
						.transaction((tx) =>
							query_revoke_role_grant({ db: tx }, granted, grantee.actor.id, admin.actor.id)
						)
						.then(
							(value) => ({ ok: true as const, value }),
							(error: unknown) => ({ ok: false as const, error })
						)
			);
			assert_ok(purged, 'the purge');
			assert.ok(revoked.ok, `the revoke: ${String(revoked.ok || revoked.error)}`);
			assert.ok(revoked.value, 'the revoke found the grant');
			const rows = await db.query<{ granted_by: string; revoked_by: string; revoked: boolean }>(
				`SELECT granted_by, revoked_by, revoked_at IS NOT NULL AS revoked
				 FROM role_grant WHERE id = $1`,
				[granted]
			);
			assert.deepStrictEqual(rows, [
				{ granted_by: admin.actor.id, revoked_by: admin.actor.id, revoked: true }
			]);
			const left = await db.query(`SELECT id FROM account WHERE id = $1`, [admin.account.id]);
			assert.strictEqual(left.length, 0, 'the admin is purged');
		} finally {
			await s.test_app.cleanup();
		}
	}, 30_000);

	// A third transaction pins the offer or invite of the account purged second,
	// so the first purge waits in its cascade; the second is sent. Each cascade
	// deletes its own account's offers and invites and its counterpart's, in its
	// plan's order, and with no lock ahead of them the two met in opposite
	// orders and deadlocked. Every purge first takes the advisory lock only
	// purges take, so the second waits there holding nothing.
	for (const shape of ['accepted', 'declined', 'invites'] as const) {
		test(`two purges whose accounts' rows cross (${shape}): both commit`, async () => {
			const s = await setup(create_gated_db(get_db()));
			try {
				const db = s.test_app.backend.deps.db;
				const x = await s.test_app.create_account({ username: `crossed_x_${shape}` });
				const z = await s.test_app.create_account({ username: `crossed_z_${shape}` });
				const [from_x, from_z] = Array.from({ length: 2 }, () => crypto.randomUUID()).sort() as [
					string,
					string
				];
				if (shape === 'invites') {
					for (const [id, issuer, claimer, name] of [
						[from_x, x.actor.id, z.account.id, `crossed_iz_${shape}`],
						[from_z, z.actor.id, x.account.id, `crossed_ix_${shape}`]
					] as const) {
						await db.query(
							`INSERT INTO invite (id, username, created_by, claimed_by, claimed_at)
							 VALUES ($1, $2, $3, $4, NOW())`,
							[id, name, issuer, claimer]
						);
					}
				} else {
					for (const [id, from, to] of [
						[from_x, x, z],
						[from_z, z, x]
					] as const) {
						await db.query(
							`INSERT INTO role_grant_offer (id, from_actor_id, to_account_id, role, expires_at)
							 VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day')`,
							[id, from.actor.id, to.account.id, OFFERED_ROLE]
						);
						if (shape === 'accepted') {
							await db.query(
								`INSERT INTO role_grant (id, actor_id, role, granted_by, source_offer_id)
								 VALUES ($1, $2, $3, $4, $1)`,
								[id, to.actor.id, OFFERED_ROLE, from.actor.id]
							);
							await db.query(
								`UPDATE role_grant_offer SET accepted_at = NOW(), resulting_role_grant_id = $1
								 WHERE id = $1`,
								[id]
							);
						} else {
							await db.query(`UPDATE role_grant_offer SET declined_at = NOW() WHERE id = $1`, [id]);
						}
					}
				}
				const table = shape === 'invites' ? 'invite' : 'role_grant_offer';
				const [first, second] = await pinned(
					db,
					{ sql: `SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, params: [from_x] },
					() => purge(s, z.account.id),
					() => purge(s, x.account.id)
				);
				assert_ok(first, `the first purge (${shape})`);
				assert_ok(second, `the second purge (${shape})`);
				const left = await db.query(`SELECT id FROM account WHERE id = ANY($1::uuid[])`, [
					[x.account.id, z.account.id]
				]);
				assert.strictEqual(left.length, 0, `both purged (${shape})`);
			} finally {
				await s.test_app.cleanup();
			}
		}, 30_000);
	}
});

// A removal's guard reads whether its target is an admin unlocked, and holds no
// row of a non-admin target until its own: the purge's
// `query_account_lock_for_purge`, the delete's `query_account_lock_live`.
// Played across that window, in one held transaction: an accept making the
// target an admin (its account row held, as an accept holds its recipient's)
// and the revoke of every other admin that the guard of the revoke allowed,
// counting the target. The removal reads a non-admin, waits at the target's
// row, and resumes on the commit with the target the last admin: its guard
// runs again under the row lock and refuses (real `pg` only — the played
// transaction holds the row the removal waits on).
describe_pg('a removal whose target turns the last admin while it waits at its row', (get_db) => {
	install_audit_drift_guard();

	for (const removal of ['purge', 'delete'] as const) {
		test(`a ${removal} whose target turns the last admin while it waits at its row is refused`, async () => {
			const s = await setup(create_gated_db(get_db()));
			try {
				const db = s.test_app.backend.deps.db;
				const target = await s.test_app.create_account({ username: `turned_admin_${removal}` });
				const locked = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const held = db.transaction(async (tx) => {
					await tx.query(`SELECT id FROM account WHERE id = $1 FOR NO KEY UPDATE`, [
						target.account.id
					]);
					await tx.query(`INSERT INTO role_grant (actor_id, role) VALUES ($1, $2)`, [
						target.actor.id,
						ROLE_ADMIN
					]);
					await tx.query(
						`UPDATE role_grant SET revoked_at = NOW()
						 WHERE role = $1 AND scope_id IS NULL AND revoked_at IS NULL AND actor_id <> $2`,
						[ROLE_ADMIN, target.actor.id]
					);
					locked.resolve();
					await release.promise;
				});
				await locked.promise;
				let removed: Answer;
				try {
					const answer =
						removal === 'purge' ? purge(s, target.account.id) : s.del(target.account.id);
					await until_lock_waiters(db, 1, `the ${removal} waits at its target's row`);
					release.resolve();
					await held;
					removed = await answer;
				} finally {
					release.resolve();
				}
				assert.ok(!removed.ok, `the ${removal} is refused: ${JSON.stringify(removed)}`);
				assert.strictEqual(removed.status, 403);
				assert.deepStrictEqual(removed.error.data, { reason: ERROR_CANNOT_DELETE_LAST_ADMIN });
				const admins = await db.query<{ n: string }>(
					`SELECT COUNT(*) AS n FROM role_grant rg JOIN actor act ON act.id = rg.actor_id
					 JOIN account a ON a.id = act.account_id
					 WHERE rg.role = $1 AND rg.scope_id IS NULL AND rg.revoked_at IS NULL
					   AND a.deleted_at IS NULL`,
					[ROLE_ADMIN]
				);
				assert.strictEqual(Number(admins[0]!.n), 1, 'the last admin stands');
			} finally {
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
