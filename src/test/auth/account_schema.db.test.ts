/**
 * Tests for account_schema.ts - Auth table creation and types.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';

import {to_session_account, type Account} from '$lib/auth/account_schema.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import {run_migrations} from '$lib/db/migrate.js';
import {auth_migration_ns} from '$lib/auth/migrations.js';

import {describe_db} from '../db_fixture.js';

interface ColumnRow {
	column_name: string;
	data_type: string;
	is_nullable: string;
}

describe_db('auth schema', (get_db) => {
	test('creates all auth tables', async () => {
		const db = get_db();
		const tables = await db.query<{tablename: string}>(
			`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
		);
		const names = tables.map((t) => t.tablename);
		assert.ok(names.includes('account'), 'account table exists');
		assert.ok(names.includes('actor'), 'actor table exists');
		assert.ok(names.includes('role_grant'), 'role_grant table exists');
		assert.ok(names.includes('auth_session'), 'auth_session table exists');
		assert.ok(names.includes('api_token'), 'api_token table exists');
		assert.ok(names.includes('audit_log'), 'audit_log table exists');
		assert.ok(names.includes('schema_version'), 'schema_version table exists');
	});

	test('migrations are idempotent', async () => {
		const db = get_db();
		// run again — should not throw, no-ops since version is current
		const results = await run_migrations(db, [auth_migration_ns]);
		assert.strictEqual(results.length, 0);
	});

	test('account table has correct columns', async () => {
		const db = get_db();
		const cols = await db.query<ColumnRow>(
			`SELECT column_name, data_type, is_nullable
			   FROM information_schema.columns
			  WHERE table_name = 'account'
			  ORDER BY ordinal_position`,
		);
		assert.deepStrictEqual(cols, [
			{column_name: 'id', data_type: 'uuid', is_nullable: 'NO'},
			{column_name: 'username', data_type: 'text', is_nullable: 'NO'},
			{column_name: 'email', data_type: 'text', is_nullable: 'YES'},
			{column_name: 'email_verified', data_type: 'boolean', is_nullable: 'NO'},
			{column_name: 'password_hash', data_type: 'text', is_nullable: 'NO'},
			{column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO'},
			{column_name: 'created_by', data_type: 'uuid', is_nullable: 'YES'},
			{column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO'},
			{column_name: 'updated_by', data_type: 'uuid', is_nullable: 'YES'},
			{column_name: 'deleted_at', data_type: 'timestamp with time zone', is_nullable: 'YES'},
			{column_name: 'deleted_by', data_type: 'uuid', is_nullable: 'YES'},
		]);
	});

	test('actor table has correct columns', async () => {
		const db = get_db();
		const cols = await db.query<ColumnRow>(
			`SELECT column_name, data_type, is_nullable
			   FROM information_schema.columns
			  WHERE table_name = 'actor'
			  ORDER BY ordinal_position`,
		);
		assert.deepStrictEqual(cols, [
			{column_name: 'id', data_type: 'uuid', is_nullable: 'NO'},
			{column_name: 'account_id', data_type: 'uuid', is_nullable: 'NO'},
			{column_name: 'name', data_type: 'text', is_nullable: 'NO'},
			{column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO'},
			{column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'YES'},
			{column_name: 'updated_by', data_type: 'uuid', is_nullable: 'YES'},
			{column_name: 'deleted_at', data_type: 'timestamp with time zone', is_nullable: 'YES'},
			{column_name: 'deleted_by', data_type: 'uuid', is_nullable: 'YES'},
		]);
	});

	test('role_grant_scope_kind_paired CHECK rejects mismatched (scope_kind, scope_id) pair', async () => {
		// Both null = global, both non-null = scoped, mismatch is a CHECK
		// violation. Direct INSERTs (bypassing the query helpers) so the DB
		// layer is the thing under test.
		const db = get_db();
		const account_rows = await db.query<{id: Uuid}>(
			`INSERT INTO account (username, password_hash) VALUES ('paired_check', 'h') RETURNING id`,
		);
		const account_id = account_rows[0]!.id;
		const actor_rows = await db.query<{id: Uuid}>(
			`INSERT INTO actor (account_id, name) VALUES ($1, 'paired') RETURNING id`,
			[account_id],
		);
		const actor_id = actor_rows[0]!.id;
		// Mismatch: scope_kind set, scope_id null.
		await assert_rejects(
			() =>
				db.query(
					`INSERT INTO role_grant (actor_id, role, scope_kind, scope_id) VALUES ($1, 'admin', 'classroom', NULL)`,
					[actor_id],
				),
			/role_grant_scope_kind_paired/,
		);
		// Mismatch: scope_id set, scope_kind null.
		await assert_rejects(
			() =>
				db.query(
					`INSERT INTO role_grant (actor_id, role, scope_kind, scope_id) VALUES ($1, 'admin', NULL, gen_random_uuid())`,
					[actor_id],
				),
			/role_grant_scope_kind_paired/,
		);
		// Both null (global) and both non-null (scoped) succeed.
		await db.query(
			`INSERT INTO role_grant (actor_id, role, scope_kind, scope_id) VALUES ($1, 'admin', NULL, NULL)`,
			[actor_id],
		);
		await db.query(
			`INSERT INTO role_grant (actor_id, role, scope_kind, scope_id) VALUES ($1, 'teacher', 'classroom', gen_random_uuid())`,
			[actor_id],
		);
	});

	test('role_grant table has correct columns', async () => {
		const db = get_db();
		const cols = await db.query<ColumnRow>(
			`SELECT column_name, data_type, is_nullable
			   FROM information_schema.columns
			  WHERE table_name = 'role_grant'
			  ORDER BY ordinal_position`,
		);
		assert.deepStrictEqual(cols, [
			{column_name: 'id', data_type: 'uuid', is_nullable: 'NO'},
			{column_name: 'actor_id', data_type: 'uuid', is_nullable: 'NO'},
			{column_name: 'role', data_type: 'text', is_nullable: 'NO'},
			{column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO'},
			{column_name: 'expires_at', data_type: 'timestamp with time zone', is_nullable: 'YES'},
			{column_name: 'revoked_at', data_type: 'timestamp with time zone', is_nullable: 'YES'},
			{column_name: 'revoked_by', data_type: 'uuid', is_nullable: 'YES'},
			{column_name: 'granted_by', data_type: 'uuid', is_nullable: 'YES'},
			{column_name: 'scope_id', data_type: 'uuid', is_nullable: 'YES'},
			{column_name: 'scope_kind', data_type: 'text', is_nullable: 'YES'},
			{column_name: 'source_offer_id', data_type: 'uuid', is_nullable: 'YES'},
			{column_name: 'revoked_reason', data_type: 'text', is_nullable: 'YES'},
		]);
	});

	test('auth_session table has correct columns', async () => {
		const db = get_db();
		const cols = await db.query<ColumnRow>(
			`SELECT column_name, data_type, is_nullable
			   FROM information_schema.columns
			  WHERE table_name = 'auth_session'
			  ORDER BY ordinal_position`,
		);
		assert.deepStrictEqual(cols, [
			{column_name: 'id', data_type: 'text', is_nullable: 'NO'},
			{column_name: 'account_id', data_type: 'uuid', is_nullable: 'NO'},
			{column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO'},
			{column_name: 'expires_at', data_type: 'timestamp with time zone', is_nullable: 'NO'},
			{column_name: 'last_seen_at', data_type: 'timestamp with time zone', is_nullable: 'NO'},
		]);
	});

	test('api_token table has correct columns', async () => {
		const db = get_db();
		const cols = await db.query<ColumnRow>(
			`SELECT column_name, data_type, is_nullable
			   FROM information_schema.columns
			  WHERE table_name = 'api_token'
			  ORDER BY ordinal_position`,
		);
		assert.deepStrictEqual(cols, [
			{column_name: 'id', data_type: 'text', is_nullable: 'NO'},
			{column_name: 'account_id', data_type: 'uuid', is_nullable: 'NO'},
			{column_name: 'name', data_type: 'text', is_nullable: 'NO'},
			{column_name: 'token_hash', data_type: 'text', is_nullable: 'NO'},
			{column_name: 'expires_at', data_type: 'timestamp with time zone', is_nullable: 'YES'},
			{column_name: 'last_used_at', data_type: 'timestamp with time zone', is_nullable: 'YES'},
			{column_name: 'last_used_ip', data_type: 'text', is_nullable: 'YES'},
			{column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO'},
		]);
	});

	test('username uniqueness enforced', async () => {
		const db = get_db();
		await db.query(`INSERT INTO account (username, password_hash) VALUES ($1, $2)`, [
			'alice',
			'hash1',
		]);
		const err = await assert_rejects(() =>
			db.query(`INSERT INTO account (username, password_hash) VALUES ($1, $2)`, ['alice', 'hash2']),
		);
		assert.ok(err.message.includes('unique') || err.message.includes('duplicate'));
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

	// Non-PK indexes — every named CREATE INDEX in `auth/auth_ddl.ts`,
	// `auth/audit_log_ddl.ts`, and `auth/role_grant_offer_ddl.ts`. Drift here
	// means a migration changed an index name or dropped one without updating
	// this test.
	test('expected non-PK indexes are present', async () => {
		const db = get_db();
		const rows = await db.query<{tablename: string; indexname: string}>(
			`SELECT tablename, indexname
			   FROM pg_indexes
			  WHERE schemaname = 'public'
			    AND indexname NOT LIKE '%_pkey'
			  ORDER BY tablename, indexname`,
		);
		const found = new Set(rows.map((r) => `${r.tablename}.${r.indexname}`));
		const expected = [
			'account.idx_account_email',
			'account.idx_account_username_ci',
			// account.username UNIQUE constraint creates an implicit unique index
			'account.account_username_key',
			'actor.idx_actor_account',
			'role_grant.idx_role_grant_actor',
			'role_grant.role_grant_actor_role_scope_active_unique',
			'role_grant.role_grant_scope_active',
			'auth_session.idx_auth_session_account',
			'auth_session.idx_auth_session_expires',
			'api_token.idx_api_token_account',
			'audit_log.idx_audit_log_seq',
			'audit_log.idx_audit_log_account',
			'audit_log.idx_audit_log_event_type',
			'audit_log.idx_audit_log_target_account',
			'audit_log.idx_audit_log_target_actor',
			'invite.idx_invite_email_unclaimed',
			'invite.idx_invite_username_unclaimed',
			'invite.idx_invite_claimed',
			'role_grant_offer.role_grant_offer_pending_unique',
			'role_grant_offer.role_grant_offer_inbox',
		];
		const missing = expected.filter((name) => !found.has(name));
		assert.deepStrictEqual(missing, [], `missing indexes: ${missing.join(', ')}`);
	});

	// FK delete-rule inventory. CASCADE vs SET NULL is load-bearing.
	// `audit_log`'s four identity columns deliberately carry NO FK (plain
	// UUID) — an append-only log isn't a live relational entity, and a hard
	// purge must leave the raw id intact rather than nulling the attribution
	// (delete = soft, purge = hard).
	// Drift here is a forensic-trail regression.
	test('foreign keys have expected delete rules', async () => {
		const db = get_db();
		const rows = await db.query<{
			table_name: string;
			column_name: string;
			foreign_table_name: string;
			foreign_column_name: string;
			delete_rule: string;
		}>(
			`SELECT tc.table_name, kcu.column_name,
			        ccu.table_name AS foreign_table_name,
			        ccu.column_name AS foreign_column_name,
			        rc.delete_rule
			   FROM information_schema.table_constraints tc
			   JOIN information_schema.key_column_usage kcu
			     ON tc.constraint_name = kcu.constraint_name
			    AND tc.table_schema = kcu.table_schema
			   JOIN information_schema.referential_constraints rc
			     ON tc.constraint_name = rc.constraint_name
			   JOIN information_schema.constraint_column_usage ccu
			     ON ccu.constraint_name = tc.constraint_name
			  WHERE tc.constraint_type = 'FOREIGN KEY'
			    AND tc.table_schema = 'public'
			  ORDER BY tc.table_name, kcu.column_name`,
		);
		const fks = rows.map((r) => ({
			table: r.table_name,
			column: r.column_name,
			references: `${r.foreign_table_name}.${r.foreign_column_name}`,
			on_delete: r.delete_rule,
		}));
		assert.deepStrictEqual(fks, [
			{table: 'actor', column: 'account_id', references: 'account.id', on_delete: 'CASCADE'},
			{table: 'actor', column: 'deleted_by', references: 'actor.id', on_delete: 'SET NULL'},
			{table: 'actor', column: 'updated_by', references: 'actor.id', on_delete: 'SET NULL'},
			{table: 'api_token', column: 'account_id', references: 'account.id', on_delete: 'CASCADE'},
			// audit_log identity columns (account_id / actor_id / target_*) carry
			// NO FK by design — see the comment above this test.
			{
				table: 'auth_session',
				column: 'account_id',
				references: 'account.id',
				on_delete: 'CASCADE',
			},
			{table: 'invite', column: 'claimed_by', references: 'account.id', on_delete: 'SET NULL'},
			{table: 'invite', column: 'created_by', references: 'actor.id', on_delete: 'SET NULL'},
			{table: 'role_grant', column: 'actor_id', references: 'actor.id', on_delete: 'CASCADE'},
			{table: 'role_grant', column: 'granted_by', references: 'actor.id', on_delete: 'SET NULL'},
			{table: 'role_grant', column: 'revoked_by', references: 'actor.id', on_delete: 'SET NULL'},
			{
				table: 'role_grant',
				column: 'source_offer_id',
				references: 'role_grant_offer.id',
				on_delete: 'SET NULL',
			},
			{
				table: 'role_grant_offer',
				column: 'from_actor_id',
				references: 'actor.id',
				on_delete: 'CASCADE',
			},
			{
				table: 'role_grant_offer',
				column: 'resulting_role_grant_id',
				references: 'role_grant.id',
				on_delete: 'SET NULL',
			},
			{
				table: 'role_grant_offer',
				column: 'to_account_id',
				references: 'account.id',
				on_delete: 'CASCADE',
			},
			{
				table: 'role_grant_offer',
				column: 'to_actor_id',
				references: 'actor.id',
				on_delete: 'CASCADE',
			},
		]);
	});

	// Load-bearing column defaults — checked via regex/inclusion to tolerate
	// minor cross-version rendering differences in `column_default` (e.g.
	// `NOW()` vs `now()`, `'success'` vs `'success'::text`). Exact-string
	// snapshots would surface as flaky on PGlite version bumps.
	test('key column defaults match expected patterns', async () => {
		const db = get_db();
		const rows = await db.query<{table_name: string; column_name: string; column_default: string}>(
			`SELECT table_name, column_name, column_default
			   FROM information_schema.columns
			  WHERE table_schema = 'public'
			    AND column_default IS NOT NULL`,
		);
		const defaults = new Map<string, string>();
		for (const r of rows) defaults.set(`${r.table_name}.${r.column_name}`, r.column_default);

		const get = (key: string): string => {
			const v = defaults.get(key);
			assert.ok(v != null, `expected default for ${key}, got none`);
			return v;
		};

		// UUID PKs default to gen_random_uuid()
		for (const key of [
			'account.id',
			'actor.id',
			'role_grant.id',
			'role_grant_offer.id',
			'audit_log.id',
			'invite.id',
		]) {
			assert.match(get(key), /gen_random_uuid/, `${key} default`);
		}
		// `created_at` / `updated_at` default to now()
		for (const key of [
			'account.created_at',
			'account.updated_at',
			'actor.created_at',
			'role_grant.created_at',
			'auth_session.created_at',
			'auth_session.last_seen_at',
			'api_token.created_at',
			'audit_log.created_at',
			'role_grant_offer.created_at',
			'invite.created_at',
		]) {
			assert.match(get(key), /now\(\)/i, `${key} default`);
		}
		// boolean defaults
		assert.match(get('account.email_verified'), /false/, 'account.email_verified default');
		assert.match(
			get('bootstrap_lock.bootstrapped'),
			/false/,
			'bootstrap_lock.bootstrapped default',
		);
		assert.match(get('app_settings.open_signup'), /false/, 'app_settings.open_signup default');
		// audit outcome default — text literal 'success'
		assert.match(get('audit_log.outcome'), /success/, 'audit_log.outcome default');
		// audit_log.seq is SERIAL — backed by a sequence
		assert.match(get('audit_log.seq'), /nextval/, 'audit_log.seq default');
		// bootstrap_lock and app_settings are single-row via CHECK (id = 1)
		assert.match(get('bootstrap_lock.id'), /^1$/, 'bootstrap_lock.id default');
		assert.match(get('app_settings.id'), /^1$/, 'app_settings.id default');
	});
});

describe('to_session_account', () => {
	test('strips sensitive and audit fields', () => {
		const account: Account = {
			id: 'abc' as Uuid,
			username: 'alice',
			email: 'alice@example.com',
			email_verified: false,
			password_hash: '$argon2id$secret',
			created_at: '2024-01-01',
			created_by: null,
			updated_at: '2024-01-02',
			updated_by: null,
			deleted_at: null,
			deleted_by: null,
		};
		const client = to_session_account(account);
		assert.deepStrictEqual(client, {
			id: 'abc' as Uuid,
			username: 'alice',
			email: 'alice@example.com',
			email_verified: false,
			created_at: '2024-01-01',
		});
		assert.strictEqual('password_hash' in client, false);
		assert.strictEqual('updated_at' in client, false);
	});
});
