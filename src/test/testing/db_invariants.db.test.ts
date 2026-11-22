/**
 * `DB_INVARIANTS` over seeded rows: each invariant reports the state that
 * breaks it and stays quiet on the nearest state that doesn't, so a query that
 * matches nothing (or everything) fails here rather than passing every test it
 * checks.
 *
 * @module
 */

import { assert, beforeEach, test } from 'vitest';

import type { Db } from '#lib/db/db.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import {
	create_test_account_with_actor,
	create_test_role_grant_direct,
	type TestAccountWithActor
} from '#lib/testing/db_entities.ts';
import {
	DB_INVARIANTS,
	query_db_invariant_violations,
	validate_db_invariant_exclusions,
	type DbInvariantName
} from '#lib/testing/db_invariant_queries.ts';

import { describe_db } from '../db_fixture.ts';

/** The names of the invariants `db` breaks. */
const broken = async (db: Db): Promise<Array<DbInvariantName>> =>
	(await query_db_invariant_violations({ db })).map((v) => v.name);

const tombstone = async (db: Db, account: TestAccountWithActor): Promise<void> => {
	await db.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [account.account.id]);
	await db.query(`UPDATE actor SET deleted_at = NOW() WHERE account_id = $1`, [account.account.id]);
};

const insert_session = async (db: Db, account_id: string, created_at = 'NOW()'): Promise<void> => {
	await db.query(
		`INSERT INTO auth_session (id, account_id, created_at, expires_at)
		 VALUES (gen_random_uuid()::text, $1, ${created_at}, NOW() + INTERVAL '1 day')`,
		[account_id]
	);
};

const insert_token = async (db: Db, account_id: string, created_at = 'NOW()'): Promise<string> => {
	const [row] = await db.query<{ id: string }>(
		`INSERT INTO api_token (id, account_id, name, token_hash, scope, created_at)
		 VALUES ('tok_' || gen_random_uuid()::text, $1, 't', gen_random_uuid()::text, '{"kind":"full"}'::jsonb, ${created_at})
		 RETURNING id`,
		[account_id]
	);
	assert.ok(row);
	return row.id;
};

const insert_offer = async (
	db: Db,
	from: TestAccountWithActor,
	to: TestAccountWithActor,
	options: { to_actor_id?: string; terminal?: boolean; created_at?: string } = {}
): Promise<string> => {
	const [row] = await db.query<{ id: string }>(
		`INSERT INTO role_grant_offer (from_actor_id, to_account_id, to_actor_id, role, created_at, expires_at, superseded_at)
		 VALUES ($1, $2, $3, 'admin', ${options.created_at ?? 'NOW()'}, NOW() + INTERVAL '1 day', ${
				options.terminal ? 'NOW()' : 'NULL'
			})
		 RETURNING id`,
		[from.actor.id, to.account.id, options.to_actor_id ?? null]
	);
	assert.ok(row);
	return row.id;
};

const insert_invite = async (
	db: Db,
	issuer: TestAccountWithActor,
	options: { claimed?: boolean; created_at?: string } = {}
): Promise<string> => {
	const [row] = await db.query<{ id: string }>(
		`INSERT INTO invite (username, created_by, created_at, claimed_at)
		 VALUES ('invited', $1, ${options.created_at ?? 'NOW()'}, ${options.claimed ? 'NOW()' : 'NULL'})
		 RETURNING id`,
		[issuer.actor.id]
	);
	assert.ok(row);
	return row.id;
};

/** The successful `*_create` audit row of an offer, invite or API token, as both spines write it. */
const insert_create_row = async (
	db: Db,
	event_type: 'role_grant_offer_create' | 'invite_create' | 'token_create',
	key: 'offer_id' | 'invite_id' | 'token_id',
	id: string,
	account: TestAccountWithActor
): Promise<void> => {
	await db.query(
		`INSERT INTO audit_log (event_type, outcome, account_id, created_at, metadata)
		 VALUES ($1, 'success', $2, NOW() + INTERVAL '1 hour', jsonb_build_object($3::text, $4::text))`,
		[event_type, account.account.id, key, id]
	);
};

/** A successful removal of `account` in the audit log, at `created_at`. */
const insert_removal = async (
	db: Db,
	account: TestAccountWithActor,
	options: { event_type?: string; outcome?: string; created_at?: string } = {}
): Promise<void> => {
	await db.query(
		`INSERT INTO audit_log (event_type, outcome, target_account_id, created_at)
		 VALUES ($1, $2, $3, ${options.created_at ?? 'NOW()'})`,
		[options.event_type ?? 'account_delete', options.outcome ?? 'success', account.account.id]
	);
};

const HOUR_AGO = `NOW() - INTERVAL '1 hour'`;

test('every invariant has a distinct name', () => {
	const names = DB_INVARIANTS.map((i) => i.name);
	assert.strictEqual(new Set(names).size, names.length);
});

test('exclusions refuse an unknown invariant and an empty reason', () => {
	validate_db_invariant_exclusions({ credential_of_tombstoned_account: 'why' }, 'test');
	assert.throws(
		() => validate_db_invariant_exclusions({ no_such_invariant: 'why' } as never, 'test'),
		/unknown invariant 'no_such_invariant'/
	);
	assert.throws(
		() => validate_db_invariant_exclusions({ credential_of_tombstoned_account: ' ' }, 'test'),
		/needs a reason/
	);
});

describe_db('db_invariants', (get_db) => {
	// a bootstrapped database: the keeper holds keeper and admin, as a
	// production bootstrap leaves it; `a` and `b` are plain accounts
	let keeper: TestAccountWithActor;
	let a: TestAccountWithActor;
	let b: TestAccountWithActor;

	beforeEach(async () => {
		const db = get_db();
		keeper = await create_test_account_with_actor(db, { username: 'keeper' });
		for (const role of [ROLE_KEEPER, ROLE_ADMIN]) {
			await create_test_role_grant_direct(db, {
				actor_id: keeper.actor.id,
				role,
				granted_by: null
			});
		}
		await db.query(`UPDATE bootstrap_lock SET bootstrapped = true`);
		a = await create_test_account_with_actor(db, { username: 'alice' });
		b = await create_test_account_with_actor(db, { username: 'bob' });
	});

	test('a clean database breaks none', async () => {
		const db = get_db();
		await insert_session(db, a.account.id);
		await insert_token(db, a.account.id);
		await insert_offer(db, a, b, { to_actor_id: b.actor.id });
		await insert_invite(db, a);
		assert.deepStrictEqual(await broken(db), []);
	});

	test('credential_of_tombstoned_account', async () => {
		const db = get_db();
		await tombstone(db, a);
		assert.deepStrictEqual(await broken(db), []);
		await insert_session(db, a.account.id);
		assert.deepStrictEqual(await broken(db), ['credential_of_tombstoned_account']);
		await db.query(`DELETE FROM auth_session`);
		await insert_token(db, a.account.id);
		const [violation] = await query_db_invariant_violations({ db });
		assert.ok(violation);
		assert.strictEqual(violation.name, 'credential_of_tombstoned_account');
		assert.deepStrictEqual(
			violation.rows.map((r) => [r.kind, r.account_id]),
			[['api_token', a.account.id]]
		);
	});

	test('pending_offer_with_dead_party — a dead recipient', async () => {
		const db = get_db();
		await insert_offer(db, a, b);
		await tombstone(db, b);
		assert.deepStrictEqual(await broken(db), ['pending_offer_with_dead_party']);
		// an ended offer is no violation
		await db.query(`UPDATE role_grant_offer SET superseded_at = NOW()`);
		assert.deepStrictEqual(await broken(db), []);
	});

	test('pending_offer_with_dead_party — a dead grantor', async () => {
		const db = get_db();
		await insert_offer(db, a, b);
		await tombstone(db, a);
		assert.deepStrictEqual(await broken(db), ['pending_offer_with_dead_party']);
	});

	test('pending_offer_with_dead_party — a dead recipient actor on a live account', async () => {
		const db = get_db();
		await insert_offer(db, a, b, { to_actor_id: b.actor.id });
		await db.query(`UPDATE actor SET deleted_at = NOW() WHERE id = $1`, [b.actor.id]);
		assert.deepStrictEqual(await broken(db), [
			'pending_offer_with_dead_party',
			'actor_tombstone_disagrees_with_account'
		]);
	});

	test('unclaimed_invite_of_dead_issuer', async () => {
		const db = get_db();
		await insert_invite(db, a, { claimed: true });
		await tombstone(db, a);
		assert.deepStrictEqual(await broken(db), []);
		await db.query(`DELETE FROM invite`);
		await insert_invite(db, a);
		assert.deepStrictEqual(await broken(db), ['unclaimed_invite_of_dead_issuer']);
	});

	test('unclaimed_invite_of_dead_issuer — a purge that skipped the invite void', async () => {
		const db = get_db();
		// the end state of a purge of `a` whose invite-void step was skipped: the
		// cascade took the account and its actor, and `invite.created_by` went null
		const invite_id = await insert_invite(db, a, { created_at: HOUR_AGO });
		await insert_create_row(db, 'invite_create', 'invite_id', invite_id, a);
		await db.query(`UPDATE audit_log SET created_at = ${HOUR_AGO}`);
		assert.deepStrictEqual(await broken(db), []);
		await db.query(`DELETE FROM account WHERE id = $1`, [a.account.id]);
		await insert_removal(db, a, { event_type: 'account_purge' });
		const [row] = await db.query<{ created_by: string | null }>(
			`SELECT created_by FROM invite WHERE id = $1`,
			[invite_id]
		);
		assert.strictEqual(row?.created_by, null, 'the cascade nulled the issuer');
		assert.deepStrictEqual(await broken(db), [
			'unclaimed_invite_of_dead_issuer',
			'unclaimed_invite_outlived_issuer_removal'
		]);
		// an issuer the audit log never named is unknown, not dead
		await db.query(`DELETE FROM audit_log WHERE event_type = 'invite_create'`);
		assert.deepStrictEqual(await broken(db), []);
	});

	test('bootstrapped_without_live_keeper and bootstrapped_without_live_admin', async () => {
		const db = get_db();
		await db.query(`UPDATE role_grant SET revoked_at = NOW()`);
		assert.deepStrictEqual(await broken(db), [
			'bootstrapped_without_live_keeper',
			'bootstrapped_without_live_admin'
		]);
		// the keeper and the admin may be different accounts
		await db.query(`UPDATE role_grant SET revoked_at = NULL WHERE role = $1`, [ROLE_KEEPER]);
		await create_test_role_grant_direct(db, {
			actor_id: b.actor.id,
			role: ROLE_ADMIN,
			granted_by: null
		});
		assert.deepStrictEqual(await broken(db), []);
		// a tombstoned holder holds nothing
		await tombstone(db, b);
		assert.deepStrictEqual(await broken(db), ['bootstrapped_without_live_admin']);
		// nor does a scoped grant
		await db.query(
			`UPDATE role_grant SET scope_kind = 'classroom', scope_id = gen_random_uuid() WHERE role = $1`,
			[ROLE_KEEPER]
		);
		assert.deepStrictEqual(await broken(db), [
			'bootstrapped_without_live_keeper',
			'bootstrapped_without_live_admin'
		]);
	});

	test('account_without_bootstrap', async () => {
		const db = get_db();
		await db.query(`UPDATE bootstrap_lock SET bootstrapped = false`);
		assert.deepStrictEqual(await broken(db), ['account_without_bootstrap']);
		// before bootstrap, an empty database owes nothing
		await db.query(`DELETE FROM account`);
		assert.deepStrictEqual(await broken(db), []);
	});

	test('actor_tombstone_disagrees_with_account', async () => {
		const db = get_db();
		await db.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [a.account.id]);
		assert.deepStrictEqual(await broken(db), ['actor_tombstone_disagrees_with_account']);
		await db.query(`UPDATE actor SET deleted_at = NOW() WHERE account_id = $1`, [a.account.id]);
		assert.deepStrictEqual(await broken(db), []);
		await db.query(`UPDATE account SET deleted_at = NULL WHERE id = $1`, [a.account.id]);
		assert.deepStrictEqual(await broken(db), ['actor_tombstone_disagrees_with_account']);
	});

	test('offer_to_actor_outside_to_account', async () => {
		const db = get_db();
		await insert_offer(db, a, b, { to_actor_id: a.actor.id, terminal: true });
		assert.deepStrictEqual(await broken(db), ['offer_to_actor_outside_to_account']);
	});

	test('invite_claimed_by_without_claimed_at', async () => {
		const db = get_db();
		await db.query(
			`INSERT INTO invite (username, created_by, claimed_by) VALUES ('invited', $1, $2)`,
			[a.actor.id, b.account.id]
		);
		assert.deepStrictEqual(await broken(db), ['invite_claimed_by_without_claimed_at']);
	});

	test('pending_offer_outlived_party_removal — sees through an undelete', async () => {
		const db = get_db();
		// a removal before the offer was made is history the offer postdates
		await insert_removal(db, b, { created_at: HOUR_AGO });
		await insert_offer(db, a, b);
		assert.deepStrictEqual(await broken(db), []);
		// a failed removal, another event, or a purge (whose cascade takes the
		// offer) is not one
		await insert_removal(db, b, { outcome: 'failure' });
		await insert_removal(db, b, { event_type: 'account_undelete' });
		await insert_removal(db, b, { event_type: 'account_purge' });
		assert.deepStrictEqual(await broken(db), []);
		// a delete after it, with both parties live again
		await insert_removal(db, b);
		assert.deepStrictEqual(await broken(db), ['pending_offer_outlived_party_removal']);
	});

	test('pending_offer_outlived_party_removal — the grantor', async () => {
		const db = get_db();
		await insert_offer(db, a, b, { created_at: HOUR_AGO });
		await insert_removal(db, a);
		assert.deepStrictEqual(await broken(db), ['pending_offer_outlived_party_removal']);
	});

	test('pending_offer_outlived_party_removal — ordered by audit seq when the offer has a create row', async () => {
		const db = get_db();
		const offer_id = await insert_offer(db, a, b);
		// the clocks say the delete came first; the create row's `seq` says the
		// offer did, and `seq` is what counts
		await insert_removal(db, b, { created_at: HOUR_AGO });
		assert.deepStrictEqual(await broken(db), []);
		await insert_create_row(db, 'role_grant_offer_create', 'offer_id', offer_id, a);
		await insert_removal(db, b, { created_at: HOUR_AGO });
		assert.deepStrictEqual(await broken(db), ['pending_offer_outlived_party_removal']);
	});

	test('unclaimed_invite_outlived_issuer_removal', async () => {
		const db = get_db();
		await insert_removal(db, a, { created_at: HOUR_AGO });
		await insert_invite(db, a);
		assert.deepStrictEqual(await broken(db), []);
		await insert_removal(db, a);
		assert.deepStrictEqual(await broken(db), ['unclaimed_invite_outlived_issuer_removal']);
	});

	test('credential_outlived_account_removal', async () => {
		const db = get_db();
		await insert_removal(db, a, { created_at: HOUR_AGO });
		await insert_session(db, a.account.id);
		await insert_token(db, a.account.id);
		assert.deepStrictEqual(await broken(db), []);
		await insert_session(db, b.account.id, `NOW() - INTERVAL '2 hours'`);
		await insert_removal(db, b, { created_at: HOUR_AGO });
		const violations = await query_db_invariant_violations({ db });
		assert.deepStrictEqual(
			violations.map((v) => v.name),
			['credential_outlived_account_removal']
		);
		assert.deepStrictEqual(
			violations[0]?.rows.map((r) => [r.kind, r.account_id]),
			[['auth_session', b.account.id]]
		);
	});

	test('credential_outlived_account_removal — a tie counts as before the removal', async () => {
		const db = get_db();
		await db.query(
			`INSERT INTO auth_session (id, account_id, created_at, expires_at)
			 VALUES ('tied', $1, '2026-01-01T00:00:00Z', NOW() + INTERVAL '1 day')`,
			[a.account.id]
		);
		await insert_removal(db, a, { created_at: `'2026-01-01T00:00:00Z'` });
		assert.deepStrictEqual(await broken(db), ['credential_outlived_account_removal']);
	});

	test('credential_outlived_account_removal — a token ordered by audit seq when it has a create row', async () => {
		const db = get_db();
		const token_id = await insert_token(db, a.account.id);
		// the clocks say the delete came first; the create row's `seq` says the
		// token did, and `seq` is what counts
		await insert_removal(db, a, { created_at: HOUR_AGO });
		assert.deepStrictEqual(await broken(db), []);
		await insert_create_row(db, 'token_create', 'token_id', token_id, a);
		await insert_removal(db, a, { created_at: HOUR_AGO });
		assert.deepStrictEqual(await broken(db), ['credential_outlived_account_removal']);
	});

	test('credential_outlived_account_removal — a token minted after an undelete by a transaction begun before the delete', async () => {
		const db = get_db();
		// the long-transaction walk: the delete (and the undelete) commit while
		// the mint waits on the account lock, so the token's `created_at` — its
		// transaction's start — precedes the delete, and its create row follows it
		await insert_removal(db, a, { created_at: HOUR_AGO });
		const token_id = await insert_token(db, a.account.id, `NOW() - INTERVAL '2 hours'`);
		await insert_create_row(db, 'token_create', 'token_id', token_id, a);
		assert.deepStrictEqual(await broken(db), []);
		// a failed mint's row orders nothing
		const failed_id = await insert_token(db, b.account.id, `NOW() - INTERVAL '2 hours'`);
		await insert_removal(db, b, { created_at: HOUR_AGO });
		await db.query(
			`INSERT INTO audit_log (event_type, outcome, account_id, metadata)
			 VALUES ('token_create', 'failure', $1, jsonb_build_object('token_id', $2::text))`,
			[b.account.id, failed_id]
		);
		assert.deepStrictEqual(await broken(db), ['credential_outlived_account_removal']);
	});

	test('excluding both role-reading invariants leaves the statement well formed', async () => {
		const db = get_db();
		await db.query(`UPDATE role_grant SET revoked_at = NOW()`);
		assert.deepStrictEqual(
			(
				await query_db_invariant_violations(
					{ db },
					{
						bootstrapped_without_live_keeper: 'the keeper half is under test elsewhere',
						bootstrapped_without_live_admin: 'the admin half is under test elsewhere'
					}
				)
			).map((v) => v.name),
			[]
		);
	});

	test('excluding the keeper invariant leaves the admin one reading its role', async () => {
		const db = get_db();
		await db.query(`UPDATE role_grant SET revoked_at = NOW()`);
		assert.deepStrictEqual(
			(
				await query_db_invariant_violations(
					{ db },
					{ bootstrapped_without_live_keeper: 'the keeper half is under test elsewhere' }
				)
			).map((v) => v.name),
			['bootstrapped_without_live_admin']
		);
	});

	test('excluded invariants are not queried', async () => {
		const db = get_db();
		await db.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [a.account.id]);
		assert.deepStrictEqual(
			await query_db_invariant_violations(
				{ db },
				{ actor_tombstone_disagrees_with_account: 'seeded by hand' }
			),
			[]
		);
	});
});
