/**
 * Vitest `globalSetup` for the `cross_backend_ts_node` project — spawns
 * fuz_app's own domain-free TS spine binary on Node (`gro run`), backed by
 * in-memory PGlite. No external Postgres or prebuilt binary needed.
 *
 * @module
 */

import { ts_spine_node_backend_config } from '$lib/testing/cross_backend/ts_spine_backend_config.ts';

import { make_spine_global_setup } from './global_setup_helpers.ts';

export default make_spine_global_setup(ts_spine_node_backend_config);
