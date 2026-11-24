/**
 * Vitest `globalSetup` for the `cross_backend_rust_spine_stub` project — rebuilds
 * the Rust `testing_spine_stub` crate, opens its database (a `pglet_server` of
 * its own, or a PostgreSQL database under `FUZ_TEST_POSTGRES_URL`), then spawns
 * the binary via `rust_spine_stub_backend_config` with the name, port and
 * database `CROSS_PROJECT_RESOURCES` holds for the project.
 *
 * Rebuild-by-default keeps a stale binary from masquerading as a regression
 * (`cargo build` is incremental, so it's cheap when current). Override the
 * Cargo workspace with `FUZ_RUST_SPINE_STUB_WORKSPACE_DIR`, skip the rebuild with
 * `FUZ_TESTING_NO_REBUILD=1`, or pin prebuilt binaries with
 * `FUZ_TESTING_RUST_SPINE_STUB_BIN` and `PGLET_SERVER_BIN` — see
 * `global_setup_helpers.ts` and `rust_spine_stub_backend_config`.
 *
 * @module
 */

import { rust_spine_stub_backend_config } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';
import { make_rust_spine_global_setup, RUST_SPINE_STUB_CRATE } from './global_setup_helpers.ts';

const { name, port, database } = CROSS_PROJECT_RESOURCES.cross_backend_rust_spine_stub.stub;

export default make_rust_spine_global_setup(
	(database_url) => rust_spine_stub_backend_config({ name, port, database_url }),
	{ crate: RUST_SPINE_STUB_CRATE, database }
);
