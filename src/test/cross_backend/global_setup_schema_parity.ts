/**
 * Vitest `globalSetup` for the `cross_backend_parity` project — spawns +
 * bootstraps BOTH backends in one run (the TS spine on Node as `a`, the Rust
 * `testing_spine_stub` as `b`, each over its own database on one PostgreSQL
 * server) and provides both serialized handles, so the gates that run under this
 * project — `schema_parity.cross.test.ts` (live DDL),
 * `action_manifest_parity.cross.test.ts` (live RPC method set + auth) and
 * `differential.cross.test.ts` (every conformance case's answer) — can
 * capture each backend and diff. One dual-spawn serves all three.
 *
 * **Both legs run on PostgreSQL, and only there.** The schema snapshot
 * compares index definitions as the engine renders them
 * (`pg_indexes.indexdef`), and pglet renders an index without its per-key sort
 * direction, `NULLS` placement, operator classes or `NULLS NOT DISTINCT`; the
 * lock pins assert they run on PostgreSQL, and the invariant twin reads each
 * spine's database directly. On one engine, a diff can only be DDL drift. So
 * each leg gets a PostgreSQL database of its own on the server
 * `FUZ_TEST_POSTGRES_URL` names (`fuz_testing_<repo>_<name>`, fresh each run),
 * which keeps the two legs on one server version; with the variable unset the
 * setup fails naming it — the gate never skips, and `npm run test:cross`
 * reports the project "not run (postgres-only)" instead of running it.
 *
 * **The bootstrap's write.** Bootstrap is one-shot per backend, and every
 * test's `_testing_reset` reseeds the keeper by SQL, so what the real
 * `POST /bootstrap` wrote is read here, right after each backend's bootstrap
 * (`create_db_state_probe`, the transcript's database read), and provided as
 * `parity_bootstrap_db_state` for `bootstrap_db_state.cross.test.ts` to diff.
 *
 * The single-backend `global_setup_*.ts` makers derive one backend per
 * project; these gates need both alive at once. Both run on ports, databases
 * and backend names of their own (`CROSS_PROJECT_RESOURCES`), so this project
 * runs beside every other cross project. The Rust side is made current
 * (`rebuild_rust_spine_stub`) before the dual spawn, the same prerequisite the
 * single-backend `cross_backend_rust_spine_stub` project runs.
 *
 * @module
 */

import { create_dual_spawn_global_setup } from '#lib/testing/cross_backend/create_dual_spawn_global_setup.ts';
import {
	create_db_state_probe,
	type DbState,
	type DbStateMark
} from '#lib/testing/cross_backend/db_state_diff.ts';
import { ts_spine_node_backend_config } from '#lib/testing/cross_backend/ts_spine_backend_config.ts';
import { rust_spine_stub_backend_config } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import type { TestProject } from 'vitest/node';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';
import './cross_test_types.ts';
import {
	rebuild_rust_spine_stub,
	RUST_SPINE_STUB_CRATE,
	with_legible_setup_failure
} from './global_setup_helpers.ts';

/** The project's two backends, each over a PostgreSQL database of its own. */
const { ts: PARITY_TS, stub: PARITY_STUB } = CROSS_PROJECT_RESOURCES.cross_backend_parity;

/**
 * The mark the bootstrap read starts from: the audit sequence of a database
 * nothing has written to, as each backend's is at spawn (each database is
 * new), so the read counts every audit insert the bootstrap spent.
 */
const FRESH_DATABASE_MARK: DbStateMark = { audit_seq: 0 };

const setup = async (project: TestProject): Promise<() => Promise<void>> => {
	rebuild_rust_spine_stub({ crate: RUST_SPINE_STUB_CRATE });
	const bootstrap_db_state: Partial<Record<'a' | 'b', DbState>> = {};
	const dual_spawn = create_dual_spawn_global_setup({
		configs: {
			a: (database_url) =>
				ts_spine_node_backend_config({
					name: PARITY_TS.name,
					port: PARITY_TS.port,
					database_url
				}),
			b: (database_url) =>
				rust_spine_stub_backend_config({
					name: PARITY_STUB.name,
					port: PARITY_STUB.port,
					database_url
				})
		},
		// PostgreSQL-only: no pglet server to fall back to
		databases: {
			a: { name: PARITY_TS.database, pglet_server: null },
			b: { name: PARITY_STUB.database, pglet_server: null }
		},
		after_bootstrap: async (handle, side) => {
			const probe = create_db_state_probe(handle);
			try {
				bootstrap_db_state[side] = await probe.read(FRESH_DATABASE_MARK);
			} finally {
				await probe.close();
			}
		}
	});
	const teardown = await dual_spawn(project);
	const { a, b } = bootstrap_db_state;
	if (!a || !b) {
		// the missing probe is the report; a failed teardown is logged beside it
		await teardown().catch((error: unknown) => console.error(error));
		throw new Error('parity setup: a bootstrap database read is missing');
	}
	project.provide('parity_bootstrap_db_state', { a, b });
	return teardown;
};

export default with_legible_setup_failure('parity', setup);
