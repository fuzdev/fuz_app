/**
 * Vitest `globalSetup` for the `cross_backend_rust_spine_stub` project — rebuilds
 * the Rust `testing_spine_stub` crate, ensures the Postgres database its URL
 * names exists, then spawns the binary via `rust_spine_stub_backend_config()`
 * with the name and port `CROSS_PROJECT_RESOURCES` holds for the project.
 *
 * Rebuild-by-default keeps a stale binary from masquerading as a regression
 * (`cargo build` is incremental, so it's cheap when current). Override the
 * Cargo workspace with `FUZ_RUST_SPINE_STUB_WORKSPACE_DIR`, skip the rebuild with
 * `FUZ_TESTING_NO_REBUILD=1`, or pin a prebuilt binary with
 * `FUZ_TESTING_RUST_SPINE_STUB_BIN` — see `global_setup_helpers.ts` and
 * `rust_spine_stub_backend_config`.
 *
 * @module
 */

import { rust_spine_stub_backend_config } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';
import { make_rust_spine_global_setup, RUST_SPINE_STUB_CRATE } from './global_setup_helpers.ts';

// the database is the stub's URL's — `RUST_SPINE_STUB_DEFAULT_DATABASE_URL`,
// which names the table's, unless the env var points elsewhere
const { name, port } = CROSS_PROJECT_RESOURCES.cross_backend_rust_spine_stub.stub;

export default make_rust_spine_global_setup(() => rust_spine_stub_backend_config({ name, port }), {
	crate: RUST_SPINE_STUB_CRATE
});
