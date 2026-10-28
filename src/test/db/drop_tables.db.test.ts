/**
 * Drift guard for `CELL_DROP_TABLES` and `FACT_DROP_TABLES` — the lists the
 * test fixtures truncate and the spine binary's `_testing_reset` clears, so a
 * table a namespace gains but its list lacks would survive every reset on the
 * TS spine (the Rust reset list is guarded by its own column test).
 *
 * Migrates one namespace at a time onto a fresh database and holds each list
 * to the tables that namespace's migrations added, then holds each list, and
 * the two concatenated as the spine binary resets them, to children-first
 * order: no table is listed after a table holding a foreign key to it.
 *
 * @module
 */

import { afterAll, assert, beforeAll, describe, test } from 'vitest';

import type { Db } from '#lib/db/db.ts';
import { run_migrations } from '#lib/db/migrate.ts';
import { query_public_columns } from '#lib/db/schema_ready.ts';
import { AUTH_MIGRATION_NS } from '#lib/auth/migrations.ts';
import { CELL_DROP_TABLES, CELL_MIGRATION_NS } from '#lib/db/cell_ddl.ts';
import { FACT_DROP_TABLES, FACT_MIGRATION_NS } from '#lib/db/fact_ddl.ts';
import { create_default_db_factory } from '#lib/testing/db.ts';

const factory = create_default_db_factory(async (db) => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
});

const query_table_names = async (db: Db): Promise<Set<string>> =>
	new Set(Object.keys(await query_public_columns(db)));

/** The tables `migrate` adds to `db`, sorted. */
const added_tables = async (db: Db, migrate: () => Promise<unknown>): Promise<Array<string>> => {
	const before = await query_table_names(db);
	await migrate();
	const after = await query_table_names(db);
	return [...after].filter((table) => !before.has(table)).sort();
};

/** Every foreign key between two distinct public tables, as `[child, parent]`. */
const query_foreign_key_edges = async (db: Db): Promise<Array<[string, string]>> => {
	const rows = await db.query<{ child: string; parent: string }>(
		`SELECT DISTINCT tc.table_name AS child, ccu.table_name AS parent
		   FROM information_schema.table_constraints tc
		   JOIN information_schema.constraint_column_usage ccu
		     ON ccu.constraint_name = tc.constraint_name
		    AND ccu.constraint_schema = tc.constraint_schema
		  WHERE tc.constraint_type = 'FOREIGN KEY'
		    AND tc.table_schema = 'public'
		    AND tc.table_name <> ccu.table_name`
	);
	return rows.map((r) => [r.child, r.parent]);
};

/** The order the spine binary's reset clears the two namespaces in. */
const SPINE_RESET_ORDER: ReadonlyArray<string> = [...CELL_DROP_TABLES, ...FACT_DROP_TABLES];

/**
 * The foreign keys `order` drops a parent ahead of its child on, among the
 * edges whose two tables it lists.
 */
const check_children_first = (
	order: ReadonlyArray<string>,
	edges: ReadonlyArray<readonly [string, string]>
): { violations: Array<string>; checked: number } => {
	const violations: Array<string> = [];
	let checked = 0;
	for (const [child, parent] of edges) {
		const child_index = order.indexOf(child);
		const parent_index = order.indexOf(parent);
		if (child_index === -1 || parent_index === -1) continue;
		checked++;
		if (child_index > parent_index) violations.push(`${child} references ${parent}`);
	}
	return { violations, checked };
};

describe.skipIf(factory.skip)('namespace drop lists', () => {
	let db: Db;
	let cell_tables: Array<string>;
	let fact_tables: Array<string>;

	beforeAll(async () => {
		db = await factory.create();
		// the order the full spine migrates in (`cell_db_fixture.ts`)
		cell_tables = await added_tables(db, () =>
			run_migrations(db, [AUTH_MIGRATION_NS, CELL_MIGRATION_NS])
		);
		fact_tables = await added_tables(db, () =>
			run_migrations(db, [AUTH_MIGRATION_NS, CELL_MIGRATION_NS, FACT_MIGRATION_NS])
		);
	});

	afterAll(async () => {
		await factory.close(db);
	});

	test('CELL_DROP_TABLES names exactly the tables the cell namespace creates', () => {
		assert.deepEqual([...CELL_DROP_TABLES].sort(), cell_tables);
	});

	test('FACT_DROP_TABLES names exactly the tables the fact namespace creates', () => {
		assert.deepEqual([...FACT_DROP_TABLES].sort(), fact_tables);
	});

	test('each list, and the two concatenated, drop a referencing table first', async () => {
		const edges = await query_foreign_key_edges(db);
		let checked = 0;
		// `full_spine_mount.ts` resets over the concatenation, cells first
		for (const order of [CELL_DROP_TABLES, FACT_DROP_TABLES, SPINE_RESET_ORDER]) {
			const { violations, checked: n } = check_children_first(order, edges);
			checked += n;
			assert.deepEqual(violations, [], `order: ${order.join(', ')}`);
		}
		assert.ok(checked > 0, 'no foreign key ran between two listed tables');
	});

	test('a fact table referencing a cell table would break the concatenated order', () => {
		const edge: [string, string] = [FACT_DROP_TABLES[0], CELL_DROP_TABLES[0]];
		assert.deepEqual(check_children_first(CELL_DROP_TABLES, [edge]).violations, []);
		assert.deepEqual(check_children_first(FACT_DROP_TABLES, [edge]).violations, []);
		assert.strictEqual(check_children_first(SPINE_RESET_ORDER, [edge]).violations.length, 1);
	});
});
