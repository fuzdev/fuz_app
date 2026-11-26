import './assert_dev_env.ts';

/**
 * The vitest-bound database test helpers: `create_describe_db`, which runs a
 * suite once per `DbFactory` (`testing/db.ts`), and `assert_columns_match_live`,
 * the named-projection drift guard. Apart from `testing/db.ts` so the
 * factories stay vitest-free for the spawned spine binary.
 *
 * @module
 */

import {
	describe,
	beforeAll,
	beforeEach,
	afterAll,
	assert,
	onTestFinished,
	TestRunner
} from 'vitest';

import type { Db } from '../db/db.ts';
import { assert_valid_sql_identifier } from '../db/sql_identifier.ts';
import { query_public_columns } from '../db/schema_ready.ts';
import { reset_auth_singletons, type DbFactory } from './db.ts';
import {
	announce_db_invariant_exclusions,
	assert_db_invariants,
	take_app_checks_db_invariants
} from './db_invariants.ts';
import { DB_INVARIANTS_EXCLUDE_ALL, type DbInvariantExclusions } from './db_invariant_queries.ts';

/**
 * The invariants `describe_db` leaves unchecked unless a suite opts back in
 * (`DescribeDbOptions.include_db_invariants`), each with its reason.
 * `create_test_app` checks them.
 */
export const DESCRIBE_DB_DEFAULT_INVARIANT_EXCLUSIONS = {
	account_without_bootstrap: "query-level suites write accounts without the spine's bootstrap"
} as const satisfies DbInvariantExclusions;

/** Options for one `describe_db` suite. */
export interface DescribeDbOptions {
	/**
	 * Database invariants left unchecked after each of this suite's tests, each
	 * with the reason the suite's state is deliberate — rows a query-level test
	 * writes by hand without the cascade the spine would run. Added to
	 * `DESCRIBE_DB_DEFAULT_INVARIANT_EXCLUSIONS`; `{all: reason}` alone turns
	 * the check off. Same shape as `create_test_app`'s.
	 */
	exclude_db_invariants?: DbInvariantExclusions;
	/**
	 * Invariants of `DESCRIBE_DB_DEFAULT_INVARIANT_EXCLUSIONS` this suite checks
	 * after all — a suite whose tests bootstrap every account they write.
	 */
	include_db_invariants?: ReadonlyArray<keyof typeof DESCRIBE_DB_DEFAULT_INVARIANT_EXCLUSIONS>;
}

/**
 * Resolve a suite's exclusions: the defaults less `include`, plus the suite's own.
 *
 * @throws Error on an `include_db_invariants` entry that isn't a default
 *   exclusion, or any `include_db_invariants` beside `{all}`
 */
const resolve_describe_db_exclusions = (
	options: DescribeDbOptions | undefined,
	label: string
): DbInvariantExclusions => {
	const exclude = options?.exclude_db_invariants;
	if (exclude?.[DB_INVARIANTS_EXCLUDE_ALL] !== undefined) {
		if (options?.include_db_invariants?.length) {
			throw new Error(
				`${label}: include_db_invariants checks nothing beside exclude_db_invariants '${DB_INVARIANTS_EXCLUDE_ALL}'`
			);
		}
		return exclude;
	}
	const defaults: Record<string, string> = { ...DESCRIBE_DB_DEFAULT_INVARIANT_EXCLUSIONS };
	for (const name of options?.include_db_invariants ?? []) {
		if (!(name in defaults)) {
			throw new Error(`${label}: include_db_invariants '${name}' is not excluded by default`);
		}
		delete defaults[name];
	}
	return { ...defaults, ...exclude };
};

/** A `describe_db` bound to its factories and truncate tables. */
export type DescribeDb = (
	name: string,
	fn: (get_db: () => Db) => void,
	options?: DescribeDbOptions
) => void;

/**
 * Create a `describe_db` function bound to specific factories and truncate tables.
 *
 * Returns a `(name, fn, options?)` function that runs the test suite against
 * each factory. Each factory gets its own `describe` block with a shared
 * database instance, automatic `beforeEach` reset, and `afterAll` cleanup.
 * Skipped factories use `describe.skip`.
 *
 * When `truncate_tables` includes the auth namespace's `account`, the suite
 * resets the auth state whole: after the truncate, `reset_auth_singletons`
 * restores `app_settings` and `bootstrap_lock`, and each test is held to the
 * database invariants (`assert_db_invariants`) when it finishes, unless it
 * failed or built a `create_test_app` app on the suite's database (whose own
 * check, with the test's exclusions, runs instead). The invariants of
 * `DESCRIBE_DB_DEFAULT_INVARIANT_EXCLUSIONS` are left out unless the suite
 * passes `include_db_invariants`; opt out of more per invariant, or `all`,
 * with the suite's `exclude_db_invariants`.
 *
 * @param factories - one or more database factories to run suites against
 * @param truncate_tables - tables to truncate between tests, in one `TRUNCATE … CASCADE`
 * @returns the bound `describe_db`
 * @throws Error from the returned function on an `exclude_db_invariants`
 *   entry naming no invariant or carrying no reason
 * @mutates the underlying database between tests — `beforeEach` issues
 *   `TRUNCATE <truncate_tables> CASCADE` against the shared instance, then
 *   resets the auth singleton rows when the list holds the auth tables
 */
export const create_describe_db = (
	factories: DbFactory | Array<DbFactory>,
	truncate_tables: Array<string>
): DescribeDb => {
	const factory_list = Array.isArray(factories) ? factories : [factories];
	const truncate_sql =
		truncate_tables.length > 0
			? `TRUNCATE ${truncate_tables.map(assert_valid_sql_identifier).join(', ')} CASCADE`
			: null;
	// a suite that clears the auth rows resets the rest of the auth state, and
	// is held to the invariants that state promises
	const resets_auth = truncate_tables.includes('account');
	return (name, fn, options) => {
		const label = `describe_db ${name}`;
		announce_db_invariant_exclusions(options?.exclude_db_invariants, label);
		const exclude = resolve_describe_db_exclusions(options, label);
		for (const factory of factory_list) {
			const describe_fn = factory.skip ? describe.skip : describe;
			describe_fn(`${name} (${factory.name})`, () => {
				let db: Db | undefined;
				beforeAll(async () => {
					db = await factory.create();
				});
				beforeEach(async () => {
					if (!db) return;
					if (truncate_sql) await db.query(truncate_sql);
					if (!resets_auth) return;
					await reset_auth_singletons(db);
					const test_db = db;
					const task = TestRunner.getCurrentTest();
					if (!task) return;
					onTestFinished(async ({ task: finished }) => {
						// a test app over this database checks it with the test's exclusions
						if (take_app_checks_db_invariants(task, test_db)) return;
						if (finished.result?.state === 'fail') return;
						await assert_db_invariants({ db: test_db }, `describe_db ${factory.name}`, exclude);
					});
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
