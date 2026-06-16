/**
 * DB-backed tests for `query_schema_snapshot`.
 *
 * Verifies the snapshot's structural contract (schema_version migration
 * tracker excluded from `tables`, deterministic across calls,
 * JSON-serializable) and pins
 * the SERIAL→BIGSERIAL widening on `audit_log.seq` — a regression on
 * that fix would surface immediately here instead of waiting for zzz's
 * cross-impl gate to catch it.
 *
 * @module
 */

import {describe, test, assert, beforeAll} from 'vitest';

import type {Db} from '$lib/db/db.ts';
import {run_migrations} from '$lib/db/migrate.ts';
import {auth_migration_ns} from '$lib/auth/migrations.ts';
import {CELL_MIGRATION_NS} from '$lib/db/cell_ddl.ts';
import {create_pglite_factory} from '$lib/testing/db.ts';
import {query_schema_snapshot} from '$lib/testing/schema_introspect.ts';
import {diff_schema_snapshots} from '$lib/testing/schema_parity.ts';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};
const factory = create_pglite_factory(init_schema);
let db: Db;

beforeAll(async () => {
	db = await factory.create();
});

// Separate factory migrating the cell namespace too — the auth schema has no
// enum types, so capturing `cell_visibility` is the live end-to-end check.
const cell_factory = create_pglite_factory(async (cell_db: Db): Promise<void> => {
	await run_migrations(cell_db, [auth_migration_ns, CELL_MIGRATION_NS]);
});

describe('query_schema_snapshot', () => {
	test('audit_log.seq is int8 (BIGSERIAL widening regression guard)', async () => {
		const snap = await query_schema_snapshot(db);
		const seq_col = snap.tables.audit_log?.columns.seq;
		assert.ok(seq_col, 'audit_log.seq column missing from snapshot');
		assert.strictEqual(seq_col.udt_name, 'int8');
		assert.strictEqual(seq_col.data_type, 'bigint');
	});

	test('audit_log_seq_seq sequence data_type is bigint', async () => {
		const snap = await query_schema_snapshot(db);
		const seq = snap.sequences.audit_log_seq_seq;
		assert.ok(seq, 'audit_log_seq_seq sequence missing from snapshot');
		assert.strictEqual(seq.data_type, 'bigint');
	});

	test('schema_version table is never present in `tables`', async () => {
		const snap = await query_schema_snapshot(db);
		assert.strictEqual(snap.tables.schema_version, undefined);
	});

	test('snapshot is deterministic across consecutive calls', async () => {
		const a = await query_schema_snapshot(db);
		const b = await query_schema_snapshot(db);
		assert.deepStrictEqual(a, b);
	});

	test('snapshot is JSON-serializable and round-trips deep-equal', async () => {
		const a = await query_schema_snapshot(db);
		const round_trip = JSON.parse(JSON.stringify(a));
		assert.deepStrictEqual(round_trip, a);
	});

	test('exclude_tables removes the named tables from the snapshot', async () => {
		const full = await query_schema_snapshot(db);
		assert.ok(full.tables.audit_log, 'audit_log expected present without exclude');
		const filtered = await query_schema_snapshot(db, {exclude_tables: ['audit_log']});
		assert.strictEqual(filtered.tables.audit_log, undefined);
		// Other tables remain
		assert.ok(filtered.tables.account, 'account table should still be present');
	});

	test('table-name keys and column-name keys are sorted', async () => {
		const snap = await query_schema_snapshot(db);
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
		const snap = await query_schema_snapshot(db);
		const role_grant = snap.tables.role_grant;
		assert.ok(role_grant, 'role_grant table missing');
		const paired = role_grant.constraints.find((c) => c.name === 'role_grant_scope_kind_paired');
		assert.ok(paired, 'role_grant_scope_kind_paired constraint missing from snapshot');
		assert.strictEqual(paired.type, 'CHECK');
		assert.match(paired.definition, /scope_kind/);
		assert.match(paired.definition, /scope_id/);
	});

	test('a real snapshot self-diffs to zero (introspect ↔ parity smoke)', async () => {
		const snap = await query_schema_snapshot(db);
		assert.deepStrictEqual(diff_schema_snapshots(snap, snap), []);
	});

	test('auth-only schema captures no enum types', async () => {
		const snap = await query_schema_snapshot(db);
		assert.deepStrictEqual(snap.enums, {});
	});
});

describe('query_schema_snapshot enum capture', () => {
	let cell_db: Db;
	beforeAll(async () => {
		cell_db = await cell_factory.create();
	});

	test('captures the cell_visibility enum with labels in declared order', async () => {
		const snap = await query_schema_snapshot(cell_db);
		const cv = snap.enums.cell_visibility;
		assert.ok(cv, 'cell_visibility enum missing from snapshot');
		// Declaration order matters — `enumsortorder`, not alphabetical.
		assert.deepStrictEqual(cv.labels, ['private', 'public']);
	});

	test('enum keys are sorted and the snapshot round-trips deep-equal', async () => {
		const snap = await query_schema_snapshot(cell_db);
		const enum_keys = Object.keys(snap.enums);
		assert.deepStrictEqual([...enum_keys].sort(), enum_keys);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(snap)).enums, snap.enums);
	});
});
