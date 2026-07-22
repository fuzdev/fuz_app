/**
 * Schema-readiness mechanism test + committed auth column-map fixture.
 *
 * Bootstraps the auth migration chain on a fresh PGlite and exercises the
 * `/ready` probe core (`db/schema_ready.ts`): the committed
 * `expected_auth_schema.json` matches a fresh bootstrap (regen with
 * `UPDATE_SCHEMA_READY=1`, so the fixture can't drift from the DDLs), the
 * column query keeps the `schema_version` tracker (so a never-migrated DB fails
 * readiness), and `check_schema_drift` flags missing columns / tables.
 *
 * The committed `expected_auth_schema.json` is the canonical auth column map —
 * the column-presence set a deployed auth DB must cover.
 *
 * @module
 */

import { describe, test, assert, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import type { Db } from '$lib/db/db.ts';
import { create_pglite_db } from '$lib/db/db_pglite.ts';
import { run_migrations } from '$lib/db/migrate.ts';
import { auth_migration_ns } from '$lib/auth/migrations.ts';
import { check_schema_drift, query_public_columns } from '$lib/db/schema_ready.ts';
import { create_ready_route_spec } from '$lib/http/common_routes.ts';
import { sync_expected_schema_fixture } from '$lib/testing/schema_ready_fixture.ts';

const FIXTURE_URL = new URL('./expected_auth_schema.json', import.meta.url);

let db: Db;
let close_db: () => Promise<void>;

beforeAll(async () => {
	const driver = create_pglite_db(new PGlite());
	db = driver.db;
	close_db = driver.close;
	await run_migrations(db, [auth_migration_ns]);
});

afterAll(async () => {
	await close_db?.();
});

describe('schema_ready', () => {
	test('committed expected_auth_schema.json matches a fresh auth bootstrap', async () => {
		const { live, committed } = await sync_expected_schema_fixture({
			db,
			fixture_url: FIXTURE_URL,
			update: process.env.UPDATE_SCHEMA_READY === '1'
		});
		assert.deepEqual(live, committed);
	});

	test('query_public_columns keeps the schema_version migration tracker', async () => {
		const live = await query_public_columns(db);
		// Unlike query_schema_snapshot, readiness keeps schema_version so a
		// never-migrated DB correctly fails the drift check.
		assert.ok(live.schema_version, 'schema_version table present in the live column map');
	});

	test('check_schema_drift passes against the live schema', async () => {
		const live = await query_public_columns(db);
		const drift = await check_schema_drift(db, live);
		assert.ok(drift.ok);
		assert.deepEqual(drift.missing_tables, []);
		assert.deepEqual(drift.missing_columns, []);
	});

	test('check_schema_drift flags a missing column', async () => {
		const drift = await check_schema_drift(db, {
			account: ['id', 'deleted_at', 'nonexistent_col']
		});
		assert.ok(!drift.ok);
		assert.deepEqual(drift.missing_columns, [{ table: 'account', columns: ['nonexistent_col'] }]);
		assert.deepEqual(drift.missing_tables, []);
	});

	test('check_schema_drift flags a missing table', async () => {
		const drift = await check_schema_drift(db, { nonexistent_table: ['id'] });
		assert.ok(!drift.ok);
		assert.deepEqual(drift.missing_tables, ['nonexistent_table']);
	});

	test('check_schema_drift ignores extra live columns (forward-compatible)', async () => {
		// Expect only a subset — extra live columns must not fail readiness.
		const drift = await check_schema_drift(db, { account: ['id', 'username'] });
		assert.ok(drift.ok);
	});

	test('create_ready_route_spec throws on an empty expected map (fail-loud, no silent pass)', () => {
		// An empty expectation would answer 200 for any live DB, silently
		// disabling the gate — catch the misconfiguration at assembly, not in prod.
		assert.throws(() => create_ready_route_spec({ expected: {} }), /empty/);
	});
});
