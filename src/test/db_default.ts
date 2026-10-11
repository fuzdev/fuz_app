/**
 * Installs the driver `create_default_db_factory` hands out across the `db`
 * project, so the suites written against the default (pglet-wasm) also run
 * against PGlite or the native pglet server.
 *
 * Wired as the `db` project's `setupFiles` in `vite.config.ts`. That scoping is
 * load-bearing: the `unit` project runs its files across parallel workers, and a
 * process-wide switch would give each worker its own backing instance.
 *
 * `FUZ_TEST_DB_DEFAULT` selects the driver — `pglet-wasm` (the default when
 * unset), `pglite`, or `pglet-server` with `PGLET_SERVER_BIN` naming a built
 * `pglet_server` binary:
 *
 *   FUZ_TEST_DB_DEFAULT=pglite npx vitest run --project db
 *   FUZ_TEST_DB_DEFAULT=pglet-server PGLET_SERVER_BIN=... npx vitest run --project db
 *
 * It decides only the default factory. `PGLET_SERVER_BIN` and
 * `TEST_DATABASE_URL` on their own decide something else — they un-skip the
 * four-driver fixture's `pglet-server` and `pg` legs. An unrecognized value, or
 * `pglet-server` without its binary, throws rather than quietly running
 * pglet-wasm under another label.
 *
 * A `setupFiles` entry is re-imported per test file, so this module's top level
 * runs once per `.db.test.ts` file rather than once per run. The install is
 * idempotent and the modules it imports are loaded once for the run, so the
 * installed driver's shared server / wasm instance is still one for the run;
 * only the banner is worth de-duplicating, and a flag outside this module is
 * what survives the re-import.
 *
 * @module
 */

import {
	create_pglet_wasm_factory,
	create_pglite_factory,
	set_default_db_factory,
	type DbFactoryBuilder
} from '#lib/testing/db.ts';
import { create_pglet_server_factory } from './db_pglet_server_factory.ts';

/** A selectable default driver: its factory builder and the env var naming its artifact, if any. */
interface DbDefault {
	build: DbFactoryBuilder;
	env_var: string | null;
}

const DB_DEFAULTS: Record<string, DbDefault> = {
	'pglet-wasm': { build: create_pglet_wasm_factory, env_var: null },
	pglite: { build: create_pglite_factory, env_var: null },
	'pglet-server': { build: create_pglet_server_factory, env_var: 'PGLET_SERVER_BIN' }
};

/** Global key marking the banner as printed — a module-level flag would not survive the re-import. */
const BANNER_FLAG = '__fuz_db_default_banner';

const selected = process.env.FUZ_TEST_DB_DEFAULT || 'pglet-wasm';
const db_default = DB_DEFAULTS[selected];
if (!db_default) {
	throw new Error(
		`FUZ_TEST_DB_DEFAULT="${selected}" is not a known driver; expected one of: ${Object.keys(
			DB_DEFAULTS
		).join(', ')}`
	);
}
if (db_default.env_var && !process.env[db_default.env_var]) {
	throw new Error(`FUZ_TEST_DB_DEFAULT="${selected}" requires ${db_default.env_var} to be set.`);
}
set_default_db_factory(db_default.build);
const globals = globalThis as Record<string, unknown>;
if (!globals[BANNER_FLAG]) {
	globals[BANNER_FLAG] = true;
	console.log(`[db tests] default driver: ${selected}`);
}
