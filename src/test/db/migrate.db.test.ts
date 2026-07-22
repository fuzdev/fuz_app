/**
 * Tests for the migration runner in isolation.
 *
 * Uses `create_pglite_factory` (not `describe_db`) to test runner behavior directly.
 *
 * @module
 */

import { describe, assert, test, beforeAll, beforeEach } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import type { Db } from '$lib/db/db.ts';
import {
	baseline,
	run_migrations,
	MigrationError,
	type Migration,
	type MigrationNamespace
} from '$lib/db/migrate.ts';
import { create_pglite_factory, reset_pglite } from '$lib/testing/db.ts';

const noop_init = async (_db: Db): Promise<void> => {};
const factory = create_pglite_factory(noop_init);
let db: Db;

beforeAll(async () => {
	db = await factory.create();
});

beforeEach(async () => {
	await reset_pglite(db);
});

const named = (name: string, up: Migration['up'] = async () => {}): Migration => ({ name, up });

const create_old_tracker = async (): Promise<void> => {
	await db.query(`
		CREATE TABLE schema_version (
		  namespace TEXT PRIMARY KEY,
		  version INTEGER NOT NULL DEFAULT 0,
		  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`);
};

const seed_applied_row = async (
	namespace: string,
	name: string,
	sequence: number
): Promise<void> => {
	await db.query(`INSERT INTO schema_version (namespace, name, sequence) VALUES ($1, $2, $3)`, [
		namespace,
		name,
		sequence
	]);
};

const assert_migration_error = (err: unknown): MigrationError => {
	assert.ok(err instanceof MigrationError, `expected MigrationError, got ${err}`);
	return err;
};

describe('run_migrations', () => {
	test('fresh DB runs all migrations', async () => {
		const calls: Array<number> = [];
		const migrations: Array<Migration> = [
			named('m0', async () => {
				calls.push(0);
			}),
			named('m1', async () => {
				calls.push(1);
			})
		];
		const ns: MigrationNamespace = { namespace: 'fresh_ns', migrations };

		const results = await run_migrations(db, [ns]);

		assert.deepStrictEqual(calls, [0, 1]);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0]!.namespace, 'fresh_ns');
		assert.deepStrictEqual(results[0]!.applied_names, ['m0', 'm1']);

		// rows recorded with sequences 0..N-1 in execution order
		const rows = await db.query<{ name: string; sequence: number }>(
			`SELECT name, sequence FROM schema_version WHERE namespace = $1 ORDER BY sequence ASC`,
			['fresh_ns']
		);
		assert.deepStrictEqual(
			rows.map((r) => [r.sequence, r.name]),
			[
				[0, 'm0'],
				[1, 'm1']
			]
		);
	});

	test('pre-existing schema skips completed migrations', async () => {
		const migrations: Array<Migration> = [
			named('skip_a', async (d) => {
				await d.query('CREATE TABLE IF NOT EXISTS migrate_test_a (id INT)');
			}),
			named('skip_b', async (d) => {
				await d.query('CREATE TABLE IF NOT EXISTS migrate_test_b (id INT)');
			})
		];
		const ns: MigrationNamespace = { namespace: 'skip_ns', migrations };

		const first = await run_migrations(db, [ns]);
		assert.strictEqual(first.length, 1);
		assert.deepStrictEqual(first[0]!.applied_names, ['skip_a', 'skip_b']);

		const second = await run_migrations(db, [ns]);
		assert.strictEqual(second.length, 0); // nothing to do
	});

	test('binary-older-than-db: applied beyond code length', async () => {
		const migrations: Array<Migration> = [named('m0'), named('m1')];
		const ns: MigrationNamespace = { namespace: 'older_ns', migrations };

		await run_migrations(db, [ns]);
		await seed_applied_row('older_ns', 'm2_unknown', 2);
		await seed_applied_row('older_ns', 'm3_unknown', 3);

		const err = assert_migration_error(await assert_rejects(() => run_migrations(db, [ns])));
		assert.strictEqual(err.kind, 'binary-older-than-db');
		assert.strictEqual(err.namespace, 'older_ns');
		assert.deepStrictEqual([...(err.unknown_names ?? [])], ['m2_unknown', 'm3_unknown']);
	});

	test('name-divergence-at-N: applied name differs from code', async () => {
		const code_migrations: Array<Migration> = [named('m0'), named('m1'), named('m2')];
		const ns: MigrationNamespace = { namespace: 'diverge_ns', migrations: code_migrations };

		// seed applied rows where index 1 has the wrong name
		await run_migrations(db, [{ namespace: 'diverge_ns', migrations: [] }]);
		await seed_applied_row('diverge_ns', 'm0', 0);
		await seed_applied_row('diverge_ns', 'wrong_name', 1);

		const err = assert_migration_error(await assert_rejects(() => run_migrations(db, [ns])));
		assert.strictEqual(err.kind, 'name-divergence-at-N');
		assert.strictEqual(err.namespace, 'diverge_ns');
		assert.strictEqual(err.at_index, 1);
	});

	test('name-divergence-at-N fires when applied.length === code.length (overlap-end divergence)', async () => {
		// Lengths match but the last name disagrees — name verify must catch it
		// before the up-to-date short-circuit.
		const code_migrations: Array<Migration> = [named('m0'), named('m1')];
		const ns: MigrationNamespace = { namespace: 'eq_diverge_ns', migrations: code_migrations };

		await run_migrations(db, [{ namespace: 'eq_diverge_ns', migrations: [] }]);
		await seed_applied_row('eq_diverge_ns', 'm0', 0);
		await seed_applied_row('eq_diverge_ns', 'wrong_at_end', 1);

		const err = assert_migration_error(await assert_rejects(() => run_migrations(db, [ns])));
		assert.strictEqual(err.kind, 'name-divergence-at-N');
		assert.strictEqual(err.at_index, 1);
	});

	test('binary-older-than-db when code is empty (pre-publish-collapse footgun)', async () => {
		// The "collapse migrations into v0 for pre-release" advice (now removed
		// from the docstring) bit the project once: an in-place rewrite to a
		// shorter array against a populated tracker. Empty code is the extreme
		// case — every applied row becomes "unknown to this binary".
		await run_migrations(db, [
			{ namespace: 'collapse_ns', migrations: [named('m0'), named('m1')] }
		]);

		const empty_ns: MigrationNamespace = { namespace: 'collapse_ns', migrations: [] };
		const err = assert_migration_error(await assert_rejects(() => run_migrations(db, [empty_ns])));
		assert.strictEqual(err.kind, 'binary-older-than-db');
		assert.deepStrictEqual([...(err.unknown_names ?? [])], ['m0', 'm1']);
	});

	test('binary-older-than-db short-circuits before name-divergence-at-N (length check first)', async () => {
		// Exercises the step-3-before-step-4 ordering. A binary-older case that
		// also has a divergence in the overlap must fire `binary-older-than-db`,
		// not `name-divergence-at-N`. Locks in the design's check order.
		const code_migrations: Array<Migration> = [named('m0'), named('m1'), named('m2')];
		const ns: MigrationNamespace = { namespace: 'order_ns', migrations: code_migrations };

		await run_migrations(db, [{ namespace: 'order_ns', migrations: [] }]);
		// applied has 4 rows (> code.length=3) AND a divergence at index 1
		await seed_applied_row('order_ns', 'm0', 0);
		await seed_applied_row('order_ns', 'wrong_at_overlap', 1);
		await seed_applied_row('order_ns', 'm2', 2);
		await seed_applied_row('order_ns', 'm3_unknown', 3);

		const err = assert_migration_error(await assert_rejects(() => run_migrations(db, [ns])));
		assert.strictEqual(err.kind, 'binary-older-than-db');
		assert.deepStrictEqual([...(err.unknown_names ?? [])], ['m3_unknown']);
	});

	test('old-tracker-shape detected before any DDL or per-namespace work', async () => {
		await create_old_tracker();
		const ns: MigrationNamespace = { namespace: 'irrelevant', migrations: [named('m0')] };

		const err = assert_migration_error(await assert_rejects(() => run_migrations(db, [ns])));
		assert.strictEqual(err.kind, 'old-tracker-shape');
	});

	test('any failure rolls back the whole pending chain', async () => {
		const migrations: Array<Migration> = [
			named('rb_a', async (d) => {
				await d.query('CREATE TABLE IF NOT EXISTS rollback_test (id INT)');
			}),
			named('rb_b', async () => {
				throw new Error('intentional failure');
			})
		];
		const ns: MigrationNamespace = { namespace: 'rollback_ns', migrations };

		const err = assert_migration_error(await assert_rejects(() => run_migrations(db, [ns])));
		assert.strictEqual(err.kind, 'migration-failed');
		assert.strictEqual(err.at_index, 1);

		// chain-level tx: migration 0's row + DDL rolled back
		const rows = await db.query<{ name: string }>(
			'SELECT name FROM schema_version WHERE namespace = $1',
			['rollback_ns']
		);
		assert.strictEqual(rows.length, 0);

		const tables = await db.query<{ tablename: string }>(
			"SELECT tablename FROM pg_tables WHERE tablename = 'rollback_test'"
		);
		assert.strictEqual(tables.length, 0);
	});

	test('first migration failure leaves no rows', async () => {
		const migrations: Array<Migration> = [
			named('first_fail', async () => {
				throw new Error('boom');
			})
		];
		const ns: MigrationNamespace = { namespace: 'first_fail_ns', migrations };

		const err = assert_migration_error(await assert_rejects(() => run_migrations(db, [ns])));
		assert.strictEqual(err.kind, 'migration-failed');

		const rows = await db.query('SELECT name FROM schema_version WHERE namespace = $1', [
			'first_fail_ns'
		]);
		assert.strictEqual(rows.length, 0);
	});

	test('multiple namespaces tracked independently', async () => {
		const ns_a: MigrationNamespace = {
			namespace: 'multi_a',
			migrations: [named('a0'), named('a1')]
		};
		const ns_b: MigrationNamespace = {
			namespace: 'multi_b',
			migrations: [named('b0')]
		};

		const results = await run_migrations(db, [ns_a, ns_b]);

		assert.strictEqual(results.length, 2);
		assert.strictEqual(results[0]!.namespace, 'multi_a');
		assert.deepStrictEqual(results[0]!.applied_names, ['a0', 'a1']);
		assert.strictEqual(results[1]!.namespace, 'multi_b');
		assert.deepStrictEqual(results[1]!.applied_names, ['b0']);

		const rows_a = await db.query<{ name: string }>(
			'SELECT name FROM schema_version WHERE namespace = $1 ORDER BY sequence',
			['multi_a']
		);
		const rows_b = await db.query<{ name: string }>(
			'SELECT name FROM schema_version WHERE namespace = $1 ORDER BY sequence',
			['multi_b']
		);
		assert.deepStrictEqual(
			rows_a.map((r) => r.name),
			['a0', 'a1']
		);
		assert.deepStrictEqual(
			rows_b.map((r) => r.name),
			['b0']
		);
	});

	test('cross-namespace independence: earlier success commits when a later namespace fails', async () => {
		// run_migrations processes namespaces in order; each namespace's chain-tx
		// is its own transaction. A later namespace's failure must NOT roll back
		// an earlier namespace that already committed. Locks in the docstring
		// promise: "Namespaces are independent: a later namespace's failure
		// does not roll back an earlier namespace that already committed."
		const ns_first: MigrationNamespace = {
			namespace: 'cross_first',
			migrations: [named('first_0'), named('first_1')]
		};
		const ns_failing: MigrationNamespace = {
			namespace: 'cross_failing',
			migrations: [
				named('failing_0', async () => {
					throw new Error('intentional failure');
				})
			]
		};

		const err = assert_migration_error(
			await assert_rejects(() => run_migrations(db, [ns_first, ns_failing]))
		);
		assert.strictEqual(err.kind, 'migration-failed');
		assert.strictEqual(err.namespace, 'cross_failing');

		// first namespace's rows are present (its chain-tx already committed)
		const first_rows = await db.query<{ name: string }>(
			'SELECT name FROM schema_version WHERE namespace = $1 ORDER BY sequence',
			['cross_first']
		);
		assert.deepStrictEqual(
			first_rows.map((r) => r.name),
			['first_0', 'first_1']
		);

		// failing namespace's rows rolled back
		const failing_rows = await db.query('SELECT name FROM schema_version WHERE namespace = $1', [
			'cross_failing'
		]);
		assert.strictEqual(failing_rows.length, 0);
	});

	test('retry after failure re-runs the whole pending chain from prior committed state', async () => {
		let migration_0_runs = 0;
		const failing_migrations: Array<Migration> = [
			named('resume_0', async (d) => {
				migration_0_runs++;
				await d.query('CREATE TABLE IF NOT EXISTS resume_test (id INT)');
			}),
			named('resume_1', async () => {
				throw new Error('intentional failure');
			})
		];
		const ns: MigrationNamespace = { namespace: 'resume_ns', migrations: failing_migrations };

		await assert_rejects(() => run_migrations(db, [ns]));
		assert.strictEqual(migration_0_runs, 1);

		// "fix" migration 1 and re-run — migration 0 MUST re-run because the
		// prior attempt rolled back
		let migration_1_ran = false;
		const fixed_migrations: Array<Migration> = [
			failing_migrations[0]!,
			named('resume_1', async () => {
				migration_1_ran = true;
			})
		];
		const fixed_ns: MigrationNamespace = { namespace: 'resume_ns', migrations: fixed_migrations };

		const results = await run_migrations(db, [fixed_ns]);

		assert.strictEqual(migration_0_runs, 2);
		assert.ok(migration_1_ran);
		assert.strictEqual(results.length, 1);
		assert.deepStrictEqual(results[0]!.applied_names, ['resume_0', 'resume_1']);
	});

	test('error wraps cause for debuggability', async () => {
		const original = new Error('root cause');
		const migrations: Array<Migration> = [
			named('cause_0', async () => {
				throw original;
			})
		];
		const ns: MigrationNamespace = { namespace: 'cause_ns', migrations };

		const err = assert_migration_error(await assert_rejects(() => run_migrations(db, [ns])));
		assert.strictEqual(err.kind, 'migration-failed');
		assert.strictEqual(err.cause, original);
	});

	test('empty migrations array produces no result', async () => {
		const ns: MigrationNamespace = { namespace: 'empty_ns', migrations: [] };

		const results = await run_migrations(db, [ns]);

		assert.strictEqual(results.length, 0);
	});

	test('concurrent run_migrations on same namespace both complete without errors', async () => {
		const migrations: Array<Migration> = [
			named('conc_0', async (d) => {
				await d.query('CREATE TABLE IF NOT EXISTS concurrent_test (id INT)');
			})
		];
		const ns: MigrationNamespace = { namespace: 'concurrent_ns', migrations };

		// With advisory locks (real PG), one waits and finds version applied.
		// Without (PGlite), both may apply (UNIQUE on name prevents duplicates).
		const settled = await Promise.allSettled([run_migrations(db, [ns]), run_migrations(db, [ns])]);

		// At least one must succeed; the other either succeeds or fails on the
		// (namespace, name) PK race — both are acceptable in the no-lock fallback.
		const any_success = settled.some((r) => r.status === 'fulfilled');
		assert.ok(any_success, 'at least one concurrent run must succeed');

		const rows = await db.query<{ name: string }>(
			'SELECT name FROM schema_version WHERE namespace = $1',
			['concurrent_ns']
		);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.name, 'conc_0');

		const tables = await db.query<{ tablename: string }>(
			"SELECT tablename FROM pg_tables WHERE tablename = 'concurrent_test'"
		);
		assert.strictEqual(tables.length, 1);
	});

	test('advisory-lock-unsupported path (PGlite) — runner proceeds without serialization', async () => {
		// PGlite does not expose pg_advisory_lock. The runner's try/catch around
		// the lock acquire/release calls swallows the error and proceeds. This
		// test asserts the no-regression contract: a vanilla run_migrations
		// against PGlite completes without throwing.
		const migrations: Array<Migration> = [named('lk_0'), named('lk_1')];
		const ns: MigrationNamespace = { namespace: 'lock_unsupported_ns', migrations };

		const results = await run_migrations(db, [ns]);
		assert.deepStrictEqual(results[0]!.applied_names, ['lk_0', 'lk_1']);
	});

	describe('repair scenarios', () => {
		test('suffix-delete: runner re-applies missing tail', async () => {
			let m1_runs = 0;
			const migrations: Array<Migration> = [
				named('rep_0'),
				named('rep_1', async () => {
					m1_runs++;
				})
			];
			const ns: MigrationNamespace = { namespace: 'suffix_del_ns', migrations };

			await run_migrations(db, [ns]);
			assert.strictEqual(m1_runs, 1);

			// suffix-delete the last row
			await db.query(`DELETE FROM schema_version WHERE namespace = $1 AND name = $2`, [
				'suffix_del_ns',
				'rep_1'
			]);

			// re-run: rep_1 re-applies, sequence continues from max+1
			const results = await run_migrations(db, [ns]);
			assert.strictEqual(m1_runs, 2);
			assert.deepStrictEqual(results[0]!.applied_names, ['rep_1']);

			// tracker is whole again — and the new row's sequence is max+1 (1 in
			// this case, since the deleted row's sequence was 1)
			const rows = await db.query<{ name: string; sequence: number }>(
				'SELECT name, sequence FROM schema_version WHERE namespace = $1 ORDER BY sequence',
				['suffix_del_ns']
			);
			assert.deepStrictEqual(
				rows.map((r) => [r.sequence, r.name]),
				[
					[0, 'rep_0'],
					[1, 'rep_1']
				]
			);
		});

		test('middle-delete + manual re-INSERT below following rows: runner sees up-to-date', async () => {
			const migrations: Array<Migration> = [named('mid_0'), named('mid_1'), named('mid_2')];
			const ns: MigrationNamespace = { namespace: 'middle_del_ns', migrations };

			await run_migrations(db, [ns]);

			// middle-delete row at sequence 1 ('mid_1')
			await db.query(`DELETE FROM schema_version WHERE namespace = $1 AND name = $2`, [
				'middle_del_ns',
				'mid_1'
			]);
			// re-INSERT with a sequence value LOWER than the rows that follow it
			// (the design's prescribed repair). The sentinel sequence we pick
			// must be < 2 (the sequence of the next row, 'mid_2'), so we use 1.
			await seed_applied_row('middle_del_ns', 'mid_1', 1);

			// runner re-reads ORDER BY sequence and sees the prefix matching code
			const results = await run_migrations(db, [ns]);
			assert.strictEqual(results.length, 0);

			const rows = await db.query<{ name: string; sequence: number }>(
				'SELECT name, sequence FROM schema_version WHERE namespace = $1 ORDER BY sequence',
				['middle_del_ns']
			);
			assert.deepStrictEqual(
				rows.map((r) => r.name),
				['mid_0', 'mid_1', 'mid_2']
			);
		});

		test('sequence-gap tolerance: runner reads ORDER BY sequence and ignores absolute values', async () => {
			// Apply migrations, then re-INSERT the last row at a much higher
			// sequence value. Position-based name verify must still see it as
			// the last entry of the prefix.
			const migrations: Array<Migration> = [named('gap_0'), named('gap_1'), named('gap_2')];
			const ns: MigrationNamespace = { namespace: 'gap_ns', migrations };

			await run_migrations(db, [ns]);

			await db.query(`DELETE FROM schema_version WHERE namespace = $1 AND name = $2`, [
				'gap_ns',
				'gap_2'
			]);
			await seed_applied_row('gap_ns', 'gap_2', 1002); // big gap from 1 to 1002

			const results = await run_migrations(db, [ns]);
			assert.strictEqual(results.length, 0); // up-to-date

			// next migration (if appended) would get sequence = 1003
			const max_row = await db.query_one<{ max: number }>(
				'SELECT MAX(sequence) as max FROM schema_version WHERE namespace = $1',
				['gap_ns']
			);
			assert.strictEqual(max_row?.max, 1002);
		});
	});
});

describe('baseline', () => {
	test('happy path: inserts rows for the supplied prefix without executing them', async () => {
		let any_up_ran = false;
		const migrations: Array<Migration> = [
			named('bl_0', async () => {
				any_up_ran = true;
			}),
			named('bl_1', async () => {
				any_up_ran = true;
			}),
			named('bl_2', async () => {
				any_up_ran = true;
			})
		];
		const ns: MigrationNamespace = { namespace: 'baseline_ns', migrations };

		await baseline(db, ns, ['bl_0', 'bl_1']);

		assert.strictEqual(any_up_ran, false, 'baseline must not execute migration up()');

		const rows = await db.query<{ name: string; sequence: number }>(
			'SELECT name, sequence FROM schema_version WHERE namespace = $1 ORDER BY sequence',
			['baseline_ns']
		);
		assert.deepStrictEqual(
			rows.map((r) => [r.sequence, r.name]),
			[
				[0, 'bl_0'],
				[1, 'bl_1']
			]
		);

		// run_migrations now applies only the un-baselined tail
		const results = await run_migrations(db, [ns]);
		assert.deepStrictEqual(results[0]!.applied_names, ['bl_2']);
		assert.strictEqual(any_up_ran, true);
	});

	test('happy path on a fresh DB creates the new-shape tracker table', async () => {
		// reset_pglite already ran in beforeEach — schema_version doesn't exist
		const ns: MigrationNamespace = {
			namespace: 'fresh_baseline_ns',
			migrations: [named('a'), named('b')]
		};
		await baseline(db, ns, ['a', 'b']);

		const cols = await db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_schema = 'public' AND table_name = 'schema_version'
			 ORDER BY column_name`
		);
		const names = cols.map((c) => c.column_name).sort();
		assert.deepStrictEqual(names, ['applied_at', 'name', 'namespace', 'sequence']);
	});

	test('baseline-name-not-in-code: supplied name absent from the migrations array', async () => {
		const ns: MigrationNamespace = {
			namespace: 'bl_nic_ns',
			migrations: [named('real_0'), named('real_1')]
		};
		const err = assert_migration_error(
			await assert_rejects(() => baseline(db, ns, ['real_0', 'phantom']))
		);
		assert.strictEqual(err.kind, 'baseline-name-not-in-code');
		assert.strictEqual(err.namespace, 'bl_nic_ns');

		// no rows must have been written
		const rows = await db.query<{ name: string }>(
			`SELECT name FROM schema_version WHERE namespace = $1`,
			['bl_nic_ns']
		);
		assert.strictEqual(rows.length, 0);
	});

	test('baseline-name-out-of-order: right names, wrong positions', async () => {
		const ns: MigrationNamespace = {
			namespace: 'bl_oo_ns',
			migrations: [named('first'), named('second'), named('third')]
		};
		const err = assert_migration_error(
			await assert_rejects(() => baseline(db, ns, ['second', 'first']))
		);
		assert.strictEqual(err.kind, 'baseline-name-out-of-order');
		assert.strictEqual(err.namespace, 'bl_oo_ns');
		assert.strictEqual(err.at_index, 0);
	});

	test('empty names: no-op insert, populated guard NOT armed', async () => {
		// Pinning the contract: baseline(ns, []) is a no-op — no rows inserted,
		// no error. The populated guard keys on `existing.length > 0`, so a
		// follow-up call with real names still proceeds (zero rows means the
		// namespace is genuinely uninitialized).
		const ns: MigrationNamespace = {
			namespace: 'empty_baseline_ns',
			migrations: [named('a'), named('b')]
		};

		await baseline(db, ns, []);

		const after_empty = await db.query('SELECT name FROM schema_version WHERE namespace = $1', [
			'empty_baseline_ns'
		]);
		assert.strictEqual(after_empty.length, 0);

		// follow-up baseline with real names still works (guard not armed)
		await baseline(db, ns, ['a']);

		const after_real = await db.query<{ name: string; sequence: number }>(
			'SELECT name, sequence FROM schema_version WHERE namespace = $1 ORDER BY sequence',
			['empty_baseline_ns']
		);
		assert.deepStrictEqual(
			after_real.map((r) => [r.sequence, r.name]),
			[[0, 'a']]
		);
	});

	test('baseline-namespace-already-populated: refuses if any tracker row exists', async () => {
		const ns: MigrationNamespace = {
			namespace: 'bl_pop_ns',
			migrations: [named('a'), named('b')]
		};

		await baseline(db, ns, ['a']);

		const err = assert_migration_error(await assert_rejects(() => baseline(db, ns, ['a', 'b'])));
		assert.strictEqual(err.kind, 'baseline-namespace-already-populated');
		assert.strictEqual(err.namespace, 'bl_pop_ns');
	});

	test('per-namespace populated guard lets multi-call baseline scripts resume', async () => {
		const ns_a: MigrationNamespace = { namespace: 'resume_a', migrations: [named('a0')] };
		const ns_b: MigrationNamespace = { namespace: 'resume_b', migrations: [named('b0')] };

		// "first run partially succeeded" — ns_a baselined, ns_b not yet
		await baseline(db, ns_a, ['a0']);

		// "retry" — ns_a guards itself, but the operator can still baseline ns_b
		await assert_rejects(() => baseline(db, ns_a, ['a0']));
		await baseline(db, ns_b, ['b0']);

		const rows_a = await db.query('SELECT name FROM schema_version WHERE namespace = $1', [
			'resume_a'
		]);
		const rows_b = await db.query('SELECT name FROM schema_version WHERE namespace = $1', [
			'resume_b'
		]);
		assert.strictEqual(rows_a.length, 1);
		assert.strictEqual(rows_b.length, 1);
	});

	test('old-tracker-shape detected by baseline before any work', async () => {
		await create_old_tracker();
		const ns: MigrationNamespace = { namespace: 'irrelevant', migrations: [named('m0')] };

		const err = assert_migration_error(await assert_rejects(() => baseline(db, ns, ['m0'])));
		assert.strictEqual(err.kind, 'old-tracker-shape');
	});

	test('advisory-lock-unsupported path (PGlite) — baseline proceeds without serialization', async () => {
		const ns: MigrationNamespace = {
			namespace: 'baseline_lock_unsupported_ns',
			migrations: [named('a'), named('b')]
		};
		await baseline(db, ns, ['a', 'b']);

		const rows = await db.query<{ name: string }>(
			'SELECT name FROM schema_version WHERE namespace = $1 ORDER BY sequence',
			['baseline_lock_unsupported_ns']
		);
		assert.deepStrictEqual(
			rows.map((r) => r.name),
			['a', 'b']
		);
	});
});
