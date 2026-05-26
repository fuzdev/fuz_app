/**
 * Vitest `globalSetup` for the `cross_backend_spine_stub` project — spawns
 * the Rust `testing_spine_stub` binary via `spine_stub_backend_config()`.
 *
 * Requires `FUZ_TESTING_SPINE_STUB_BIN` to point at a prebuilt binary and
 * the target Postgres database to exist — see `spine_stub_backend_config`
 * for the operator setup.
 *
 * @module
 */

import {spine_stub_backend_config} from '$lib/testing/cross_backend/spine_stub_backend_config.js';

import {make_spine_global_setup} from './global_setup_helpers.js';

export default make_spine_global_setup(spine_stub_backend_config);
