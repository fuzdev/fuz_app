/**
 * The auth-only database test fixture most suites use: `describe_db` over all
 * four drivers with the `fuz_auth` namespace migrated and the auth +
 * `audit_log` tables truncated between tests. Built by
 * ./create_db_fixture.ts; the full-spine sibling is ./cell_db_fixture.ts and
 * the fact-only one ./fact_db_fixture.ts.
 *
 * @module
 */

import { auth_migration_ns } from '$lib/auth/migrations.ts';
import { auth_integration_truncate_tables } from '$lib/testing/db.ts';
import { create_db_fixture } from './create_db_fixture.ts';

export const { pglite_factory, pg_factory, db_factories, describe_db } = create_db_fixture(
	[auth_migration_ns],
	auth_integration_truncate_tables
);
