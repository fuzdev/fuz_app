/**
 * Tests for invite_queries.ts — invite CRUD and constraint enforcement.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {
	query_create_invite,
	query_invite_find_unclaimed_by_email,
	query_invite_find_unclaimed_by_username,
	query_invite_find_unclaimed_match,
	query_invite_claim,
	query_invite_list_all,
	query_invite_delete_unclaimed,
} from '$lib/auth/invite_queries.js';
import {query_create_account_with_actor} from '$lib/auth/account_queries.js';

import {describe_db} from '../db_fixture.js';

describe_db('InviteQueries', (get_db) => {
	describe('create', () => {
		test('creates invite with email only', async () => {
			const deps = {db: get_db()};
			const invite = await query_create_invite(deps, {
				email: 'alice@example.com',
				created_by: null,
			});
			assert.ok(invite.id);
			assert.strictEqual(invite.email, 'alice@example.com');
			assert.strictEqual(invite.username, null);
			assert.strictEqual(invite.claimed_by, null);
			assert.strictEqual(invite.claimed_at, null);
			assert.ok(invite.created_at);
			assert.strictEqual(invite.created_by, null);
		});

		test('creates invite with username only', async () => {
			const deps = {db: get_db()};
			const invite = await query_create_invite(deps, {username: 'bob', created_by: null});
			assert.strictEqual(invite.email, null);
			assert.strictEqual(invite.username, 'bob');
		});

		test('creates invite with both email and username', async () => {
			const deps = {db: get_db()};
			const invite = await query_create_invite(deps, {
				email: 'carol@example.com',
				username: 'carol',
				created_by: null,
			});
			assert.strictEqual(invite.email, 'carol@example.com');
			assert.strictEqual(invite.username, 'carol');
		});

		test('fails with CHECK constraint when both email and username are null', async () => {
			const deps = {db: get_db()};
			try {
				await query_create_invite(deps, {email: null, username: null, created_by: null});
				assert.fail('should have thrown on CHECK constraint violation');
			} catch (e: any) {
				assert.ok(
					e.message.includes('invite_has_identifier') || e.message.includes('check'),
					`unexpected error: ${e.message}`,
				);
			}
		});

		test('records created_by when provided', async () => {
			const db = get_db();
			const deps = {db};
			const {actor} = await query_create_account_with_actor(deps, {
				username: 'admin',
				password_hash: 'hash',
			});
			const invite = await query_create_invite(deps, {
				email: 'dave@example.com',
				created_by: actor.id,
			});
			assert.strictEqual(invite.created_by, actor.id);
		});
	});

	describe('find_unclaimed_by_email', () => {
		test('finds by email case-insensitively', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {email: 'Alice@Example.COM', created_by: null});
			const found = await query_invite_find_unclaimed_by_email(deps, 'alice@example.com');
			assert.ok(found);
			assert.strictEqual(found.email, 'Alice@Example.COM');
		});

		test('returns undefined when no match', async () => {
			const deps = {db: get_db()};
			const found = await query_invite_find_unclaimed_by_email(deps, 'nobody@example.com');
			assert.strictEqual(found, undefined);
		});

		test('returns undefined for claimed invites', async () => {
			const db = get_db();
			const deps = {db};
			const invite = await query_create_invite(deps, {
				email: 'claimed@example.com',
				created_by: null,
			});
			const {account} = await query_create_account_with_actor(deps, {
				username: 'claimer',
				password_hash: 'hash',
			});
			await query_invite_claim(deps, invite.id, account.id);
			const found = await query_invite_find_unclaimed_by_email(deps, 'claimed@example.com');
			assert.strictEqual(found, undefined);
		});
	});

	describe('find_unclaimed_by_username', () => {
		test('finds by username case-insensitively', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {username: 'Alice', created_by: null});
			const found = await query_invite_find_unclaimed_by_username(deps, 'alice');
			assert.ok(found);
			assert.strictEqual(found.username, 'Alice');
		});

		test('returns undefined when no match', async () => {
			const deps = {db: get_db()};
			const found = await query_invite_find_unclaimed_by_username(deps, 'nobody');
			assert.strictEqual(found, undefined);
		});

		test('returns undefined for claimed invites', async () => {
			const db = get_db();
			const deps = {db};
			const invite = await query_create_invite(deps, {username: 'taken', created_by: null});
			const {account} = await query_create_account_with_actor(deps, {
				username: 'claimer',
				password_hash: 'hash',
			});
			await query_invite_claim(deps, invite.id, account.id);
			const found = await query_invite_find_unclaimed_by_username(deps, 'taken');
			assert.strictEqual(found, undefined);
		});
	});

	describe('find_unclaimed_match', () => {
		test('email-only invite matches when signup provides matching email', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {email: 'match@example.com', created_by: null});
			const found = await query_invite_find_unclaimed_match(deps, 'match@example.com', 'anyuser');
			assert.ok(found);
			assert.strictEqual(found.email, 'match@example.com');
		});

		test('email-only invite does not match when signup provides only username', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {email: 'emailonly@example.com', created_by: null});
			const found = await query_invite_find_unclaimed_match(deps, null, 'emailonly');
			assert.strictEqual(found, undefined);
		});

		test('username-only invite matches on username', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {username: 'onlyuser', created_by: null});
			const found = await query_invite_find_unclaimed_match(deps, null, 'onlyuser');
			assert.ok(found);
			assert.strictEqual(found.username, 'onlyuser');
		});

		test('username-only invite does not match on email alone', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {username: 'useronly', created_by: null});
			// Signup provides email but the invite is username-only — should not match
			const found = await query_invite_find_unclaimed_match(
				deps,
				'useronly@example.com',
				'nomatch',
			);
			assert.strictEqual(found, undefined);
		});

		test('both-field invite matches when both match', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {
				email: 'both@example.com',
				username: 'bothuser',
				created_by: null,
			});
			const found = await query_invite_find_unclaimed_match(deps, 'both@example.com', 'bothuser');
			assert.ok(found);
			assert.strictEqual(found.email, 'both@example.com');
			assert.strictEqual(found.username, 'bothuser');
		});

		test('both-field invite rejects when only email matches', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {
				email: 'strict@example.com',
				username: 'strictuser',
				created_by: null,
			});
			const found = await query_invite_find_unclaimed_match(
				deps,
				'strict@example.com',
				'wronguser',
			);
			assert.strictEqual(found, undefined);
		});

		test('both-field invite rejects when only username matches', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {
				email: 'strict2@example.com',
				username: 'strictuser2',
				created_by: null,
			});
			const found = await query_invite_find_unclaimed_match(
				deps,
				'wrong@example.com',
				'strictuser2',
			);
			assert.strictEqual(found, undefined);
		});

		test('both-field invite rejects when signup has no email', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {
				email: 'need@example.com',
				username: 'needboth',
				created_by: null,
			});
			const found = await query_invite_find_unclaimed_match(deps, null, 'needboth');
			assert.strictEqual(found, undefined);
		});

		test('email-only invite matches case-insensitively', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {email: 'Alice@Example.COM', created_by: null});
			const found = await query_invite_find_unclaimed_match(deps, 'alice@example.com', 'anyuser');
			assert.ok(found);
			assert.strictEqual(found.email, 'Alice@Example.COM');
		});

		test('username-only invite matches case-insensitively', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {username: 'Alice', created_by: null});
			const found = await query_invite_find_unclaimed_match(deps, null, 'alice');
			assert.ok(found);
			assert.strictEqual(found.username, 'Alice');
		});

		test('username-only invite matches when signup also provides email', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {username: 'onlyuser2', created_by: null});
			const found = await query_invite_find_unclaimed_match(deps, 'extra@example.com', 'onlyuser2');
			assert.ok(found);
			assert.strictEqual(found.username, 'onlyuser2');
		});

		test('multiple matching invites of different types returns a match', async () => {
			const deps = {db: get_db()};
			// Create email-only invite
			const email_invite = await query_create_invite(deps, {
				email: 'multi@example.com',
				created_by: null,
			});
			// Create username-only invite
			const username_invite = await query_create_invite(deps, {
				username: 'multiuser',
				created_by: null,
			});
			// Signup provides both — both branches match, one is returned
			const found = await query_invite_find_unclaimed_match(deps, 'multi@example.com', 'multiuser');
			assert.ok(found);
			// Should return one of the two matching invites (ordered by created_at, id)
			const valid_ids = [email_invite.id, username_invite.id];
			assert.ok(
				valid_ids.includes(found.id),
				`expected one of ${valid_ids.join(', ')}, got ${found.id}`,
			);
		});

		test('both-field invite matches case-insensitively', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {
				email: 'Both@Example.COM',
				username: 'BothUser',
				created_by: null,
			});
			const found = await query_invite_find_unclaimed_match(deps, 'both@example.com', 'bothuser');
			assert.ok(found);
			assert.strictEqual(found.email, 'Both@Example.COM');
			assert.strictEqual(found.username, 'BothUser');
		});

		test('returns undefined when neither matches', async () => {
			const deps = {db: get_db()};
			const found = await query_invite_find_unclaimed_match(deps, 'no@match.com', 'nomatch');
			assert.strictEqual(found, undefined);
		});
	});

	describe('claim', () => {
		test('returns true and sets claimed_by and claimed_at', async () => {
			const db = get_db();
			const deps = {db};
			const invite = await query_create_invite(deps, {
				email: 'claim@example.com',
				created_by: null,
			});
			const {account} = await query_create_account_with_actor(deps, {
				username: 'claimer',
				password_hash: 'hash',
			});
			const result = await query_invite_claim(deps, invite.id, account.id);
			assert.strictEqual(result, true);

			const all = await query_invite_list_all(deps);
			const claimed = all.find((i) => i.id === invite.id);
			assert.ok(claimed);
			assert.strictEqual(claimed.claimed_by, account.id);
			assert.ok(claimed.claimed_at);
		});

		test('returns false when invite is already claimed', async () => {
			const db = get_db();
			const deps = {db};
			const invite = await query_create_invite(deps, {
				email: 'double@example.com',
				created_by: null,
			});
			const {account: first} = await query_create_account_with_actor(deps, {
				username: 'first',
				password_hash: 'hash',
			});
			const {account: second} = await query_create_account_with_actor(deps, {
				username: 'second',
				password_hash: 'hash',
			});
			assert.strictEqual(await query_invite_claim(deps, invite.id, first.id), true);
			assert.strictEqual(await query_invite_claim(deps, invite.id, second.id), false);
			// verify original claimer is preserved
			const all = await query_invite_list_all(deps);
			const claimed = all.find((i) => i.id === invite.id);
			assert.ok(claimed);
			assert.strictEqual(claimed.claimed_by, first.id, 'original claimer should be preserved');
		});

		test('returns false for nonexistent invite', async () => {
			const db = get_db();
			const deps = {db};
			const {account} = await query_create_account_with_actor(deps, {
				username: 'claimer',
				password_hash: 'hash',
			});
			const result = await query_invite_claim(
				deps,
				'00000000-0000-4000-8000-000000000099',
				account.id,
			);
			assert.strictEqual(result, false);
		});

		test('claimed invite is no longer found by find_unclaimed_by_email', async () => {
			const db = get_db();
			const deps = {db};
			const invite = await query_create_invite(deps, {email: 'gone@example.com', created_by: null});
			const {account} = await query_create_account_with_actor(deps, {
				username: 'claimer',
				password_hash: 'hash',
			});
			await query_invite_claim(deps, invite.id, account.id);
			assert.strictEqual(
				await query_invite_find_unclaimed_by_email(deps, 'gone@example.com'),
				undefined,
			);
		});
	});

	describe('list_all', () => {
		test('returns empty array when no invites', async () => {
			const deps = {db: get_db()};
			const all = await query_invite_list_all(deps);
			assert.strictEqual(all.length, 0);
		});

		test('returns all invites', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {email: 'first@example.com', created_by: null});
			await query_create_invite(deps, {email: 'second@example.com', created_by: null});
			const all = await query_invite_list_all(deps);
			assert.strictEqual(all.length, 2);
			const emails = new Set(all.map((i) => i.email));
			assert.ok(emails.has('first@example.com'));
			assert.ok(emails.has('second@example.com'));
		});
	});

	describe('delete_unclaimed', () => {
		test('deletes an unclaimed invite', async () => {
			const deps = {db: get_db()};
			const invite = await query_create_invite(deps, {
				email: 'delete@example.com',
				created_by: null,
			});
			const deleted = await query_invite_delete_unclaimed(deps, invite.id);
			assert.strictEqual(deleted, true);
			const all = await query_invite_list_all(deps);
			assert.strictEqual(all.length, 0);
		});

		test('returns false for nonexistent id', async () => {
			const deps = {db: get_db()};
			const deleted = await query_invite_delete_unclaimed(
				deps,
				'00000000-0000-0000-0000-000000000099',
			);
			assert.strictEqual(deleted, false);
		});

		test('returns false for already-claimed invite', async () => {
			const db = get_db();
			const deps = {db};
			const invite = await query_create_invite(deps, {
				email: 'nodelete@example.com',
				created_by: null,
			});
			const {account} = await query_create_account_with_actor(deps, {
				username: 'claimer',
				password_hash: 'hash',
			});
			await query_invite_claim(deps, invite.id, account.id);
			const deleted = await query_invite_delete_unclaimed(deps, invite.id);
			assert.strictEqual(deleted, false);
			// invite still exists
			const all = await query_invite_list_all(deps);
			assert.strictEqual(all.length, 1);
		});
	});

	describe('unique partial indexes', () => {
		test('rejects duplicate unclaimed email (case-insensitive)', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {email: 'unique@example.com', created_by: null});
			try {
				await query_create_invite(deps, {email: 'UNIQUE@Example.COM', created_by: null});
				assert.fail('should have thrown on duplicate unclaimed email');
			} catch (e: any) {
				assert.ok(e.message.includes('unique') || e.message.includes('duplicate'));
			}
		});

		test('allows same email after first is claimed', async () => {
			const db = get_db();
			const deps = {db};
			const first = await query_create_invite(deps, {email: 'reuse@example.com', created_by: null});
			const {account} = await query_create_account_with_actor(deps, {
				username: 'claimer',
				password_hash: 'hash',
			});
			await query_invite_claim(deps, first.id, account.id);
			const second = await query_create_invite(deps, {
				email: 'reuse@example.com',
				created_by: null,
			});
			assert.ok(second.id);
			assert.notStrictEqual(second.id, first.id);
		});

		test('rejects duplicate unclaimed username (case-insensitive)', async () => {
			const deps = {db: get_db()};
			await query_create_invite(deps, {username: 'dupuser', created_by: null});
			try {
				await query_create_invite(deps, {username: 'DUPUSER', created_by: null});
				assert.fail('should have thrown on duplicate unclaimed username');
			} catch (e: any) {
				assert.ok(e.message.includes('unique') || e.message.includes('duplicate'));
			}
		});

		test('allows same username after first is claimed', async () => {
			const db = get_db();
			const deps = {db};
			const first = await query_create_invite(deps, {username: 'reuseuser', created_by: null});
			const {account} = await query_create_account_with_actor(deps, {
				username: 'claimer',
				password_hash: 'hash',
			});
			await query_invite_claim(deps, first.id, account.id);
			const second = await query_create_invite(deps, {username: 'reuseuser', created_by: null});
			assert.ok(second.id);
			assert.notStrictEqual(second.id, first.id);
		});
	});
});
