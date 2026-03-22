/**
 * Tests for account_schema.ts - Auth table creation and types.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {to_session_account, type Account} from '$lib/auth/account_schema.js';
import {run_migrations} from '$lib/db/migrate.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';

import {describe_db} from '../db_fixture.js';

describe_db('auth schema', (get_db) => {
	test('creates all auth tables', async () => {
		const db = get_db();
		const tables = await db.query<{tablename: string}>(
			`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
		);
		const names = tables.map((t) => t.tablename);
		assert.ok(names.includes('account'), 'account table exists');
		assert.ok(names.includes('actor'), 'actor table exists');
		assert.ok(names.includes('permit'), 'permit table exists');
		assert.ok(names.includes('auth_session'), 'auth_session table exists');
		assert.ok(names.includes('api_token'), 'api_token table exists');
		assert.ok(names.includes('audit_log'), 'audit_log table exists');
		assert.ok(names.includes('schema_version'), 'schema_version table exists');
	});

	test('migrations are idempotent', async () => {
		const db = get_db();
		// run again — should not throw, no-ops since version is current
		const results = await run_migrations(db, [AUTH_MIGRATION_NS]);
		assert.strictEqual(results.length, 0);
	});

	test('account table has correct columns', async () => {
		const db = get_db();
		const cols = await db.query<{column_name: string}>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'account' ORDER BY ordinal_position`,
		);
		const names = cols.map((c) => c.column_name);
		assert.deepStrictEqual(names, [
			'id',
			'username',
			'email',
			'email_verified',
			'password_hash',
			'created_at',
			'created_by',
			'updated_at',
			'updated_by',
		]);
	});

	test('actor table has correct columns', async () => {
		const db = get_db();
		const cols = await db.query<{column_name: string}>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'actor' ORDER BY ordinal_position`,
		);
		const names = cols.map((c) => c.column_name);
		assert.deepStrictEqual(names, [
			'id',
			'account_id',
			'name',
			'created_at',
			'updated_at',
			'updated_by',
		]);
	});

	test('permit table has correct columns', async () => {
		const db = get_db();
		const cols = await db.query<{column_name: string}>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'permit' ORDER BY ordinal_position`,
		);
		const names = cols.map((c) => c.column_name);
		assert.deepStrictEqual(names, [
			'id',
			'actor_id',
			'role',
			'created_at',
			'expires_at',
			'revoked_at',
			'revoked_by',
			'granted_by',
		]);
	});

	test('auth_session table has correct columns', async () => {
		const db = get_db();
		const cols = await db.query<{column_name: string}>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_session' ORDER BY ordinal_position`,
		);
		const names = cols.map((c) => c.column_name);
		assert.deepStrictEqual(names, ['id', 'account_id', 'created_at', 'expires_at', 'last_seen_at']);
	});

	test('api_token table has correct columns', async () => {
		const db = get_db();
		const cols = await db.query<{column_name: string}>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'api_token' ORDER BY ordinal_position`,
		);
		const names = cols.map((c) => c.column_name);
		assert.deepStrictEqual(names, [
			'id',
			'account_id',
			'name',
			'token_hash',
			'expires_at',
			'last_used_at',
			'last_used_ip',
			'created_at',
		]);
	});

	test('username uniqueness enforced', async () => {
		const db = get_db();
		await db.query(`INSERT INTO account (username, password_hash) VALUES ($1, $2)`, [
			'alice',
			'hash1',
		]);
		try {
			await db.query(`INSERT INTO account (username, password_hash) VALUES ($1, $2)`, [
				'alice',
				'hash2',
			]);
			assert.fail('should have thrown on duplicate username');
		} catch (e: any) {
			assert.ok(e.message.includes('unique') || e.message.includes('duplicate'));
		}
	});

	test('actor cascade deletes on account deletion', async () => {
		const db = get_db();
		await db.query(`INSERT INTO account (id, username, password_hash) VALUES ($1, $2, $3)`, [
			'00000000-0000-0000-0000-000000000001',
			'alice',
			'hash',
		]);
		await db.query(`INSERT INTO actor (account_id, name) VALUES ($1, $2)`, [
			'00000000-0000-0000-0000-000000000001',
			'alice',
		]);
		await db.query(`DELETE FROM account WHERE id = $1`, ['00000000-0000-0000-0000-000000000001']);
		const actors = await db.query(`SELECT * FROM actor WHERE account_id = $1`, [
			'00000000-0000-0000-0000-000000000001',
		]);
		assert.strictEqual(actors.length, 0);
	});
});

describe('to_session_account', () => {
	test('strips sensitive and audit fields', () => {
		const account: Account = {
			id: 'abc',
			username: 'alice',
			email: 'alice@example.com',
			email_verified: false,
			password_hash: '$argon2id$secret',
			created_at: '2024-01-01',
			created_by: null,
			updated_at: '2024-01-02',
			updated_by: null,
		};
		const client = to_session_account(account);
		assert.deepStrictEqual(client, {
			id: 'abc',
			username: 'alice',
			email: 'alice@example.com',
			email_verified: false,
			created_at: '2024-01-01',
		});
		assert.strictEqual('password_hash' in client, false);
		assert.strictEqual('updated_at' in client, false);
	});
});
