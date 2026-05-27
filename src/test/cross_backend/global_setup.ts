/**
 * Vitest `globalSetup` for the `cross_backend_spine_stub` project — rebuilds
 * the Rust `testing_spine_stub` crate, ensures its Postgres database exists,
 * then spawns the binary via `spine_stub_backend_config()`.
 *
 * Rebuild-by-default keeps a stale binary from masquerading as a regression
 * (`cargo build` is incremental, so it's cheap when current). Override the
 * Cargo workspace with `FUZ_SPINE_STUB_WORKSPACE_DIR`, skip the rebuild with
 * `FUZ_TESTING_NO_REBUILD`, or pin a prebuilt binary with
 * `FUZ_TESTING_SPINE_STUB_BIN` — see `global_setup_helpers.ts` and
 * `spine_stub_backend_config`.
 *
 * @module
 */

import {spine_stub_backend_config} from '$lib/testing/cross_backend/spine_stub_backend_config.js';

import {make_rust_spine_global_setup} from './global_setup_helpers.js';

export default make_rust_spine_global_setup(spine_stub_backend_config, {
	crate: 'testing_spine_stub',
	// Matches `SPINE_STUB_DEFAULT_DATABASE_URL`'s database name.
	database: 'fuz_app_test_spine_stub',
});
