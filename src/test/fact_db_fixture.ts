/**
 * Fact database test fixture: `describe_db` over all four drivers with the
 * auth namespace (`fact_holder` FKs into `actor`) then the `fuz_facts`
 * namespace migrated, and the fact + auth tables truncated between tests.
 * Sibling of the auth-only ./db_fixture.ts and the full-spine
 * ./cell_db_fixture.ts; shared by the `PgFactStore` suites so each run pays
 * one wasm base migration, not one per file.
 *
 * @module
 */

import { auth_integration_truncate_tables } from '#lib/testing/db.ts';
import { auth_migration_ns } from '#lib/auth/migrations.ts';
import { FACT_MIGRATION_NS, FACT_DROP_TABLES } from '#lib/db/fact_ddl.ts';
import { create_db_fixture } from './create_db_fixture.ts';

export const { describe_db } = create_db_fixture(
	[auth_migration_ns, FACT_MIGRATION_NS],
	[...FACT_DROP_TABLES, ...auth_integration_truncate_tables]
);
