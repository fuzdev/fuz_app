/**
 * Vitest `globalSetup` for the `cross_backend_ts_bun` project — spawns
 * fuz_app's own domain-free TS spine binary on Bun (`bun run`), backed by
 * in-memory PGlite. Requires `bun` on PATH; no external Postgres or prebuilt
 * binary needed.
 *
 * @module
 */

import {ts_spine_bun_backend_config} from '$lib/testing/cross_backend/ts_spine_backend_config.js';

import {make_spine_global_setup} from './global_setup_helpers.js';

export default make_spine_global_setup(ts_spine_bun_backend_config);
