/**
 * Tests for backend_account_queries.ts - Account and actor CRUD.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	query_create_account,
	query_account_by_id,
	query_account_by_username,
	query_account_by_email,
	query_account_by_username_or_email,
	query_update_account_password,
	query_account_soft_delete,
	query_account_undelete,
	query_actor_soft_delete,
	query_actor_undelete,
	query_purge_account,
	query_account_has_any,
	query_create_actor,
	query_actor_by_id,
	query_create_account_with_actor,
	query_admin_account_list
} from '#lib/auth/account_queries.ts';

import { describe_db } from '../db_fixture.ts';

describe_db('account queries', (get_db) => {
	describe('AccountQueries', () => {
		test('create returns an account with generated uuid', async () => {
			const db = get_db();
			const deps = { db };
			const account = await query_create_account(deps, {
				username: 'alice',
				password_hash: 'hash123'
			});
			assert.ok(account.id);
			assert.strictEqual(account.username, 'alice');
			assert.strictEqual(account.password_hash, 'hash123');
			assert.strictEqual(account.email, null);
			assert.ok(account.created_at);
			assert.ok(account.updated_at);
		});

		test('create with email', async () => {
			const db = get_db();
			const deps = { db };
			const account = await query_create_account(deps, {
				username: 'bob',
				password_hash: 'hash456',
				email: 'bob@example.com'
			});
			assert.strictEqual(account.email, 'bob@example.com');
		});

		test('find_by_id returns the account', async () => {
			const db = get_db();
			const deps = { db };
			const created = await query_create_account(deps, {
				username: 'alice',
				password_hash: 'hash'
			});
			const found = await query_account_by_id(deps, created.id);
			assert.ok(found);
			assert.strictEqual(found.username, 'alice');
		});

		test('find_by_id returns undefined for missing id', async () => {
			const db = get_db();
			const deps = { db };
			const found = await query_account_by_id(deps, '00000000-0000-0000-0000-000000000099');
			assert.strictEqual(found, undefined);
		});

		test('find_by_username returns the account', async () => {
			const db = get_db();
			const deps = { db };
			await query_create_account(deps, { username: 'charlie', password_hash: 'hash' });
			const found = await query_account_by_username(deps, 'charlie');
			assert.ok(found);
			assert.strictEqual(found.username, 'charlie');
		});

		test('find_by_username returns undefined for missing username', async () => {
			const db = get_db();
			const deps = { db };
			const found = await query_account_by_username(deps, 'nonexistent');
			assert.strictEqual(found, undefined);
		});

		test('find_by_email is case-insensitive', async () => {
			const db = get_db();
			const deps = { db };
			await query_create_account(deps, {
				username: 'dave',
				password_hash: 'hash',
				email: 'Dave@Example.COM'
			});
			const found = await query_account_by_email(deps, 'dave@example.com');
			assert.ok(found);
			assert.strictEqual(found.username, 'dave');
		});

		test('update_password changes the hash when expected_hash matches', async () => {
			const db = get_db();
			const deps = { db };
			const account = await query_create_account(deps, {
				username: 'eve',
				password_hash: 'old_hash'
			});
			const updated = await query_update_account_password(
				deps,
				account.id,
				'new_hash',
				null,
				'old_hash'
			);
			assert.strictEqual(updated, true);
			const reread = await query_account_by_id(deps, account.id);
			assert.ok(reread);
			assert.strictEqual(reread.password_hash, 'new_hash');
		});

		test('update_password refuses when expected_hash is stale (verify-write atomic)', async () => {
			const db = get_db();
			const deps = { db };
			const account = await query_create_account(deps, {
				username: 'eve_race',
				password_hash: 'current_hash'
			});
			// Caller computed `expected_hash` from a stale read of the account.
			const updated = await query_update_account_password(
				deps,
				account.id,
				'attacker_hash',
				null,
				'wrong_hash'
			);
			assert.strictEqual(updated, false, 'mismatched expected_hash must not update');
			const reread = await query_account_by_id(deps, account.id);
			assert.ok(reread);
			assert.strictEqual(
				reread.password_hash,
				'current_hash',
				'password_hash must remain unchanged'
			);
		});

		test('soft-delete tombstones the account; auth lookup excludes it, purge removes it', async () => {
			const db = get_db();
			const deps = { db };
			const { account, actor } = await query_create_account_with_actor(deps, {
				username: 'frank',
				password_hash: 'hash',
				email: 'frank@example.com'
			});

			// Soft-delete records the deleter + returns the identity snapshot.
			const snapshot = await query_account_soft_delete(deps, account.id, actor.id);
			assert.deepStrictEqual(snapshot, { username: 'frank', email: 'frank@example.com' });
			const tombstone = await db.query_one<{ deleted_by: string | null }>(
				`SELECT deleted_by FROM account WHERE id = $1`,
				[account.id]
			);
			assert.strictEqual(tombstone?.deleted_by, actor.id);
			// Auth-resolution lookup excludes the tombstoned account...
			assert.strictEqual(await query_account_by_id(deps, account.id), undefined);
			// ...but the row survives (username stays reserved via the
			// unconditional unique index — by_username still finds it).
			assert.ok(await query_account_by_username(deps, 'frank'));
			// Soft-delete is idempotent: a second call flips nothing.
			assert.strictEqual(await query_account_soft_delete(deps, account.id, actor.id), undefined);
			// Actor soft-delete flips once, then no-ops.
			assert.strictEqual(await query_actor_soft_delete(deps, actor.id, actor.id), true);
			assert.strictEqual(await query_actor_soft_delete(deps, actor.id, actor.id), false);

			// Purge hard-removes the (soft-deleted) row and returns the snapshot.
			const purged = await query_purge_account(deps, account.id);
			assert.deepStrictEqual(purged, { username: 'frank', email: 'frank@example.com' });
			assert.strictEqual(await query_account_by_username(deps, 'frank'), undefined);
		});

		test('purge returns undefined for missing account', async () => {
			const db = get_db();
			const deps = { db };
			const purged = await query_purge_account(deps, '00000000-0000-0000-0000-000000000099');
			assert.strictEqual(purged, undefined);
		});

		test('undelete clears the tombstone on account + actor; auth lookup finds it again', async () => {
			const db = get_db();
			const deps = { db };
			const { account, actor } = await query_create_account_with_actor(deps, {
				username: 'grace',
				password_hash: 'hash',
				email: 'grace@example.com'
			});

			// Tombstone the account + actor, then reactivate.
			await query_account_soft_delete(deps, account.id, actor.id);
			assert.strictEqual(await query_actor_soft_delete(deps, actor.id, actor.id), true);
			assert.strictEqual(await query_account_by_id(deps, account.id), undefined);

			// Undelete returns the identity snapshot and clears deleted_at/deleted_by.
			const snapshot = await query_account_undelete(deps, account.id);
			assert.deepStrictEqual(snapshot, { username: 'grace', email: 'grace@example.com' });
			const row = await db.query_one<{ deleted_at: string | null; deleted_by: string | null }>(
				`SELECT deleted_at, deleted_by FROM account WHERE id = $1`,
				[account.id]
			);
			assert.strictEqual(row?.deleted_at, null);
			assert.strictEqual(row?.deleted_by, null);
			// Auth-resolution lookup finds the reactivated account again.
			assert.ok(await query_account_by_id(deps, account.id));

			// Actor undelete flips the tombstoned actor back, then no-ops.
			assert.strictEqual(await query_actor_undelete(deps, actor.id), true);
			assert.strictEqual(await query_actor_undelete(deps, actor.id), false);
			const actor_row = await db.query_one<{ deleted_at: string | null }>(
				`SELECT deleted_at FROM actor WHERE id = $1`,
				[actor.id]
			);
			assert.strictEqual(actor_row?.deleted_at, null);

			// Undelete is a no-op on an already-active account.
			assert.strictEqual(await query_account_undelete(deps, account.id), undefined);
		});

		test('has_any returns false when empty', async () => {
			const db = get_db();
			const deps = { db };
			assert.strictEqual(await query_account_has_any(deps), false);
		});

		test('has_any returns true after creating an account', async () => {
			const db = get_db();
			const deps = { db };
			await query_create_account(deps, { username: 'grace', password_hash: 'hash' });
			assert.strictEqual(await query_account_has_any(deps), true);
		});

		test('find_by_username_or_email finds by username', async () => {
			const db = get_db();
			const deps = { db };
			await query_create_account(deps, { username: 'alice', password_hash: 'hash' });
			const found = await query_account_by_username_or_email(deps, 'alice');
			assert.ok(found);
			assert.strictEqual(found.username, 'alice');
		});

		test('find_by_username_or_email finds by email', async () => {
			const db = get_db();
			const deps = { db };
			await query_create_account(deps, {
				username: 'bob',
				password_hash: 'hash',
				email: 'bob@school.edu'
			});
			const found = await query_account_by_username_or_email(deps, 'bob@school.edu');
			assert.ok(found);
			assert.strictEqual(found.username, 'bob');
		});

		test('find_by_username_or_email is case-insensitive for email', async () => {
			const db = get_db();
			const deps = { db };
			await query_create_account(deps, {
				username: 'carol',
				password_hash: 'hash',
				email: 'Carol@School.Edu'
			});
			const found = await query_account_by_username_or_email(deps, 'carol@school.edu');
			assert.ok(found);
			assert.strictEqual(found.username, 'carol');
		});

		test('find_by_username_or_email returns undefined when not found', async () => {
			const db = get_db();
			const deps = { db };
			const found = await query_account_by_username_or_email(deps, 'nobody@nowhere.com');
			assert.strictEqual(found, undefined);
		});

		test('find_by_username_or_email prefers email when input contains @', async () => {
			const db = get_db();
			const deps = { db };
			await query_create_account(deps, {
				username: 'user1',
				password_hash: 'hash',
				email: 'shared@test.com'
			});
			// Input contains @, so email lookup runs first
			const found = await query_account_by_username_or_email(deps, 'shared@test.com');
			assert.ok(found);
			assert.strictEqual(found.username, 'user1');
		});

		test('rejects duplicate emails (case-insensitive)', async () => {
			const db = get_db();
			const deps = { db };
			await query_create_account(deps, {
				username: 'first',
				password_hash: 'hash',
				email: 'dupe@example.com'
			});
			const err = await assert_rejects(() =>
				query_create_account(deps, {
					username: 'second',
					password_hash: 'hash',
					email: 'DUPE@Example.COM'
				})
			);
			assert.ok(err.message.includes('unique') || err.message.includes('duplicate'));
		});

		test('rejects duplicate usernames', async () => {
			const db = get_db();
			const deps = { db };
			await query_create_account(deps, { username: 'heidi', password_hash: 'hash' });
			const err = await assert_rejects(() =>
				query_create_account(deps, { username: 'heidi', password_hash: 'hash2' })
			);
			assert.ok(err.message.includes('unique') || err.message.includes('duplicate'));
		});

		test('find_by_username is case-insensitive', async () => {
			const db = get_db();
			const deps = { db };
			await query_create_account(deps, { username: 'charlie', password_hash: 'hash' });
			const found = await query_account_by_username(deps, 'Charlie');
			assert.ok(found);
			assert.strictEqual(found.username, 'charlie');
		});

		test('rejects duplicate usernames (case-insensitive)', async () => {
			const db = get_db();
			const deps = { db };
			await query_create_account(deps, { username: 'heidi', password_hash: 'hash' });
			const err = await assert_rejects(() =>
				query_create_account(deps, { username: 'HEIDI', password_hash: 'hash2' })
			);
			assert.ok(err.message.includes('unique') || err.message.includes('duplicate'));
		});

		test('update_password with non-null updated_by sets the column', async () => {
			const db = get_db();
			const deps = { db };
			const account = await query_create_account(deps, {
				username: 'pw_actor',
				password_hash: 'old_hash'
			});
			const actor_account = await query_create_account(deps, {
				username: 'the_actor',
				password_hash: 'actor_hash'
			});
			await query_update_account_password(
				deps,
				account.id,
				'new_hash',
				actor_account.id,
				'old_hash'
			);
			const updated = await query_account_by_id(deps, account.id);
			assert.ok(updated);
			assert.strictEqual(updated.password_hash, 'new_hash');
			assert.strictEqual(updated.updated_by, actor_account.id);
		});

		// Skipped: query_account_by_username_or_email fallback from email to username
		// when input contains '@'. The Username schema regex
		// /^[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]$/ disallows '@' and '.',
		// so a username like 'user@name' cannot exist in the DB.
		// The email-to-username fallback path is unreachable for valid data.
	});

	describe('ActorQueries', () => {
		test('create returns an actor linked to the account', async () => {
			const db = get_db();
			const deps = { db };
			const account = await query_create_account(deps, {
				username: 'alice',
				password_hash: 'hash'
			});
			const actor = await query_create_actor(deps, account.id, 'alice');
			assert.ok(actor.id);
			assert.strictEqual(actor.account_id, account.id);
			assert.strictEqual(actor.name, 'alice');
		});

		test('find_by_id returns the actor', async () => {
			const db = get_db();
			const deps = { db };
			const account = await query_create_account(deps, {
				username: 'charlie',
				password_hash: 'hash'
			});
			const actor = await query_create_actor(deps, account.id, 'charlie');
			const found = await query_actor_by_id(deps, actor.id);
			assert.ok(found);
			assert.strictEqual(found.name, 'charlie');
		});

		test('actor is cascade deleted with account', async () => {
			const db = get_db();
			const deps = { db };
			const account = await query_create_account(deps, { username: 'dave', password_hash: 'hash' });
			const actor = await query_create_actor(deps, account.id, 'dave');
			await query_purge_account(deps, account.id);
			const found = await query_actor_by_id(deps, actor.id);
			assert.strictEqual(found, undefined);
		});
	});

	describe('create_account_with_actor', () => {
		test('creates both account and actor', async () => {
			const db = get_db();
			const deps = { db };
			const { account, actor } = await query_create_account_with_actor(deps, {
				username: 'alice',
				password_hash: 'hash'
			});
			assert.ok(account.id);
			assert.ok(actor.id);
			assert.strictEqual(actor.account_id, account.id);
			assert.strictEqual(actor.name, 'alice');
		});
	});

	// Rows written in one transaction share `created_at` (`NOW()` is the
	// transaction's start), so the listing's order rests on its tiebreak keys —
	// data keys (`username`, `name`, `role`), never the random `id` alone,
	// which differs between two backends holding the same rows. Each row's key
	// order is the reverse of its id and insertion order, so a tiebreak on
	// either shows. The keys are plain lowercase, so a bytewise and a locale
	// collation order them alike. The Rust spine's
	// `fuz_auth` `admin_lists` suite seeds the same rows and asserts the same
	// order.
	describe('query_admin_account_list ordering', () => {
		const ACCOUNT_1 = '00000000-0000-4000-8000-000000000001';
		const ACCOUNT_2 = '00000000-0000-4000-8000-000000000002';
		const ACTOR_1 = '00000000-0000-4000-8000-000000000011';
		const ACTOR_2 = '00000000-0000-4000-8000-000000000012';
		const GRANT_1 = '00000000-0000-4000-8000-000000000021';
		const GRANT_2 = '00000000-0000-4000-8000-000000000022';
		const GRANT_3 = '00000000-0000-4000-8000-000000000023';
		const OFFER_1 = '00000000-0000-4000-8000-000000000031';
		const OFFER_2 = '00000000-0000-4000-8000-000000000032';
		const OFFER_3 = '00000000-0000-4000-8000-000000000033';
		const SCOPE_1 = '00000000-0000-4000-8000-000000000041';
		const SCOPE_2 = '00000000-0000-4000-8000-000000000042';

		test('rows sharing created_at list by username, name and role', async () => {
			const db = get_db();
			await db.transaction(async (tx) => {
				await tx.query(
					`INSERT INTO account (id, username, password_hash) VALUES ($1, 'tie_b', 'x'), ($2, 'tie_a', 'x')`,
					[ACCOUNT_1, ACCOUNT_2]
				);
				await tx.query(
					`INSERT INTO actor (id, account_id, name) VALUES ($1, $3, 'second'), ($2, $3, 'first')`,
					[ACTOR_1, ACTOR_2, ACCOUNT_2]
				);
				await tx.query(
					`INSERT INTO role_grant (id, actor_id, role)
					 VALUES ($1, $4, 'role_c'), ($2, $4, 'role_b'), ($3, $4, 'role_a')`,
					[GRANT_1, GRANT_2, GRANT_3, ACTOR_2]
				);
				// one `expires_at`, so the offers order on `role`, then `scope_id`
				await tx.query(
					`INSERT INTO role_grant_offer (id, from_actor_id, to_account_id, role, scope_kind, scope_id, expires_at)
					 VALUES ($1, $4, $5, 'role_b', 'space', $7, $6),
					        ($2, $4, $5, 'role_b', 'space', $8, $6),
					        ($3, $4, $5, 'role_a', NULL, NULL, $6)`,
					[OFFER_1, OFFER_2, OFFER_3, ACTOR_1, ACCOUNT_2, '2999-01-01T00:00:00Z', SCOPE_2, SCOPE_1]
				);
			});
			const entries = await query_admin_account_list({ db });
			assert.deepStrictEqual(
				entries.map((e) => e.account.username),
				['tie_a', 'tie_b']
			);
			const [entry] = entries;
			assert.strictEqual(entry!.actor?.name, 'first', 'the oldest actor, by name on a tie');
			assert.deepStrictEqual(
				entry!.role_grants.map((g) => g.role),
				['role_a', 'role_b', 'role_c']
			);
			assert.deepStrictEqual(
				entry!.pending_offers.map((o) => o.id),
				[OFFER_3, OFFER_2, OFFER_1],
				'pending offers by role, then scope_id'
			);
		});
	});
});
