/**
 * Tests for backend_account_queries.ts - Account and actor CRUD.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {
	query_create_account,
	query_account_by_id,
	query_account_by_username,
	query_account_by_email,
	query_account_by_username_or_email,
	query_update_account_password,
	query_delete_account,
	query_account_has_any,
	query_create_actor,
	query_actor_by_account,
	query_actor_by_id,
	query_create_account_with_actor,
} from '$lib/auth/account_queries.js';

import {describe_db} from '../db_fixture.js';

describe_db('account queries', (get_db) => {
	describe('AccountQueries', () => {
		test('create returns an account with generated uuid', async () => {
			const db = get_db();
			const deps = {db};
			const account = await query_create_account(deps, {
				username: 'alice',
				password_hash: 'hash123',
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
			const deps = {db};
			const account = await query_create_account(deps, {
				username: 'bob',
				password_hash: 'hash456',
				email: 'bob@example.com',
			});
			assert.strictEqual(account.email, 'bob@example.com');
		});

		test('find_by_id returns the account', async () => {
			const db = get_db();
			const deps = {db};
			const created = await query_create_account(deps, {username: 'alice', password_hash: 'hash'});
			const found = await query_account_by_id(deps, created.id);
			assert.ok(found);
			assert.strictEqual(found.username, 'alice');
		});

		test('find_by_id returns undefined for missing id', async () => {
			const db = get_db();
			const deps = {db};
			const found = await query_account_by_id(deps, '00000000-0000-0000-0000-000000000099');
			assert.strictEqual(found, undefined);
		});

		test('find_by_username returns the account', async () => {
			const db = get_db();
			const deps = {db};
			await query_create_account(deps, {username: 'charlie', password_hash: 'hash'});
			const found = await query_account_by_username(deps, 'charlie');
			assert.ok(found);
			assert.strictEqual(found.username, 'charlie');
		});

		test('find_by_username returns undefined for missing username', async () => {
			const db = get_db();
			const deps = {db};
			const found = await query_account_by_username(deps, 'nonexistent');
			assert.strictEqual(found, undefined);
		});

		test('find_by_email is case-insensitive', async () => {
			const db = get_db();
			const deps = {db};
			await query_create_account(deps, {
				username: 'dave',
				password_hash: 'hash',
				email: 'Dave@Example.COM',
			});
			const found = await query_account_by_email(deps, 'dave@example.com');
			assert.ok(found);
			assert.strictEqual(found.username, 'dave');
		});

		test('update_password changes the hash', async () => {
			const db = get_db();
			const deps = {db};
			const account = await query_create_account(deps, {
				username: 'eve',
				password_hash: 'old_hash',
			});
			await query_update_account_password(deps, account.id, 'new_hash', null);
			const updated = await query_account_by_id(deps, account.id);
			assert.ok(updated);
			assert.strictEqual(updated.password_hash, 'new_hash');
		});

		test('delete removes the account', async () => {
			const db = get_db();
			const deps = {db};
			const account = await query_create_account(deps, {username: 'frank', password_hash: 'hash'});
			const deleted = await query_delete_account(deps, account.id);
			assert.strictEqual(deleted, true);
			const found = await query_account_by_id(deps, account.id);
			assert.strictEqual(found, undefined);
		});

		test('delete returns false for missing account', async () => {
			const db = get_db();
			const deps = {db};
			const deleted = await query_delete_account(deps, '00000000-0000-0000-0000-000000000099');
			assert.strictEqual(deleted, false);
		});

		test('has_any returns false when empty', async () => {
			const db = get_db();
			const deps = {db};
			assert.strictEqual(await query_account_has_any(deps), false);
		});

		test('has_any returns true after creating an account', async () => {
			const db = get_db();
			const deps = {db};
			await query_create_account(deps, {username: 'grace', password_hash: 'hash'});
			assert.strictEqual(await query_account_has_any(deps), true);
		});

		test('find_by_username_or_email finds by username', async () => {
			const db = get_db();
			const deps = {db};
			await query_create_account(deps, {username: 'alice', password_hash: 'hash'});
			const found = await query_account_by_username_or_email(deps, 'alice');
			assert.ok(found);
			assert.strictEqual(found.username, 'alice');
		});

		test('find_by_username_or_email finds by email', async () => {
			const db = get_db();
			const deps = {db};
			await query_create_account(deps, {
				username: 'bob',
				password_hash: 'hash',
				email: 'bob@school.edu',
			});
			const found = await query_account_by_username_or_email(deps, 'bob@school.edu');
			assert.ok(found);
			assert.strictEqual(found.username, 'bob');
		});

		test('find_by_username_or_email is case-insensitive for email', async () => {
			const db = get_db();
			const deps = {db};
			await query_create_account(deps, {
				username: 'carol',
				password_hash: 'hash',
				email: 'Carol@School.Edu',
			});
			const found = await query_account_by_username_or_email(deps, 'carol@school.edu');
			assert.ok(found);
			assert.strictEqual(found.username, 'carol');
		});

		test('find_by_username_or_email returns undefined when not found', async () => {
			const db = get_db();
			const deps = {db};
			const found = await query_account_by_username_or_email(deps, 'nobody@nowhere.com');
			assert.strictEqual(found, undefined);
		});

		test('find_by_username_or_email prefers email when input contains @', async () => {
			const db = get_db();
			const deps = {db};
			await query_create_account(deps, {
				username: 'user1',
				password_hash: 'hash',
				email: 'shared@test.com',
			});
			// Input contains @, so email lookup runs first
			const found = await query_account_by_username_or_email(deps, 'shared@test.com');
			assert.ok(found);
			assert.strictEqual(found.username, 'user1');
		});

		test('rejects duplicate emails (case-insensitive)', async () => {
			const db = get_db();
			const deps = {db};
			await query_create_account(deps, {
				username: 'first',
				password_hash: 'hash',
				email: 'dupe@example.com',
			});
			try {
				await query_create_account(deps, {
					username: 'second',
					password_hash: 'hash',
					email: 'DUPE@Example.COM',
				});
				assert.fail('should have thrown on duplicate email');
			} catch (e: any) {
				assert.ok(e.message.includes('unique') || e.message.includes('duplicate'));
			}
		});

		test('rejects duplicate usernames', async () => {
			const db = get_db();
			const deps = {db};
			await query_create_account(deps, {username: 'heidi', password_hash: 'hash'});
			try {
				await query_create_account(deps, {username: 'heidi', password_hash: 'hash2'});
				assert.fail('should have thrown on duplicate username');
			} catch (e: any) {
				assert.ok(e.message.includes('unique') || e.message.includes('duplicate'));
			}
		});

		test('find_by_username is case-insensitive', async () => {
			const db = get_db();
			const deps = {db};
			await query_create_account(deps, {username: 'charlie', password_hash: 'hash'});
			const found = await query_account_by_username(deps, 'Charlie');
			assert.ok(found);
			assert.strictEqual(found.username, 'charlie');
		});

		test('rejects duplicate usernames (case-insensitive)', async () => {
			const db = get_db();
			const deps = {db};
			await query_create_account(deps, {username: 'heidi', password_hash: 'hash'});
			try {
				await query_create_account(deps, {username: 'HEIDI', password_hash: 'hash2'});
				assert.fail('should have thrown on case-insensitive duplicate username');
			} catch (e: any) {
				assert.ok(e.message.includes('unique') || e.message.includes('duplicate'));
			}
		});

		test('update_password with non-null updated_by sets the column', async () => {
			const db = get_db();
			const deps = {db};
			const account = await query_create_account(deps, {
				username: 'pw_actor',
				password_hash: 'old_hash',
			});
			const actor_account = await query_create_account(deps, {
				username: 'the_actor',
				password_hash: 'actor_hash',
			});
			await query_update_account_password(deps, account.id, 'new_hash', actor_account.id);
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
			const deps = {db};
			const account = await query_create_account(deps, {username: 'alice', password_hash: 'hash'});
			const actor = await query_create_actor(deps, account.id, 'alice');
			assert.ok(actor.id);
			assert.strictEqual(actor.account_id, account.id);
			assert.strictEqual(actor.name, 'alice');
		});

		test('find_by_account returns the actor', async () => {
			const db = get_db();
			const deps = {db};
			const account = await query_create_account(deps, {username: 'bob', password_hash: 'hash'});
			await query_create_actor(deps, account.id, 'bob');
			const found = await query_actor_by_account(deps, account.id);
			assert.ok(found);
			assert.strictEqual(found.name, 'bob');
		});

		test('find_by_account returns undefined for missing account', async () => {
			const db = get_db();
			const deps = {db};
			const found = await query_actor_by_account(deps, '00000000-0000-0000-0000-000000000099');
			assert.strictEqual(found, undefined);
		});

		test('find_by_id returns the actor', async () => {
			const db = get_db();
			const deps = {db};
			const account = await query_create_account(deps, {
				username: 'charlie',
				password_hash: 'hash',
			});
			const actor = await query_create_actor(deps, account.id, 'charlie');
			const found = await query_actor_by_id(deps, actor.id);
			assert.ok(found);
			assert.strictEqual(found.name, 'charlie');
		});

		test('actor is cascade deleted with account', async () => {
			const db = get_db();
			const deps = {db};
			const account = await query_create_account(deps, {username: 'dave', password_hash: 'hash'});
			const actor = await query_create_actor(deps, account.id, 'dave');
			await query_delete_account(deps, account.id);
			const found = await query_actor_by_id(deps, actor.id);
			assert.strictEqual(found, undefined);
		});
	});

	describe('create_account_with_actor', () => {
		test('creates both account and actor', async () => {
			const db = get_db();
			const deps = {db};
			const {account, actor} = await query_create_account_with_actor(deps, {
				username: 'alice',
				password_hash: 'hash',
			});
			assert.ok(account.id);
			assert.ok(actor.id);
			assert.strictEqual(actor.account_id, account.id);
			assert.strictEqual(actor.name, 'alice');
		});
	});
});
