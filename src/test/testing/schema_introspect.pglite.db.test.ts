/**
 * Tests for what `query_schema_snapshot` captures of an index definition and
 * of a column's default, identity and nullability — pinned to PGlite.
 *
 * The four-driver suite in `schema_introspect.db.test.ts` cannot hold these:
 * pglet leaves sort direction, `NULLS` placement, operator classes and
 * `NULLS NOT DISTINCT` out of the `indexdef` it renders, so an index differing
 * only in one of them snapshots the same there. PGlite renders them as
 * PostgreSQL does, which is what the cross-backend parity gate compares. The
 * column cases run here only to sit beside them.
 *
 * @module
 */

import { describe, test, assert, beforeAll, afterAll, afterEach } from 'vitest';

import { AUTH_MIGRATION_NS } from '#lib/auth/migrations.ts';
import type { Db } from '#lib/db/db.ts';
import { run_migrations } from '#lib/db/migrate.ts';
import { create_pglite_factory } from '#lib/testing/db.ts';
import { query_schema_snapshot, type SchemaSnapshot } from '#lib/testing/schema_introspect.ts';
import { diff_schema_snapshots } from '#lib/testing/schema_parity.ts';

const factory = create_pglite_factory(async (db) => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
});

let db: Db;

beforeAll(async () => {
	db = await factory.create();
});

afterEach(async () => {
	await db.query('DROP TABLE IF EXISTS snapshot_probe');
});

afterAll(async () => {
	await factory.close(db);
});

/** Snapshot the schema with `snapshot_probe` rebuilt under one index statement. */
const snapshot_with_index = async (create_index: string): Promise<SchemaSnapshot> => {
	await db.query('DROP TABLE IF EXISTS snapshot_probe');
	await db.query('CREATE TABLE snapshot_probe (a INTEGER, b TEXT)');
	await db.query(create_index);
	return query_schema_snapshot(db);
};

describe('query_schema_snapshot index definitions (PGlite)', () => {
	const variants: Array<[label: string, plain: string, modified: string, rendered: RegExp]> = [
		[
			'sort direction',
			'CREATE INDEX snapshot_probe_idx ON snapshot_probe (a)',
			'CREATE INDEX snapshot_probe_idx ON snapshot_probe (a DESC)',
			/\(a DESC\)$/
		],
		[
			'operator class',
			'CREATE INDEX snapshot_probe_idx ON snapshot_probe (b)',
			'CREATE INDEX snapshot_probe_idx ON snapshot_probe (b text_pattern_ops)',
			/\(b text_pattern_ops\)$/
		],
		[
			'NULLS NOT DISTINCT',
			'CREATE UNIQUE INDEX snapshot_probe_idx ON snapshot_probe (a, b)',
			'CREATE UNIQUE INDEX snapshot_probe_idx ON snapshot_probe (a, b) NULLS NOT DISTINCT',
			/\(a, b\) NULLS NOT DISTINCT$/
		],
		[
			'NULLS placement',
			'CREATE INDEX snapshot_probe_idx ON snapshot_probe (a)',
			'CREATE INDEX snapshot_probe_idx ON snapshot_probe (a NULLS FIRST)',
			/\(a NULLS FIRST\)$/
		]
	];

	for (const [label, plain, modified, rendered] of variants) {
		test(`an index differing only in ${label} is one index_definition_differs`, async () => {
			const a = await snapshot_with_index(plain);
			const b = await snapshot_with_index(modified);
			const index = b.tables.snapshot_probe?.indexes.find((i) => i.name === 'snapshot_probe_idx');
			assert.ok(index, 'snapshot_probe_idx missing from the snapshot');
			assert.match(index.definition, rendered);

			const diffs = diff_schema_snapshots(a, b);
			assert.strictEqual(diffs.length, 1, JSON.stringify(diffs));
			const diff = diffs[0]!;
			assert.strictEqual(diff.kind, 'index_definition_differs');
			assert.deepStrictEqual(diffs, [
				{
					kind: 'index_definition_differs',
					table: 'snapshot_probe',
					index: 'snapshot_probe_idx',
					a: a.tables.snapshot_probe!.indexes[0]!.definition,
					b: index.definition
				}
			]);
		});
	}

	test('the auth schema carries its index modifiers', async () => {
		const snap = await query_schema_snapshot(db);
		const definition_of = (table: string, name: string): string | undefined =>
			snap.tables[table]?.indexes.find((i) => i.name === name)?.definition;
		assert.strictEqual(
			definition_of('audit_log', 'idx_audit_log_seq'),
			'CREATE INDEX idx_audit_log_seq ON public.audit_log USING btree (seq DESC)'
		);
		assert.strictEqual(
			definition_of('audit_log', 'idx_audit_log_metadata'),
			'CREATE INDEX idx_audit_log_metadata ON public.audit_log USING gin (metadata jsonb_path_ops)'
		);
	});
});

describe('query_schema_snapshot columns (PGlite)', () => {
	test('the auth schema carries defaults and nullability', async () => {
		const snap = await query_schema_snapshot(db);
		const account = snap.tables.account?.columns;
		assert.ok(account, 'account table missing from the snapshot');
		// `email_verified BOOLEAN NOT NULL DEFAULT false`
		assert.deepStrictEqual(account.email_verified, {
			data_type: 'boolean',
			udt_name: 'bool',
			is_nullable: false,
			column_default: 'false',
			is_identity: false
		});
		// `email TEXT`
		assert.deepStrictEqual(account.email, {
			data_type: 'text',
			udt_name: 'text',
			is_nullable: true,
			column_default: null,
			is_identity: false
		});
		assert.strictEqual(account.id!.column_default, 'gen_random_uuid()');
		assert.strictEqual(
			snap.tables.audit_log?.columns.seq?.column_default,
			"nextval('audit_log_seq_seq'::regclass)"
		);
	});

	test('an identity column is captured as one, and differs from a plain column', async () => {
		// no table in the spine declares an identity column, so the probe does
		await db.query(
			'CREATE TABLE snapshot_probe (id BIGINT GENERATED ALWAYS AS IDENTITY, n BIGINT)'
		);
		const snap = await query_schema_snapshot(db);
		const columns = snap.tables.snapshot_probe?.columns;
		assert.ok(columns, 'snapshot_probe missing from the snapshot');
		assert.deepStrictEqual(columns.id, {
			data_type: 'bigint',
			udt_name: 'int8',
			is_nullable: false,
			column_default: null,
			is_identity: true
		});
		assert.strictEqual(columns.n!.is_identity, false);
		assert.strictEqual(columns.n!.is_nullable, true);
	});
});
