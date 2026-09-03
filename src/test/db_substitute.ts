/**
 * Installs the driver that stands in for `create_pglite_factory` across the
 * `db` project, so the suites written against PGlite also run against pglet.
 *
 * Wired as the `db` project's `setupFiles` in `vite.config.ts`. That scoping is
 * load-bearing: the `unit` project runs its files across parallel workers, and a
 * process-wide switch would give each worker its own backing instance.
 *
 * `FUZ_TEST_DB_SUBSTITUTE` selects the leg, and the leg's own env var supplies
 * the artifact — `PGLET_SERVER_BIN` (a built `pglet_server` binary) for the
 * native wire leg, `PGLET_WASM_PKG` (a built npm package directory) for the
 * in-process wasm one:
 *
 *   FUZ_TEST_DB_SUBSTITUTE=pglet PGLET_SERVER_BIN=... npx vitest run --project db
 *   FUZ_TEST_DB_SUBSTITUTE=pglet-wasm PGLET_WASM_PKG=... npx vitest run --project db
 *
 * With `FUZ_TEST_DB_SUBSTITUTE` unset nothing is installed, so every
 * `create_pglite_factory` call site stays PGlite — including when the pglet env
 * vars are set, which install no stand-in but do un-skip the four-driver
 * fixture's own pglet legs, making that run the four-driver matrix rather than a
 * PGlite-only one. An unrecognized value, or a selected leg whose artifact var
 * is unset, throws rather than quietly running PGlite under a pglet label.
 *
 * A `setupFiles` entry is re-imported per test file, so this module's top level
 * runs once per `.db.test.ts` file rather than once per run. The install is
 * idempotent and the modules it imports are loaded once for the run, so the
 * stand-in's shared server / wasm instance is still one for the run; only the
 * banner is worth de-duplicating, and a flag outside this module is what
 * survives the re-import.
 *
 * @module
 */

import { set_substitute_db_factory, type DbFactoryBuilder } from '$lib/testing/db.ts';
import { create_pglet_shared_factory } from './db_pglet_factory.ts';
import { create_pglet_wasm_shared_factory } from './db_pglet_wasm_factory.ts';

/** A selectable stand-in driver: its factory builder and the env var naming its artifact. */
interface DbSubstitute {
	build: DbFactoryBuilder;
	env_var: string;
}

const DB_SUBSTITUTES: Record<string, DbSubstitute> = {
	pglet: { build: create_pglet_shared_factory, env_var: 'PGLET_SERVER_BIN' },
	'pglet-wasm': { build: create_pglet_wasm_shared_factory, env_var: 'PGLET_WASM_PKG' }
};

/** Global key marking the banner as printed — a module-level flag would not survive the re-import. */
const BANNER_FLAG = '__fuz_db_substitute_banner';

const selected = process.env.FUZ_TEST_DB_SUBSTITUTE;
if (selected) {
	const substitute = DB_SUBSTITUTES[selected];
	if (!substitute) {
		throw new Error(
			`FUZ_TEST_DB_SUBSTITUTE="${selected}" is not a known driver; expected one of: ${Object.keys(
				DB_SUBSTITUTES
			).join(', ')}`
		);
	}
	if (!process.env[substitute.env_var]) {
		throw new Error(
			`FUZ_TEST_DB_SUBSTITUTE="${selected}" requires ${substitute.env_var} to be set.`
		);
	}
	set_substitute_db_factory(substitute.build);
	const globals = globalThis as Record<string, unknown>;
	if (!globals[BANNER_FLAG]) {
		globals[BANNER_FLAG] = true;
		console.log(`[db tests] substituting "${selected}" for the pglite factory`);
	}
}
