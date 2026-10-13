/**
 * DB-backed tests for `query_schema_snapshot`, over the four-driver fixture
 * (pglite, pg, pglet native wire, pglet-wasm) so the introspection queries the
 * cross-backend parity gate depends on are exercised on every backend the
 * matrix runs, not only pglite.
 *
 * Verifies the snapshot's structural contract (schema_version migration
 * tracker excluded from `tables`, deterministic across calls,
 * JSON-serializable) and pins
 * the SERIAL→BIGSERIAL widening on `audit_log.seq` — a regression on
 * that fix would surface immediately here instead of waiting for zzz's
 * cross-impl gate to catch it.
 *
 * These cases read tables, columns, constraints, sequences and enums off the
 * snapshot and compare no index definition across engines, so they take it
 * through `snapshot`, which passes `accept_pglet_index_definitions` — the
 * opt-in a pglet snapshot holding indexes needs. The refusal itself is pinned
 * at the end, per driver.
 *
 * @module
 */

import { test, assert } from 'vitest';

import {
	query_schema_snapshot,
	type QuerySchemaSnapshotOptions,
	type SchemaSnapshot
} from '#lib/testing/schema_introspect.ts';
import { diff_schema_snapshots } from '#lib/testing/schema_parity.ts';
import { create_testing_schema_snapshot_action } from '#lib/testing/cross_backend/testing_reset_actions.ts';
import { create_test_request_context } from '#lib/testing/auth_apps.ts';
import type { Db } from '#lib/db/db.ts';

import { create_test_action_context } from '../auth/rpc_test_helpers.ts';
import { describe_db } from '../db_fixture.ts';
import { describe_db as describe_cell_db } from '../cell_db_fixture.ts';

/** `query_schema_snapshot` for a case that compares no index definition. */
const snapshot = (db: Db, options?: QuerySchemaSnapshotOptions): Promise<SchemaSnapshot> =>
	query_schema_snapshot(db, { ...options, accept_pglet_index_definitions: true });

/** Whether `db` is pglet — its `version()` says so. */
const is_pglet = async (db: Db): Promise<boolean> => {
	const [row] = await db.query<{ version: string }>(`SELECT version() AS version`);
	return row!.version.includes('(pglet)');
};

describe_db('query_schema_snapshot', (get_db) => {
	test('audit_log.seq is int8 (BIGSERIAL widening regression guard)', async () => {
		const snap = await snapshot(get_db());
		const seq_col = snap.tables.audit_log?.columns.seq;
		assert.ok(seq_col, 'audit_log.seq column missing from snapshot');
		assert.strictEqual(seq_col.udt_name, 'int8');
		assert.strictEqual(seq_col.data_type, 'bigint');
	});

	test('audit_log_seq_seq sequence data_type is bigint', async () => {
		const snap = await snapshot(get_db());
		const seq = snap.sequences.audit_log_seq_seq;
		assert.ok(seq, 'audit_log_seq_seq sequence missing from snapshot');
		assert.strictEqual(seq.data_type, 'bigint');
	});

	test('schema_version table is never present in `tables`', async () => {
		const snap = await snapshot(get_db());
		assert.strictEqual(snap.tables.schema_version, undefined);
	});

	test('snapshot is deterministic across consecutive calls', async () => {
		const a = await snapshot(get_db());
		const b = await snapshot(get_db());
		assert.deepStrictEqual(a, b);
	});

	test('snapshot is JSON-serializable and round-trips deep-equal', async () => {
		const a = await snapshot(get_db());
		const round_trip = JSON.parse(JSON.stringify(a));
		assert.deepStrictEqual(round_trip, a);
	});

	test('exclude_tables removes the named tables from the snapshot', async () => {
		const full = await snapshot(get_db());
		assert.ok(full.tables.audit_log, 'audit_log expected present without exclude');
		const filtered = await snapshot(get_db(), { exclude_tables: ['audit_log'] });
		assert.strictEqual(filtered.tables.audit_log, undefined);
		// Other tables remain
		assert.ok(filtered.tables.account, 'account table should still be present');
	});

	test('table-name keys and column-name keys are sorted', async () => {
		const snap = await snapshot(get_db());
		const table_keys = Object.keys(snap.tables);
		assert.deepStrictEqual([...table_keys].sort(), table_keys);
		for (const table of Object.values(snap.tables)) {
			const col_keys = Object.keys(table.columns);
			assert.deepStrictEqual([...col_keys].sort(), col_keys);
		}
	});

	test('CHECK constraints are captured (role_grant_scope_kind_paired regression guard)', async () => {
		// The v1 migration adds this CHECK via a `DO $$ ... END $$` idempotent
		// block. Introspection silently dropping CHECKs (e.g. a `contype` switch
		// regression) would slip through column/index-only tests.
		const snap = await snapshot(get_db());
		const role_grant = snap.tables.role_grant;
		assert.ok(role_grant, 'role_grant table missing');
		const paired = role_grant.constraints.find((c) => c.name === 'role_grant_scope_kind_paired');
		assert.ok(paired, 'role_grant_scope_kind_paired constraint missing from snapshot');
		assert.strictEqual(paired.type, 'CHECK');
		assert.match(paired.definition, /scope_kind/);
		assert.match(paired.definition, /scope_id/);
	});

	test('a real snapshot self-diffs to zero (introspect ↔ parity smoke)', async () => {
		const snap = await snapshot(get_db());
		assert.deepStrictEqual(diff_schema_snapshots(snap, snap), []);
	});

	test('auth-only schema captures no enum types', async () => {
		const snap = await snapshot(get_db());
		assert.deepStrictEqual(snap.enums, {});
	});

	// pglet's `indexdef` omits index modifiers, so its index definitions are
	// no basis for a comparison: refused there unless the caller opts in.
	test('a snapshot holding indexes is refused on pglet, and taken everywhere else', async () => {
		const db = get_db();
		if (await is_pglet(db)) {
			const error = await query_schema_snapshot(db).then(
				() => null,
				(err: unknown) => err
			);
			assert.ok(error instanceof Error, 'a pglet snapshot holding indexes must be refused');
			assert.match(error.message, /pglet/);
			assert.match(error.message, /accept_pglet_index_definitions/);
			return;
		}
		const snap = await query_schema_snapshot(db);
		assert.ok(
			Object.values(snap.tables).some((table) => table.indexes.length > 0),
			'the auth schema has indexes, so this snapshot exercises the check'
		);
	});

	// The action is how a cross-backend parity gate takes a backend's snapshot,
	// so it must refuse where the function does — never opt in on the caller's
	// behalf.
	test('the _testing_schema_snapshot action refuses on pglet as the function does', async () => {
		const db = get_db();
		const { handler } = create_testing_schema_snapshot_action();
		const result = await Promise.resolve(
			handler({}, { ...create_test_action_context(create_test_request_context()), db })
		).then(
			(value: unknown) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error })
		);
		if (await is_pglet(db)) {
			assert.ok(!result.ok, 'the action must refuse a pglet snapshot holding indexes');
			assert.ok(result.error instanceof Error);
			assert.match(result.error.message, /accept_pglet_index_definitions/);
			return;
		}
		assert.ok(result.ok, 'the action answers on every other driver');
	});

	test('the opt-in takes the snapshot on every driver, indexes included', async () => {
		const snap = await query_schema_snapshot(get_db(), { accept_pglet_index_definitions: true });
		assert.ok(snap.tables.audit_log!.indexes.length > 0);
	});

	test('a snapshot holding no index needs no opt-in on any driver', async () => {
		const db = get_db();
		await db.query(`CREATE TABLE schema_introspect_no_index (label TEXT)`);
		try {
			const everything = await snapshot(db);
			const snap = await query_schema_snapshot(db, {
				exclude_tables: Object.keys(everything.tables).filter(
					(name) => name !== 'schema_introspect_no_index'
				)
			});
			assert.deepStrictEqual(Object.keys(snap.tables), ['schema_introspect_no_index']);
			assert.deepStrictEqual(snap.tables.schema_introspect_no_index!.indexes, []);
		} finally {
			await db.query(`DROP TABLE schema_introspect_no_index`);
		}
	});
});

// The full-spine fixture migrates the cell namespace too — the auth schema has
// no enum types, so capturing `cell_visibility` is the live end-to-end check.
describe_cell_db('query_schema_snapshot enum capture', (get_db) => {
	test('captures the cell_visibility enum with labels in declared order', async () => {
		const snap = await snapshot(get_db());
		const cv = snap.enums.cell_visibility;
		assert.ok(cv, 'cell_visibility enum missing from snapshot');
		// Declaration order matters — `enumsortorder`, not alphabetical.
		assert.deepStrictEqual(cv.labels, ['private', 'public']);
	});

	test('enum keys are sorted and the snapshot round-trips deep-equal', async () => {
		const snap = await snapshot(get_db());
		const enum_keys = Object.keys(snap.enums);
		assert.deepStrictEqual([...enum_keys].sort(), enum_keys);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(snap)).enums, snap.enums);
	});
});
