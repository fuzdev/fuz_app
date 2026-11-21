import './assert_dev_env.ts';

/**
 * The vitest-bound database test helpers: `create_describe_db`, which runs a
 * suite once per `DbFactory` (`testing/db.ts`), and `assert_columns_match_live`,
 * the named-projection drift guard. Apart from `testing/db.ts` so the
 * factories stay vitest-free for the spawned spine binary.
 *
 * @module
 */

import { describe, beforeAll, beforeEach, afterAll, assert } from 'vitest';

import type { Db } from '../db/db.ts';
import { assert_valid_sql_identifier } from '../db/sql_identifier.ts';
import { query_public_columns } from '../db/schema_ready.ts';
import type { DbFactory } from './db.ts';

/**
 * Create a `describe_db` function bound to specific factories and truncate tables.
 *
 * Returns a 2-arg `(name, fn)` function that runs the test suite against each
 * factory. Each factory gets its own `describe` block with a shared database
 * instance, automatic `beforeEach` truncation, and `afterAll` cleanup.
 * Skipped factories use `describe.skip`.
 *
 * @param factories - one or more database factories to run suites against
 * @param truncate_tables - tables to truncate between tests (children first for FK safety)
 * @mutates the underlying database between tests — `beforeEach` issues
 *   `TRUNCATE <truncate_tables> CASCADE` against the shared instance.
 */
export const create_describe_db = (
	factories: DbFactory | Array<DbFactory>,
	truncate_tables: Array<string>
): ((name: string, fn: (get_db: () => Db) => void) => void) => {
	const factory_list = Array.isArray(factories) ? factories : [factories];
	return (name, fn) => {
		for (const factory of factory_list) {
			const describe_fn = factory.skip ? describe.skip : describe;
			describe_fn(`${name} (${factory.name})`, () => {
				let db: Db | undefined;
				beforeAll(async () => {
					db = await factory.create();
				});
				beforeEach(async () => {
					if (db && truncate_tables.length > 0) {
						await db.query(
							`TRUNCATE ${truncate_tables.map(assert_valid_sql_identifier).join(', ')} CASCADE`
						);
					}
				});
				afterAll(async () => {
					if (db) await factory.close(db);
				});
				fn(() => db!);
			});
		}
	};
};

/**
 * Assert a `*_COLUMNS` projection const names exactly the live columns of
 * `table` — the drift guard for an exported const (`ACCOUNT_COLUMNS`,
 * `CELL_COLUMNS`, a consumer's own).
 *
 * This is the reverse of the fail-loud read: a named projection makes a
 * *dropped* column fail loud at query time, but a column *added* to the table
 * and not to the projection would silently vanish from every row read. Both
 * directions are covered by the equality here. It guards one const; it can't
 * see a table that has *no* const — for that, keep a table → const registry
 * and assert its key set against `query_public_columns` (fuz_app's own is
 * `src/test/db/column_projections.db.test.ts`).
 *
 * @param db - a bootstrapped test database
 * @param table - the `public`-schema table the const projects
 * @param columns - the projection const's column names
 */
export const assert_columns_match_live = async (
	db: Db,
	table: string,
	columns: ReadonlyArray<string>
): Promise<void> => {
	const live = await query_public_columns(db, { table });
	assert.ok(live[table], `table "${table}" is not in the live public schema`);
	assert.deepEqual([...columns].sort(), live[table]);
};
