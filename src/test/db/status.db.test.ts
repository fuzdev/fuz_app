/**
 * Tests for `query_db_status`'s migration name-divergence detection.
 *
 * The reader is the twin of the Rust `fuz_db::status` reader; these pin the
 * name-prefix verify (the runner's boot check) so a divergent bootstrap
 * history reports `DIVERGED` rather than `up-to-date`.
 *
 * @module
 */

import {describe, assert, test, beforeAll, beforeEach} from 'vitest';

import {Db, no_nested_transaction} from '$lib/db/db.ts';
import {run_migrations, type Migration, type MigrationNamespace} from '$lib/db/migrate.ts';
import {query_db_status, format_db_status} from '$lib/db/status.ts';
import {create_pglite_factory, reset_pglite} from '$lib/testing/db.ts';

const noop_init = async (_db: Db): Promise<void> => {};
const factory = create_pglite_factory(noop_init);
let db: Db;

beforeAll(async () => {
	db = await factory.create();
});

beforeEach(async () => {
	await reset_pglite(db);
	// `run_migrations` always creates the new-shape `schema_version` tracker
	// before its namespace loop; an empty namespace creates the table with no
	// rows so the tests below can seed divergent histories directly.
	await run_migrations(db, [{namespace: '_init', migrations: []}]);
});

const named = (name: string): Migration => ({name, up: async () => {}});

const seed_applied_row = async (
	namespace: string,
	name: string,
	sequence: number,
): Promise<void> => {
	await db.query(`INSERT INTO schema_version (namespace, name, sequence) VALUES ($1, $2, $3)`, [
		namespace,
		name,
		sequence,
	]);
};

describe('query_db_status name-divergence detection', () => {
	test('name mismatch at position 0 → DIVERGED, up_to_date false', async () => {
		// The live case: a DB bootstrapped as `cell_v0` against code that now
		// declares the descriptive `full_cell_schema`.
		await seed_applied_row('fuz_cell', 'cell_v0', 0);
		const ns: MigrationNamespace = {
			namespace: 'fuz_cell',
			migrations: [named('full_cell_schema')],
		};

		const status = await query_db_status(db, [ns]);
		const m = status.migrations.find((x) => x.namespace === 'fuz_cell')!;

		assert.strictEqual(m.up_to_date, false);
		assert.deepStrictEqual(m.divergence, {
			kind: 'name_mismatch',
			position: 0,
			applied: 'cell_v0',
			expected: 'full_cell_schema',
		});
		assert.deepStrictEqual(m.pending_names, []);

		// `format_db_status` renders DIVERGED with the detail, not up-to-date
		const formatted = format_db_status(status);
		assert.ok(formatted.includes('DIVERGED'), formatted);
		assert.ok(formatted.includes("database has 'cell_v0', code has 'full_cell_schema'"), formatted);
		assert.ok(!formatted.includes('fuz_cell: up to date'), formatted);
	});

	test('name mismatch with applied.length === code.length (overlap-end) → DIVERGED', async () => {
		// The prefix-only model's bug: same count, the last name differs. The old
		// `up_to_date = applied.length === code.length` short-circuit reported this
		// healthy; the name verify must catch it.
		await seed_applied_row('eq_ns', 'm0', 0);
		await seed_applied_row('eq_ns', 'wrong_at_end', 1);
		const ns: MigrationNamespace = {
			namespace: 'eq_ns',
			migrations: [named('m0'), named('m1')],
		};

		const status = await query_db_status(db, [ns]);
		const m = status.migrations.find((x) => x.namespace === 'eq_ns')!;

		assert.strictEqual(m.up_to_date, false);
		assert.deepStrictEqual(m.divergence, {
			kind: 'name_mismatch',
			position: 1,
			applied: 'wrong_at_end',
			expected: 'm1',
		});
		assert.deepStrictEqual(m.pending_names, []);
	});

	test('binary older: applied longer than code → binary_older divergence', async () => {
		await seed_applied_row('older_ns', 'm0', 0);
		await seed_applied_row('older_ns', 'm1', 1);
		await seed_applied_row('older_ns', 'm2_unknown', 2);
		const ns: MigrationNamespace = {
			namespace: 'older_ns',
			migrations: [named('m0'), named('m1')],
		};

		const status = await query_db_status(db, [ns]);
		const m = status.migrations.find((x) => x.namespace === 'older_ns')!;

		assert.strictEqual(m.up_to_date, false);
		assert.deepStrictEqual(m.divergence, {kind: 'binary_older', applied: 3, declared: 2});
		assert.deepStrictEqual(m.pending_names, []);

		const formatted = format_db_status(status);
		assert.ok(formatted.includes('DIVERGED'), formatted);
		assert.ok(formatted.includes('binary older than database'), formatted);
	});

	test('non-diverging full prefix → up_to_date, no divergence', async () => {
		await seed_applied_row('clean_ns', 'm0', 0);
		await seed_applied_row('clean_ns', 'm1', 1);
		const ns: MigrationNamespace = {
			namespace: 'clean_ns',
			migrations: [named('m0'), named('m1')],
		};

		const status = await query_db_status(db, [ns]);
		const m = status.migrations.find((x) => x.namespace === 'clean_ns')!;

		assert.strictEqual(m.up_to_date, true);
		assert.strictEqual(m.divergence, undefined);
		assert.deepStrictEqual(m.pending_names, []);

		const formatted = format_db_status(status);
		assert.ok(formatted.includes('clean_ns: up to date'), formatted);
	});

	test('per-namespace independence: clean + diverged in one report', async () => {
		// The live forge shape: auth clean, cell name-diverged. Divergence is
		// computed per namespace — a diverged namespace must not taint a clean
		// sibling, and one report renders both states.
		await seed_applied_row('clean_auth', 'full_auth_schema', 0);
		await seed_applied_row('diverged_cell', 'cell_v0', 0);
		const namespaces: Array<MigrationNamespace> = [
			{namespace: 'clean_auth', migrations: [named('full_auth_schema')]},
			{namespace: 'diverged_cell', migrations: [named('full_cell_schema')]},
		];

		const status = await query_db_status(db, namespaces);
		const clean = status.migrations.find((x) => x.namespace === 'clean_auth')!;
		const diverged = status.migrations.find((x) => x.namespace === 'diverged_cell')!;

		assert.strictEqual(clean.up_to_date, true);
		assert.strictEqual(clean.divergence, undefined);
		assert.strictEqual(diverged.up_to_date, false);
		assert.deepStrictEqual(diverged.divergence, {
			kind: 'name_mismatch',
			position: 0,
			applied: 'cell_v0',
			expected: 'full_cell_schema',
		});

		const formatted = format_db_status(status);
		assert.ok(formatted.includes('clean_auth: up to date'), formatted);
		assert.ok(formatted.includes('diverged_cell: DIVERGED'), formatted);
	});

	test('non-diverging partial prefix → not up_to_date, pending tail, no divergence', async () => {
		await seed_applied_row('partial_ns', 'm0', 0);
		const ns: MigrationNamespace = {
			namespace: 'partial_ns',
			migrations: [named('m0'), named('m1')],
		};

		const status = await query_db_status(db, [ns]);
		const m = status.migrations.find((x) => x.namespace === 'partial_ns')!;

		assert.strictEqual(m.up_to_date, false);
		assert.strictEqual(m.divergence, undefined);
		assert.deepStrictEqual(m.applied_names, ['m0']);
		assert.deepStrictEqual(m.pending_names, ['m1']);

		const formatted = format_db_status(status);
		assert.ok(formatted.includes('partial_ns: applied 1/2 (pending: m1)'), formatted);
	});
});

describe('query_db_status connectivity and tables', () => {
	test('connectivity failure → connected false with the error message', async () => {
		// The connectivity probe (`SELECT 1`) throwing is the not-connected signal;
		// a throwing client stub drives it without tearing down the shared PGlite.
		const failing_db = new Db({
			client: {
				query: () => {
					throw new Error('connection refused');
				},
			},
			transaction: no_nested_transaction,
		});

		const status = await query_db_status(failing_db);

		assert.strictEqual(status.connected, false);
		assert.strictEqual(status.error, 'connection refused');
		assert.strictEqual(status.table_count, 0);
		assert.deepStrictEqual(status.tables, []);
		assert.deepStrictEqual(status.migrations, []);
	});

	test('connected: lists public tables with row counts', async () => {
		await db.query('CREATE TABLE widget (id INT)');
		await db.query('INSERT INTO widget (id) VALUES (1), (2), (3)');

		const status = await query_db_status(db);

		assert.strictEqual(status.connected, true);
		assert.strictEqual(status.table_count, status.tables.length);
		const widget = status.tables.find((t) => t.name === 'widget')!;
		assert.strictEqual(widget.row_count, 3);
		// the `schema_version` tracker (created in beforeEach) is listed too
		assert.ok(
			status.tables.some((t) => t.name === 'schema_version'),
			'schema_version listed',
		);
	});

	test('no namespaces passed → migrations empty', async () => {
		const status = await query_db_status(db);
		assert.deepStrictEqual(status.migrations, []);
	});
});

describe('query_db_status tracker shape', () => {
	test('no schema_version table → namespaces report nothing applied yet', async () => {
		await db.query('DROP TABLE schema_version');
		const ns: MigrationNamespace = {namespace: 'fresh', migrations: [named('m0'), named('m1')]};

		const status = await query_db_status(db, [ns]);
		const m = status.migrations.find((x) => x.namespace === 'fresh')!;

		assert.strictEqual(status.old_tracker_shape, undefined);
		assert.deepStrictEqual(m.applied_names, []);
		assert.deepStrictEqual(m.pending_names, ['m0', 'm1']);
		assert.strictEqual(m.up_to_date, false);
		assert.strictEqual(m.divergence, undefined);
	});

	test('pre-0.42 tracker shape (version column) → old_tracker_shape flagged, nothing applied', async () => {
		await db.query('DROP TABLE schema_version');
		await db.query(`
			CREATE TABLE schema_version (
			  namespace TEXT PRIMARY KEY,
			  version INTEGER NOT NULL DEFAULT 0,
			  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);
		const ns: MigrationNamespace = {
			namespace: 'fuz_auth',
			migrations: [named('full_auth_schema')],
		};

		const status = await query_db_status(db, [ns]);
		const m = status.migrations.find((x) => x.namespace === 'fuz_auth')!;

		assert.strictEqual(status.old_tracker_shape, true);
		// the old shape is never name-read, so every namespace shows nothing-applied
		assert.deepStrictEqual(m.applied_names, []);
		assert.deepStrictEqual(m.pending_names, ['full_auth_schema']);
		assert.strictEqual(m.up_to_date, false);
		assert.strictEqual(m.divergence, undefined);
	});
});

describe('format_db_status', () => {
	test('not connected → renders Connection: FAILED with the error', () => {
		const out = format_db_status({
			connected: false,
			error: 'connection refused',
			table_count: 0,
			tables: [],
			migrations: [],
		});
		assert.ok(out.includes('Connection: FAILED'), out);
		assert.ok(out.includes('connection refused'), out);
	});

	test('connected → renders OK, table count, per-table rows, and no Migrations section when empty', () => {
		const out = format_db_status({
			connected: true,
			table_count: 1,
			tables: [{name: 'widget', row_count: 3}],
			migrations: [],
		});
		assert.ok(out.includes('Connection: OK'), out);
		assert.ok(out.includes('Tables: 1'), out);
		assert.ok(out.includes('widget'), out);
		assert.ok(out.includes('3 rows'), out);
		assert.ok(!out.includes('Migrations:'), out);
	});

	test('old_tracker_shape → renders the pre-0.42 remediation hint', () => {
		const out = format_db_status({
			connected: true,
			table_count: 1,
			tables: [{name: 'schema_version', row_count: 0}],
			migrations: [],
			old_tracker_shape: true,
		});
		assert.ok(out.includes('pre-0.42 schema_version shape'), out);
	});
});
