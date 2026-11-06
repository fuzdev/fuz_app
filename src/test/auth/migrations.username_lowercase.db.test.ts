/**
 * The `account_username_lowercase` migration against a database that already
 * holds accounts: lowercase rows pass, a mixed-case row fails the migration
 * and rolls its chain back, and once that row is lowercased the chain applies
 * and the CHECK refuses a mixed-case insert from then on. Twin of the Rust
 * spine's `account_username_lowercase_migration_refuses_a_mixed_case_row`.
 *
 * @module
 */

import { describe, assert, test, beforeAll, beforeEach } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import type { Db } from '#lib/db/db.ts';
import { create_spine_migration_namespace, run_migrations } from '#lib/db/migrate.ts';
import { pg_error_code } from '#lib/db/pg_error.ts';
import { create_default_db_factory, reset_public_schema } from '#lib/testing/db.ts';
import { AUTH_MIGRATION_NS } from '#lib/auth/migrations.ts';

const factory = create_default_db_factory(async () => {});
let db: Db;

beforeAll(async () => {
	db = await factory.create();
});

beforeEach(async () => {
	await reset_public_schema(db);
});

const MIGRATION_NAME = 'account_username_lowercase';

/** The chain before the migration under test. */
const prefix_namespace = () => {
	const index = AUTH_MIGRATION_NS.migrations.findIndex((m) => m.name === MIGRATION_NAME);
	assert.ok(index > 0, 'the migration is in the released chain');
	return create_spine_migration_namespace(
		AUTH_MIGRATION_NS.namespace,
		AUTH_MIGRATION_NS.migrations.slice(0, index)
	);
};

const applied = async (): Promise<number> => {
	const rows = await db.query<{ count: number | string }>(
		`SELECT count(*) AS count FROM schema_version WHERE namespace = 'fuz_auth' AND name = $1`,
		[MIGRATION_NAME]
	);
	return Number(rows[0]!.count);
};

describe('account_username_lowercase', () => {
	test('a mixed-case row fails the migration, which applies once the row is lowercased', async () => {
		await run_migrations(db, [prefix_namespace()]);
		await db.query(
			`INSERT INTO account (username, password_hash) VALUES ('lower_holder', 'x'), ('Mixed_Holder', 'x')`
		);

		const err = await assert_rejects(() => run_migrations(db, [AUTH_MIGRATION_NS]));
		assert.include(err.message, MIGRATION_NAME);
		assert.strictEqual(await applied(), 0, 'the failed migration is not recorded');

		await db.query('UPDATE account SET username = lower(username)');
		const results = await run_migrations(db, [AUTH_MIGRATION_NS]);
		assert.deepStrictEqual(results[0]!.applied_names, [MIGRATION_NAME]);
		assert.strictEqual(await applied(), 1);

		const insert = await assert_rejects(() =>
			db.query(`INSERT INTO account (username, password_hash) VALUES ('Another_Mixed', 'x')`)
		);
		assert.strictEqual(pg_error_code(insert), '23514');
	});

	test('a database of lowercase rows migrates', async () => {
		await run_migrations(db, [prefix_namespace()]);
		await db.query(`INSERT INTO account (username, password_hash) VALUES ('lower_holder', 'x')`);
		const results = await run_migrations(db, [AUTH_MIGRATION_NS]);
		assert.deepStrictEqual(results[0]!.applied_names, [MIGRATION_NAME]);
	});
});
