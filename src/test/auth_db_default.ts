/**
 * The single-driver auth database fixture: `describe_db` over the default
 * factory (`create_default_db_factory` — pglet-wasm, or whatever
 * `FUZ_TEST_DB_DEFAULT` installs) with the `fuz_auth` namespace migrated and
 * the auth + `audit_log` tables truncated between tests. For suites that need
 * one database rather than the four-driver run of ./db_fixture.ts.
 *
 * @module
 */

import { AUTH_MIGRATION_NS } from '#lib/auth/migrations.ts';
import { run_migrations } from '#lib/db/migrate.ts';
import {
	auth_integration_truncate_tables,
	create_default_db_factory,
	create_describe_db
} from '#lib/testing/db.ts';

const factory = create_default_db_factory(async (db) => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
});

/**
 * `describe_db` bound to the default-driver auth factory + the auth truncate
 * list. Use as the outer `describe_db(name, (get_db) => {...})` wrapper.
 */
export const describe_db = create_describe_db(factory, auth_integration_truncate_tables);
