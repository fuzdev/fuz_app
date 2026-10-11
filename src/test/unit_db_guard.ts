/**
 * Refuses the default database factory in the `unit` project, so a test that
 * opens a database without the `.db.test.ts` suffix fails loudly instead of
 * starting its own WASM instance in a parallel worker — where
 * `FUZ_TEST_DB_DEFAULT` (`db_default.ts`, the `db` project's setup) never
 * reaches it.
 *
 * Wired as the `unit` project's `setupFiles` in `vite.config.ts`. The installed
 * builder returns a factory rather than throwing itself: modules build default
 * factories at import (`testing/app_server.ts`'s no-`db` fallback), and a unit
 * test may import them without ever opening a database. Only `create()` refuses.
 *
 * @module
 */

import { set_default_db_factory } from '#lib/testing/db.ts';

set_default_db_factory(() => ({
	name: 'unit-refused',
	skip: false,
	create: () =>
		Promise.reject(
			new Error(
				'a database was opened from the `unit` project — name the test file `*.db.test.ts` so it runs in the `db` project'
			)
		),
	close: () => Promise.resolve()
}));
