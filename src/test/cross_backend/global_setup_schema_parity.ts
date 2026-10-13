/**
 * Vitest `globalSetup` for the `cross_backend_parity` project — spawns +
 * bootstraps BOTH backends in one run (the TS spine on Node as `a`, the Rust
 * `testing_spine_stub` as `b`, each over its own database on one real Postgres
 * server) and provides both serialized handles, so both parity gates that run
 * under this project — `schema_parity.cross.test.ts` (live DDL) and
 * `action_manifest_parity.cross.test.ts` (live RPC method set + auth) — can
 * capture each backend and diff. One dual-spawn serves both.
 *
 * **Both legs run on Postgres.** The schema snapshot compares index
 * definitions as the engine renders them (`pg_indexes.indexdef`), and pglet —
 * the TS spine's `memory://` default — renders an index without its per-key
 * sort direction, `NULLS` placement, operator classes or `NULLS NOT DISTINCT`.
 * On one engine, a diff can only be DDL drift. So this project alone gives the
 * TS spine a `postgres://` URL: `TS_SPINE_PARITY_DATABASE` on the server the
 * stub's URL names (`FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL`, else the
 * local default), which keeps the two legs on one server version.
 *
 * The single-backend `global_setup_*.ts` makers derive one backend per
 * project; these gates need both alive at once. Each side is prepared before
 * the dual spawn. The Rust side is made current (rebuild + `createdb`) via
 * `prepare_rust_spine_backend`, the same prerequisite the single-backend
 * `cross_backend_rust_spine_stub` project runs; the stub wipes its own
 * database at startup. The TS spine binary does not, and bootstrap refuses a
 * database that already holds an account, so its database is created when
 * missing — on the server its URL names, not the one the libpq environment
 * does — and its `public` schema dropped and recreated here on every run. A
 * server that cannot be reached, a role that cannot connect, or a database
 * that cannot be created or emptied fails the project with what to check —
 * the gate never skips.
 *
 * @module
 */

import { create_dual_spawn_global_setup } from '#lib/testing/cross_backend/create_dual_spawn_global_setup.ts';
import { ts_spine_node_backend_config } from '#lib/testing/cross_backend/ts_spine_backend_config.ts';
import {
	RUST_SPINE_STUB_DATABASE_URL_ENV,
	rust_spine_stub_backend_config
} from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import { reset_public_schema } from '#lib/testing/db.ts';
import { create_db } from '#lib/db/create_db.ts';
import { pg_error_code } from '#lib/db/pg_error.ts';
import type { TestProject } from 'vitest/node';

import './cross_test_types.ts';
import {
	ensure_database,
	prepare_rust_spine_backend,
	resolve_rust_spine_stub_database_url,
	to_maintenance_database_url
} from './global_setup_helpers.ts';

/**
 * The Postgres database the TS spine leg migrates — beside the stub's
 * `fuz_app_test_rust_spine_stub`, and used by nothing else: every run empties it.
 */
const TS_SPINE_PARITY_DATABASE = 'fuz_app_test_ts_spine_parity';

/**
 * The TS leg's database URL: the stub's URL with the database name replaced,
 * so one env var moves both legs to another server and neither can be pointed
 * at the other's database.
 */
const resolve_ts_spine_parity_database_url = (): string => {
	const url = new URL(resolve_rust_spine_stub_database_url());
	url.pathname = `/${TS_SPINE_PARITY_DATABASE}`;
	return url.href;
};

/** A connection failure's text — a refused connection carries a `code` and an empty message. */
const describe_error = (error: unknown): string =>
	(error instanceof Error && error.message) || pg_error_code(error) || String(error);

/**
 * A database URL fit to print: the password, when there is one, replaced.
 * The whole URL rather than its host, which is empty for a socket URL that
 * names its server in the query string.
 */
const redact_database_url = (database_url: string): string => {
	const url = new URL(database_url);
	if (url.password) url.password = 'REDACTED';
	// `pg` and libpq also take the password as a query parameter
	if (url.searchParams.has('password')) url.searchParams.set('password', 'REDACTED');
	return url.href;
};

/**
 * Drop and recreate the `public` schema of the TS leg's database, so the spine
 * binary migrates and bootstraps from nothing on every run.
 *
 * Refuses any URL whose database is not `TS_SPINE_PARITY_DATABASE` — the wipe
 * takes everything, so it is tied to the one name this file owns rather than
 * to whatever URL reaches it.
 *
 * @param database_url - the TS leg's `postgres://` URL
 * @throws Error when the URL names another database, or when the database
 * cannot be emptied (with what to check)
 */
const empty_ts_spine_parity_database = async (database_url: string): Promise<void> => {
	const url = new URL(database_url);
	const database = url.pathname.slice(1);
	if (database !== TS_SPINE_PARITY_DATABASE) {
		throw new Error(
			`schema parity setup: refusing to empty database "${database}" — only ` +
				`"${TS_SPINE_PARITY_DATABASE}" is wiped`
		);
	}
	const { db, close } = await create_db(database_url);
	try {
		await reset_public_schema(db);
	} catch (error) {
		// 3D000 invalid_catalog_name — the server answered, the database is missing
		const maintenance_url = redact_database_url(to_maintenance_database_url(database_url));
		const fix =
			pg_error_code(error) === '3D000'
				? `the database does not exist and \`createdb\` did not create it — run ` +
					`\`createdb --maintenance-db=${maintenance_url} ` +
					`${TS_SPINE_PARITY_DATABASE}\` to see why (the URL's role needs to be ` +
					`allowed to create databases), or create it there as another role`
				: `check that Postgres is running there and that the URL's role can connect ` +
					`and owns the database, or set ${RUST_SPINE_STUB_DATABASE_URL_ENV} to a ` +
					`server both legs can use`;
		throw new Error(
			`schema parity setup: the TS spine leg needs the Postgres database ` +
				`${redact_database_url(database_url)}, and it could not be emptied: ` +
				`${describe_error(error)}. To fix: ${fix}.`,
			{ cause: error }
		);
	} finally {
		await close();
	}
};

const setup = async (project: TestProject): Promise<() => Promise<void>> => {
	// Make the Rust stub binary current + ensure its DB before the dual spawn.
	// (The same URL `global_setup.ts` resolves, so both projects share the DB.)
	prepare_rust_spine_backend({ crate: 'testing_spine_stub' });
	const ts_database_url = resolve_ts_spine_parity_database_url();
	// on the server the URL names — the wipe below connects through the URL
	ensure_database(TS_SPINE_PARITY_DATABASE, ts_database_url);
	await empty_ts_spine_parity_database(ts_database_url);
	const dual_spawn = create_dual_spawn_global_setup({
		configs: {
			a: () => ts_spine_node_backend_config({ database_url: ts_database_url }),
			b: rust_spine_stub_backend_config
		}
	});
	return dual_spawn(project);
};

export default setup;
