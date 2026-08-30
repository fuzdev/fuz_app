/**
 * Fact-only database test fixture: `describe_db` over all four drivers with
 * just the `fuz_facts` namespace migrated and the fact tables truncated
 * between tests. Sibling of the auth-only ./db_fixture.ts and the full-spine
 * ./cell_db_fixture.ts; shared by the `PgFactStore` suites so each run pays
 * one pglet spawn + one wasm base migration, not one per file.
 *
 * @module
 */

import { FACT_MIGRATION_NS, FACT_DROP_TABLES } from '$lib/db/fact_ddl.ts';
import { create_db_fixture } from './create_db_fixture.ts';

export const { describe_db } = create_db_fixture([FACT_MIGRATION_NS], [...FACT_DROP_TABLES]);
