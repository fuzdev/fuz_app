/**
 * Vitest `globalSetup` for the `cross_backend_rust_spine_stub` project — rebuilds
 * the Rust `testing_spine_stub` crate, ensures its Postgres database exists,
 * then spawns the binary via `rust_spine_stub_backend_config()`.
 *
 * Rebuild-by-default keeps a stale binary from masquerading as a regression
 * (`cargo build` is incremental, so it's cheap when current). Override the
 * Cargo workspace with `FUZ_RUST_SPINE_STUB_WORKSPACE_DIR`, skip the rebuild with
 * `FUZ_TESTING_NO_REBUILD`, or pin a prebuilt binary with
 * `FUZ_TESTING_RUST_SPINE_STUB_BIN` — see `global_setup_helpers.ts` and
 * `rust_spine_stub_backend_config`.
 *
 * @module
 */

import {rust_spine_stub_backend_config} from '$lib/testing/cross_backend/rust_spine_stub_backend_config.ts';

import {make_rust_spine_global_setup} from './global_setup_helpers.ts';

export default make_rust_spine_global_setup(rust_spine_stub_backend_config, {
	crate: 'testing_spine_stub',
	// Matches `RUST_SPINE_STUB_DEFAULT_DATABASE_URL`'s database name.
	database: 'fuz_app_test_rust_spine_stub',
});
