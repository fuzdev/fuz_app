/**
 * Vitest `globalSetup` for the `cross_backend_parity` project — spawns +
 * bootstraps BOTH backends in one run (the TS spine on Node as `a`, the Rust
 * `testing_spine_stub` as `b`, each over its own database on one real Postgres
 * server) and provides both serialized handles, so the gates that run under this
 * project — `schema_parity.cross.test.ts` (live DDL),
 * `action_manifest_parity.cross.test.ts` (live RPC method set + auth) and
 * `differential.cross.test.ts` (every conformance case's answer) — can
 * capture each backend and diff. One dual-spawn serves all three.
 *
 * **Both legs run on Postgres.** The schema snapshot compares index
 * definitions as the engine renders them (`pg_indexes.indexdef`), and pglet —
 * the TS spine's `memory://` default — renders an index without its per-key
 * sort direction, `NULLS` placement, operator classes or `NULLS NOT DISTINCT`.
 * On one engine, a diff can only be DDL drift. So this project alone gives the
 * TS spine a `postgres://` URL: a database of its own on the server the
 * stub's URL names (`FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL`, else the
 * local default), which keeps the two legs on one server version.
 *
 * The single-backend `global_setup_*.ts` makers derive one backend per
 * project; these gates need both alive at once. Both run on ports, databases
 * and backend names of their own (`CROSS_PROJECT_RESOURCES`), so this project
 * runs beside every other cross project. Each side is prepared before the
 * dual spawn. The Rust side is made current (rebuild + `createdb` of its
 * database) via `prepare_rust_spine_backend`, the same
 * prerequisite the single-backend `cross_backend_rust_spine_stub` project
 * runs; the stub wipes its own database at startup. The TS spine binary does not, and bootstrap refuses a
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
import {
	empty_owned_database,
	ensure_database,
	with_database_name
} from '#lib/testing/cross_backend/postgres_database.ts';
import type { TestProject } from 'vitest/node';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';
import './cross_test_types.ts';
import {
	prepare_rust_spine_backend,
	resolve_rust_spine_stub_database_url,
	RUST_SPINE_STUB_CRATE
} from './global_setup_helpers.ts';

/**
 * The project's two backends: the TS spine leg over a database used by
 * nothing else (every run empties it), and the parity stub over its own, not
 * the single-backend stub's, since the two run at once and each stub wipes
 * its database at startup.
 */
const { ts: PARITY_TS, stub: PARITY_STUB } = CROSS_PROJECT_RESOURCES.cross_backend_parity;

/**
 * Both legs' database URLs: the stub's URL with the database name replaced,
 * so one env var moves both legs to another server and neither can be pointed
 * at the other's database.
 */
const resolve_parity_database_urls = (): { ts: string; stub: string } => {
	const base = resolve_rust_spine_stub_database_url();
	return {
		ts: with_database_name(base, PARITY_TS.database),
		stub: with_database_name(base, PARITY_STUB.database)
	};
};

const setup = async (project: TestProject): Promise<() => Promise<void>> => {
	const database_urls = resolve_parity_database_urls();
	// Make the Rust stub binary current + ensure its DB before the dual spawn.
	prepare_rust_spine_backend({ crate: RUST_SPINE_STUB_CRATE, database_url: database_urls.stub });
	// on the server the URL names — the wipe below connects through the URL
	ensure_database(PARITY_TS.database, database_urls.ts);
	await empty_owned_database(database_urls.ts, {
		owned_name: PARITY_TS.database,
		label: 'schema parity setup',
		hint: `or set ${RUST_SPINE_STUB_DATABASE_URL_ENV} to a server both legs can use`
	});
	const dual_spawn = create_dual_spawn_global_setup({
		configs: {
			a: () =>
				ts_spine_node_backend_config({
					name: PARITY_TS.name,
					port: PARITY_TS.port,
					database_url: database_urls.ts
				}),
			b: () =>
				rust_spine_stub_backend_config({
					name: PARITY_STUB.name,
					port: PARITY_STUB.port,
					database_url: database_urls.stub
				})
		}
	});
	return dual_spawn(project);
};

export default setup;
