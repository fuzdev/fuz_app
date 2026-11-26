/**
 * The `unit` project's `setupFiles` entry (`vite.config.ts`): refuses the
 * default database factory (`install_unit_db_guard`), so a test that opens a
 * database without the `.db.test.ts` suffix fails loudly — `FUZ_TEST_DB_DEFAULT`
 * (`db_default.ts`, the `db` project's setup) never reaches it.
 *
 * @module
 */

import { install_unit_db_guard } from '#lib/testing/db.ts';

install_unit_db_guard();
