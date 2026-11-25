/**
 * The `drop_provenance_stamp_foreign_keys` migration over a database migrated
 * to the entry before it, holding a stamp: it drops exactly the stamps'
 * foreign keys, keeps every reference that carries meaning and the stamp's
 * value, and a stamp then names an actor no row holds. Twin of the Rust
 * spine's `drop_provenance_stamp_foreign_keys_drops_only_the_stamps`.
 *
 * @module
 */

import { describe, assert, test, beforeAll, beforeEach, afterAll } from 'vitest';

import type { Db } from '#lib/db/db.ts';
import { create_spine_migration_namespace, run_migrations } from '#lib/db/migrate.ts';
import { create_default_db_factory, reset_public_schema } from '#lib/testing/db.ts';
import { AUTH_MIGRATION_NS } from '#lib/auth/migrations.ts';
import { query_create_account_with_actor } from '#lib/auth/account_queries.ts';

const factory = create_default_db_factory(async () => {});
let db: Db;

beforeAll(async () => {
	db = await factory.create();
});

afterAll(async () => {
	await factory.close(db);
});

beforeEach(async () => {
	await reset_public_schema(db);
});

const MIGRATION_NAME = 'drop_provenance_stamp_foreign_keys';

const migration_index = (): number => {
	const index = AUTH_MIGRATION_NS.migrations.findIndex((m) => m.name === MIGRATION_NAME);
	assert.ok(index > 0, 'the migration is in the released chain');
	return index;
};

/** The chain before the migration under test. */
const prefix_namespace = () =>
	create_spine_migration_namespace(
		AUTH_MIGRATION_NS.namespace,
		AUTH_MIGRATION_NS.migrations.slice(0, migration_index())
	);

/** The chain's names from the migration under test on — what a run over the prefix applies. */
const tail_names = (): Array<string> =>
	AUTH_MIGRATION_NS.migrations.slice(migration_index()).map((m) => m.name);

/** The foreign keys on `actor`, `role_grant` and `role_grant_offer`, as `table.column → references`, sorted. */
const identity_foreign_keys = async (): Promise<Array<string>> => {
	const rows = await db.query<{
		table_name: string;
		column_name: string;
		foreign_table_name: string;
	}>(
		`SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name
		   FROM information_schema.table_constraints tc
		   JOIN information_schema.key_column_usage kcu
		     ON tc.constraint_name = kcu.constraint_name
		    AND tc.table_schema = kcu.table_schema
		    AND tc.table_name = kcu.table_name
		   JOIN information_schema.constraint_column_usage ccu
		     ON ccu.constraint_name = tc.constraint_name
		    AND ccu.constraint_schema = tc.constraint_schema
		  WHERE tc.constraint_type = 'FOREIGN KEY'
		    AND tc.table_schema = 'public'
		    AND tc.table_name IN ('actor', 'role_grant', 'role_grant_offer')
		  ORDER BY tc.table_name, kcu.column_name`
	);
	return rows.map((r) => `${r.table_name}.${r.column_name} → ${r.foreign_table_name}`);
};

const STAMPS = [
	'actor.deleted_by → actor',
	'actor.updated_by → actor',
	'role_grant.granted_by → actor',
	'role_grant.revoked_by → actor',
	'role_grant.source_offer_id → role_grant_offer'
];

describe(MIGRATION_NAME, () => {
	test('drops only the stamps, keeping their values past a purge', async () => {
		await run_migrations(db, [prefix_namespace()]);
		const { actor: granter } = await query_create_account_with_actor(
			{ db },
			{ username: 'stamp_granter', password_hash: 'x' }
		);
		const { actor: grantee } = await query_create_account_with_actor(
			{ db },
			{ username: 'stamp_grantee', password_hash: 'x' }
		);
		const grant = (
			await db.query<{ id: string }>(
				`INSERT INTO role_grant (actor_id, role, granted_by) VALUES ($1, 'stamp_role', $2)
				 RETURNING id`,
				[grantee.id, granter.id]
			)
		)[0]!.id;
		const before = await identity_foreign_keys();
		for (const stamp of STAMPS) {
			assert.include(before, stamp, `${stamp} before the migration`);
		}

		const results = await run_migrations(db, [AUTH_MIGRATION_NS]);
		assert.deepStrictEqual(results[0]!.applied_names, tail_names());
		const after = await identity_foreign_keys();
		assert.deepStrictEqual(
			after,
			before.filter((fk) => !STAMPS.includes(fk)),
			"only the stamps' foreign keys are dropped"
		);
		assert.include(after, 'role_grant.actor_id → actor', "a grant's holder keeps its foreign key");

		await db.query(`DELETE FROM account WHERE username = 'stamp_granter'`);
		const rows = await db.query<{ granted_by: string | null }>(
			`SELECT granted_by FROM role_grant WHERE id = $1`,
			[grant]
		);
		assert.deepStrictEqual(
			rows,
			[{ granted_by: granter.id }],
			'the purge leaves the stamp as written'
		);
	});
});
