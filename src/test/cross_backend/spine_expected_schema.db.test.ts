/**
 * Regen + drift guard for the committed spine `expected_schema.json` — the
 * column map the `/ready` deploy gate introspects against on **both** spine
 * test servers.
 *
 * Bootstraps the full spine migration set (auth + cell + cell_history + fact)
 * on a fresh PGlite and asserts the committed fixture
 * (`$lib/testing/cross_backend/expected_schema.json`) equals what that bootstrap
 * produces, so the runtime expectation can't silently fall behind the DDLs.
 * Regenerate with `UPDATE_SCHEMA_READY=1`, then `gro format` (the writer emits
 * raw `JSON.stringify`; Prettier collapses short arrays inline).
 *
 * One fixture serves both backends: the `schema_parity.cross` gate already
 * proves the TS spine ≡ `testing_spine_stub` on exactly this namespace set, and
 * column-presence is engine-portable, so the column map a PGlite bootstrap
 * produces is byte-identical to a live Postgres bootstrap of the same chain.
 *
 * @module
 */

import { describe, test, assert, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import type { Db } from '$lib/db/db.ts';
import { create_pglite_db } from '$lib/db/db_pglite.ts';
import { run_migrations } from '$lib/db/migrate.ts';
import { auth_migration_ns } from '$lib/auth/migrations.ts';
import { CELL_MIGRATION_NS } from '$lib/db/cell_ddl.ts';
import { CELL_HISTORY_MIGRATION_NS } from '$lib/db/cell_history_ddl.ts';
import { FACT_MIGRATION_NS } from '$lib/db/fact_ddl.ts';
import { sync_expected_schema_fixture } from '$lib/testing/schema_ready_fixture.ts';

// The committed fixture loaded at runtime by `create_spine_ready_route_spec`
// (TS) and the Rust `testing_spine_stub`'s `/ready` (via the env-supplied path).
const FIXTURE_URL = new URL(
	'../../lib/testing/cross_backend/expected_schema.json',
	import.meta.url
);

let db: Db;
let close_db: () => Promise<void>;

beforeAll(async () => {
	const driver = create_pglite_db(new PGlite());
	db = driver.db;
	close_db = driver.close;
	// Same namespace set + order the TS spine binary (`build_spine_app`) and the
	// Rust stub (`run_app`) bootstrap, so the introspected columns match both.
	await run_migrations(db, [
		auth_migration_ns,
		CELL_MIGRATION_NS,
		CELL_HISTORY_MIGRATION_NS,
		FACT_MIGRATION_NS
	]);
});

afterAll(async () => {
	await close_db?.();
});

describe('spine expected_schema fixture', () => {
	test('committed expected_schema.json matches a fresh full spine bootstrap', async () => {
		const { live, committed } = await sync_expected_schema_fixture({
			db,
			fixture_url: FIXTURE_URL,
			update: process.env.UPDATE_SCHEMA_READY === '1'
		});
		assert.deepEqual(live, committed);
	});
});
