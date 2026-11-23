/**
 * The row locks an offer accept and the multi-row offer writes take, pinned
 * in-process on real `pg`, where no wire route reaches them or where a query
 * is a consumer's entry point as well as a handler's.
 *
 * Each case plays the other transaction itself: its first locks are taken and
 * held, the query under test runs in a transaction of its own, the held one
 * takes the rest of its locks once the query waits, and both must commit.
 * Nothing asserts a wait or a duration — a query that never waits is judged by
 * what it left behind, and one that takes its locks in the wrong order
 * deadlocks, and the test fails on the aborted side.
 *
 * - **The accept's account locks** — two sibling accepts take turns at the
 *   recipient's row; an admin recipient sorting below its grantor waits at its
 *   own row on a last-admin guard that holds it, holding neither; an accept
 *   whose grantor's grant names the recipient's actor holds the grantor's
 *   account, so a purge's cascade setting that `granted_by` null never waits
 *   on it.
 * - **Multi-row offer writes in id order** — the expiry sweep (no spine serves
 *   it over the wire) against a holder of the lowest of its rows.
 * - **Offers before grants** — `query_revoke_role_grant` (every revoke: the
 *   admin handler's, a self-service disable's, a consumer's direct call) and
 *   `query_role_grant_revoke_for_scope` lock the offers they
 *   supersede before they update a grant, so an accept holding its offer and
 *   then inserting the grant's successor never waits on their update.
 * - **The rows a revoke and a teardown write** — `query_revoke_role_grant`
 *   takes its revokee's account row first, so a re-offer to the revokee waits
 *   or is waited for and is superseded; a scope teardown supersedes only the
 *   offers its lock took.
 *
 * Real `pg` only (`TEST_DATABASE_URL`): the in-memory drivers have one
 * connection, so the query would queue behind the holder whatever it locks.
 * Their wire twins are in `cross_backend/lock_pins.cross.test.ts`; the Rust
 * twins in `fuz_auth`'s `tests/account_delete_races.rs`.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { query_create_account_with_actor } from '#lib/auth/account_queries.ts';
import {
	query_accept_offer,
	query_role_grant_offer_sweep_expired,
	RoleGrantOfferAlreadyTerminalError,
	RoleGrantOfferRecipientNotActiveError,
	query_revoke_role_grant
} from '#lib/auth/role_grant_offer_queries.ts';
import {
	query_count_active_accounts_with_global_role_locked,
	query_role_grant_revoke_for_scope
} from '#lib/auth/role_grant_queries.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { auth_integration_truncate_tables } from '#lib/testing/db.ts';
import { create_describe_db } from '#lib/testing/describe_db.ts';
import type { Db } from '#lib/db/db.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { pg_factory } from '../db_fixture.ts';

const log = new Logger('test', { level: 'off' });

/** How long the query may take to show it waits, a bound on a hang only. */
const LOCK_WAIT_DEADLINE_MS = 20_000;

const ROLE = 'lock_order_role';

const lock_waiters = async (db: Db): Promise<number> =>
	Number(
		(
			await db.query<{ n: string }>(
				`SELECT COUNT(*) AS n FROM pg_stat_activity
				 WHERE wait_event_type = 'Lock' AND datname = current_database()`
			)
		)[0]!.n
	);

/**
 * Hold `held`'s locks, run `query` in a transaction of its own, then — once
 * the query waits on a lock or has finished — run `then` on the held
 * transaction and commit it. Returns the query's result, or what it threw.
 */
const against_held = async <T>(
	db: Db,
	held: (tx: Db) => Promise<void>,
	query: (tx: Db) => Promise<T>,
	then: (tx: Db) => Promise<void> = async () => {}
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
	const locked = Promise.withResolvers<void>();
	// `true` to play `then`, `false` to end the held transaction without it
	const go = Promise.withResolvers<boolean>();
	const holder = db.transaction(async (tx) => {
		await held(tx);
		locked.resolve();
		if (await go.promise) await then(tx);
	});
	await locked.promise;
	const state = { settled: false };
	const ran = db
		.transaction((tx) => query(tx))
		.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error })
		)
		.finally(() => {
			state.settled = true;
		});
	let waited = false;
	try {
		const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
		while (!state.settled && (await lock_waiters(db)) < 1) {
			assert.ok(Date.now() < deadline, 'the query neither waits nor finishes');
			await wait(5);
		}
		waited = true;
	} finally {
		// a failed wait still ends the held transaction, so the pool can close
		go.resolve(waited);
	}
	await holder;
	return ran;
};

/** `n` fresh ids, ascending — the order every multi-row offer write takes. */
const ascending_ids = (n: number): Array<Uuid> =>
	Array.from({ length: n }, () => crypto.randomUUID() as string as Uuid).sort();

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

describe_pg('offer accepts and multi-row offer writes, against a held transaction', (get_db) => {
	const account = async (db: Db, username: string) => {
		const { account, actor } = await query_create_account_with_actor(
			{ db },
			{ username, password_hash: 'hash' }
		);
		return { account_id: account.id, actor_id: actor.id };
	};
	const insert_offer = (
		db: Db,
		o: { id: string; from: string; to: string; role?: string; scope_id?: string; expired?: boolean }
	) =>
		db.query(
			`INSERT INTO role_grant_offer (id, from_actor_id, to_account_id, role, scope_kind, scope_id, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6, NOW() + ${o.expired ? "INTERVAL '-1 hour'" : "INTERVAL '1 day'"})`,
			[o.id, o.from, o.to, o.role ?? ROLE, o.scope_id ? 'lock_scope' : null, o.scope_id ?? null]
		);
	const insert_grant = async (
		db: Db,
		g: { actor: string; role?: string; scope_id?: string; granted_by?: string }
	): Promise<Uuid> =>
		(
			await db.query<{ id: Uuid }>(
				`INSERT INTO role_grant (actor_id, role, scope_kind, scope_id, granted_by)
				 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
				[
					g.actor,
					g.role ?? ROLE,
					g.scope_id ? 'lock_scope' : null,
					g.scope_id ?? null,
					g.granted_by ?? null
				]
			)
		)[0]!.id;
	const offer_state = async (db: Db, id: string) =>
		(
			await db.query<{ accepted: boolean; superseded: boolean }>(
				`SELECT accepted_at IS NOT NULL AS accepted, superseded_at IS NOT NULL AS superseded
				 FROM role_grant_offer WHERE id = $1`,
				[id]
			)
		)[0];
	/** An accept of `offer` played up to its grant: its offer claimed, then a successor grant written. */
	const claim = (id: string) => async (tx: Db) => {
		await tx.query(`SELECT id FROM role_grant_offer WHERE id = $1 FOR UPDATE`, [id]);
	};

	test('two sibling accepts take turns at the recipient: the second is refused', async () => {
		const db = get_db();
		const g1 = await account(db, 'lo_sib_g1');
		const g2 = await account(db, 'lo_sib_g2');
		const r = await account(db, 'lo_sib_r');
		// the sent offer sorts first: an accept passing the recipient's row
		// claims it, then waits on the played one holding what the played
		// supersede needs
		const [sent, played] = ascending_ids(2) as [Uuid, Uuid];
		await insert_offer(db, { id: played, from: g1.actor_id, to: r.account_id });
		await insert_offer(db, { id: sent, from: g2.actor_id, to: r.account_id });
		const result = await against_held(
			db,
			async (tx) => {
				// the weakest lock an account's writer takes — an accept takes it harder
				await tx.query(`SELECT id FROM account WHERE id = $1 FOR SHARE`, [r.account_id]);
				await claim(played)(tx);
				const grant = await insert_grant(tx, { actor: r.actor_id, granted_by: g1.actor_id });
				await tx.query(
					`UPDATE role_grant_offer SET accepted_at = NOW(), resulting_role_grant_id = $2 WHERE id = $1`,
					[played, grant]
				);
			},
			(tx) =>
				query_accept_offer(
					{ db: tx, log },
					{ offer_id: sent, to_account_id: r.account_id, actor_id: r.actor_id }
				),
			async (tx) => {
				await tx.query(`UPDATE role_grant_offer SET superseded_at = NOW() WHERE id = $1`, [sent]);
			}
		);
		assert.ok(!result.ok, 'the second accept is refused');
		assert.instanceOf(result.error, RoleGrantOfferAlreadyTerminalError);
		assert.deepStrictEqual(await offer_state(db, sent), { accepted: false, superseded: true });
	});

	// A last-admin guard of a third admin's removal takes account rows in id
	// order, the recipient's before its grantor's here: played, its first row,
	// then — once the accept waits — the rest of it and the write.
	test('an accept by an admin recipient sorting below its grantor waits on the guard holding neither', async () => {
		const db = get_db();
		const a = await account(db, 'lo_cyc_a');
		const b = await account(db, 'lo_cyc_b');
		const third = await account(db, 'lo_cyc_c');
		const [r, g] = a.account_id < b.account_id ? [a, b] : [b, a];
		for (const admin of [r, g, third])
			await insert_grant(db, { actor: admin.actor_id, role: ROLE_ADMIN });
		const [offer] = ascending_ids(1) as [Uuid];
		await insert_offer(db, { id: offer, from: g.actor_id, to: r.account_id, role: ROLE_ADMIN });
		const result = await against_held(
			db,
			async (tx) => {
				await tx.query(`SELECT id FROM account WHERE id = $1 FOR NO KEY UPDATE`, [r.account_id]);
			},
			(tx) =>
				query_accept_offer(
					{ db: tx, log },
					{ offer_id: offer, to_account_id: r.account_id, actor_id: r.actor_id }
				),
			async (tx) => {
				await query_count_active_accounts_with_global_role_locked({ db: tx }, ROLE_ADMIN);
				await tx.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [third.account_id]);
			}
		);
		assert.ok(result.ok, `the accept: ${String(result.ok || result.error)}`);
		assert.deepStrictEqual(await offer_state(db, offer), { accepted: true, superseded: false });
	});

	// The grantor's account sorts below the recipient's, and the grantor's admin
	// grant names the recipient's actor. A purge of the recipient played: its
	// account row, its offers superseded; once the accept waits, its delete,
	// whose cascade sets that `granted_by` null.
	test("an accept across a purge of its recipient whose actor granted the grantor's admin", async () => {
		const db = get_db();
		const a = await account(db, 'lo_gb_a');
		const b = await account(db, 'lo_gb_b');
		const [g, r] = a.account_id < b.account_id ? [a, b] : [b, a];
		const grant = await insert_grant(db, {
			actor: g.actor_id,
			role: ROLE_ADMIN,
			granted_by: r.actor_id
		});
		const [offer] = ascending_ids(1) as [Uuid];
		await insert_offer(db, { id: offer, from: g.actor_id, to: r.account_id, role: ROLE_ADMIN });
		const result = await against_held(
			db,
			async (tx) => {
				await tx.query(`SELECT id FROM account WHERE id = $1 FOR UPDATE`, [r.account_id]);
				await tx.query(
					`UPDATE role_grant_offer SET superseded_at = NOW() WHERE to_account_id = $1`,
					[r.account_id]
				);
			},
			(tx) =>
				query_accept_offer(
					{ db: tx, log },
					{ offer_id: offer, to_account_id: r.account_id, actor_id: r.actor_id }
				),
			async (tx) => {
				await tx.query(`DELETE FROM account WHERE id = $1`, [r.account_id]);
			}
		);
		assert.ok(!result.ok, 'the accept by the purged recipient is refused');
		assert.instanceOf(result.error, RoleGrantOfferRecipientNotActiveError);
		const rows = await db.query<{ granted_by: string | null }>(
			`SELECT granted_by FROM role_grant WHERE id = $1`,
			[grant]
		);
		assert.deepStrictEqual(
			rows,
			[{ granted_by: null }],
			"the cascade set the grant's granted_by null"
		);
	});

	// Seeded against its id order on every plan: the higher id stored first,
	// expiring first, and first in the pending-offer index (one recipient, its
	// grantor's actor sorting first), so a plan walking the rows as stored, by
	// expiry or by that index reaches it first.
	test('the expiry sweep takes its offers in id order', async () => {
		const db = get_db();
		const a = await account(db, 'lo_sweep_a');
		const b = await account(db, 'lo_sweep_b');
		const x = await account(db, 'lo_sweep_x');
		const [first_grantor, second_grantor] = a.actor_id < b.actor_id ? [a, b] : [b, a];
		const [low, high] = ascending_ids(2) as [Uuid, Uuid];
		await insert_offer(db, {
			id: high,
			from: first_grantor.actor_id,
			to: x.account_id,
			expired: true
		});
		await db.query(
			`UPDATE role_grant_offer SET expires_at = expires_at - INTERVAL '1 hour' WHERE id = $1`,
			[high]
		);
		await insert_offer(db, {
			id: low,
			from: second_grantor.actor_id,
			to: x.account_id,
			expired: true
		});
		const result = await against_held(
			db,
			claim(low),
			(tx) => query_role_grant_offer_sweep_expired({ db: tx }),
			claim(high)
		);
		assert.ok(result.ok, `the sweep: ${String(result.ok || result.error)}`);
		assert.deepStrictEqual(result.value.map((o) => o.id).toSorted(), [low, high]);
	});

	// An accept played: its offer claimed, then — once the revoke waits — the
	// successor grant inserted, whose unique slot is the revoked grant's. A
	// revoke that locks the offer first waits holding nothing the insert needs;
	// one that updates the grant first holds the slot the insert waits on while
	// waiting on the offer, and the two deadlock.
	test('a revoke locks the offers it supersedes before it updates its grant', async () => {
		const db = get_db();
		const g = await account(db, 'lo_rv_g');
		const r = await account(db, 'lo_rv_r');
		const held_grant = await insert_grant(db, { actor: r.actor_id });
		const [offer] = ascending_ids(1) as [Uuid];
		await insert_offer(db, { id: offer, from: g.actor_id, to: r.account_id });
		const result = await against_held(
			db,
			claim(offer),
			(tx) => query_revoke_role_grant({ db: tx }, held_grant, r.actor_id, null),
			async (tx) => {
				await tx.query(
					`INSERT INTO role_grant (actor_id, role, granted_by, source_offer_id)
					 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
					[r.actor_id, ROLE, g.actor_id, offer]
				);
			}
		);
		assert.ok(result.ok, `the revoke: ${String(result.ok || result.error)}`);
		assert.ok(result.value, 'the grant is revoked');
		assert.deepStrictEqual(await offer_state(db, offer), { accepted: false, superseded: true });
	});

	test('a scope teardown locks the offers it supersedes before it updates its grants', async () => {
		const db = get_db();
		const g = await account(db, 'lo_sc_g');
		const r = await account(db, 'lo_sc_r');
		const scope_id = crypto.randomUUID() as string as Uuid;
		await insert_grant(db, { actor: r.actor_id, scope_id });
		const [offer] = ascending_ids(1) as [Uuid];
		await insert_offer(db, { id: offer, from: g.actor_id, to: r.account_id, scope_id });
		const result = await against_held(
			db,
			claim(offer),
			(tx) => query_role_grant_revoke_for_scope({ db: tx }, scope_id, null),
			async (tx) => {
				await tx.query(
					`INSERT INTO role_grant (actor_id, role, scope_kind, scope_id, granted_by, source_offer_id)
					 VALUES ($1, $2, 'lock_scope', $3, $4, $5) ON CONFLICT DO NOTHING`,
					[r.actor_id, ROLE, scope_id, g.actor_id, offer]
				);
			}
		);
		assert.ok(result.ok, `the teardown: ${String(result.ok || result.error)}`);
		assert.strictEqual(result.value.revoked.length, 1);
		assert.deepStrictEqual(await offer_state(db, offer), { accepted: false, superseded: true });
	});
	// A re-offer to the revokee played: both parties' rows shared, as an offer
	// create takes them; once the revoke waits, the upsert of the pending offer
	// it refreshes. The query takes the revokee's row first itself (an admin
	// revoke's last-admin guard may already hold it), so it waits there and then
	// supersedes the refreshed offer; one that takes no account row supersedes
	// it before the upsert commits, which then writes a fresh pending offer
	// after the revoke.
	test("a revoke takes its revokee's account before its offers", async () => {
		const db = get_db();
		const g = await account(db, 'lo_rva_g');
		const r = await account(db, 'lo_rva_r');
		const held_grant = await insert_grant(db, { actor: r.actor_id });
		const [offer] = ascending_ids(1) as [Uuid];
		await insert_offer(db, { id: offer, from: g.actor_id, to: r.account_id });
		const result = await against_held(
			db,
			async (tx) => {
				await tx.query(`SELECT id FROM account WHERE id = ANY($1) ORDER BY id FOR SHARE`, [
					[g.account_id, r.account_id]
				]);
			},
			(tx) => query_revoke_role_grant({ db: tx }, held_grant, r.actor_id, null),
			async (tx) => {
				await tx.query(
					`INSERT INTO role_grant_offer (from_actor_id, to_account_id, role, expires_at)
					 VALUES ($1, $2, $3, NOW() + INTERVAL '2 days')
					 ON CONFLICT (to_account_id, role, COALESCE(scope_kind, 'GLOBAL'),
					   COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), from_actor_id)
					   WHERE accepted_at IS NULL AND declined_at IS NULL
					     AND retracted_at IS NULL AND superseded_at IS NULL
					 DO UPDATE SET expires_at = EXCLUDED.expires_at`,
					[g.actor_id, r.account_id, ROLE]
				);
			}
		);
		assert.ok(result.ok, `the revoke: ${String(result.ok || result.error)}`);
		const pending = await db.query<{ n: string }>(
			`SELECT COUNT(*) AS n FROM role_grant_offer
			 WHERE to_account_id = $1 AND accepted_at IS NULL AND declined_at IS NULL
			   AND retracted_at IS NULL AND superseded_at IS NULL`,
			[r.account_id]
		);
		assert.strictEqual(Number(pending[0]!.n), 0, 'no offer to the revokee left pending');
	});

	// A holder of the scope's grant stalls the teardown's grant update after its
	// offer lock; the holder then writes a new offer at the scope and commits.
	// The teardown supersedes the offers its lock took, and leaves the new one
	// pending: nothing keeps an offer at a scope out, so an offer it didn't lock
	// is one it would take out of order.
	test('a scope teardown supersedes only the offers its lock took', async () => {
		const db = get_db();
		const g = await account(db, 'lo_sco_g');
		const r = await account(db, 'lo_sco_r');
		const scope_id = crypto.randomUUID() as string as Uuid;
		const grant = await insert_grant(db, { actor: r.actor_id, scope_id });
		const [locked, late] = ascending_ids(2) as [Uuid, Uuid];
		await insert_offer(db, { id: locked, from: g.actor_id, to: r.account_id, scope_id });
		const result = await against_held(
			db,
			async (tx) => {
				await tx.query(`SELECT id FROM role_grant WHERE id = $1 FOR NO KEY UPDATE`, [grant]);
			},
			(tx) => query_role_grant_revoke_for_scope({ db: tx }, scope_id, null),
			async (tx) => {
				await insert_offer(tx, { id: late, from: r.actor_id, to: g.account_id, scope_id });
			}
		);
		assert.ok(result.ok, `the teardown: ${String(result.ok || result.error)}`);
		assert.deepStrictEqual(
			result.value.superseded_offers.map((o) => o.id),
			[locked]
		);
		assert.deepStrictEqual(await offer_state(db, late), { accepted: false, superseded: false });
	});
});
