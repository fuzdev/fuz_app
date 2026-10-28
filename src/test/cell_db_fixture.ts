/**
 * Full-spine database test fixture: `describe_db` over all four drivers with
 * the auth + cell + fact namespaces migrated. Truncates the
 * cell + fact tables (children first) plus the auth integration tables
 * (incl. `audit_log`) between tests. Sibling of the auth-only ./db_fixture.ts;
 * the cell RPC scaffolding that rides on top is ./auth/cell_test_helpers.ts.
 *
 * @module
 */

import { auth_integration_truncate_tables } from '#lib/testing/db.ts';
import { AUTH_MIGRATION_NS } from '#lib/auth/migrations.ts';
import { CELL_MIGRATION_NS, CELL_DROP_TABLES } from '#lib/db/cell_ddl.ts';
import { FACT_MIGRATION_NS, FACT_DROP_TABLES } from '#lib/db/fact_ddl.ts';
import { create_db_fixture } from './create_db_fixture.ts';

export const { describe_db, pg_factory } = create_db_fixture(
	[AUTH_MIGRATION_NS, CELL_MIGRATION_NS, FACT_MIGRATION_NS],
	[...CELL_DROP_TABLES, ...FACT_DROP_TABLES, ...auth_integration_truncate_tables]
);
