/**
 * Vitest `globalSetup` for the `cross_backend_ts_deno` project — spawns
 * fuz_app's own domain-free TS spine binary on Deno, backed by in-memory
 * PGlite. Requires `deno` on PATH; no external Postgres or prebuilt binary.
 *
 * @module
 */

import {ts_spine_deno_backend_config} from '$lib/testing/cross_backend/ts_spine_backend_config.ts';

import {make_spine_global_setup} from './global_setup_helpers.ts';

export default make_spine_global_setup(ts_spine_deno_backend_config);
