/**
 * Vitest `globalSetup` for the `cross_backend_ts_differential` project —
 * spawns + bootstraps the TS spine binary twice, on Node as `a` and on Bun as
 * `b`, each on `memory://`, and provides both serialized handles to
 * `differential_ts.cross.test.ts`.
 *
 * Both run on ports and backend names of their own (`TS_DIFFERENTIAL_*`
 * below), so this project runs beside every other cross project. Needs `bun`
 * on PATH, no Postgres.
 *
 * @module
 */

import { create_dual_spawn_global_setup } from '#lib/testing/cross_backend/create_dual_spawn_global_setup.ts';
import {
	ts_spine_bun_backend_config,
	ts_spine_node_backend_config
} from '#lib/testing/cross_backend/ts_spine_backend_config.ts';

import './cross_test_types.ts';

/** The Node leg's port — past the security project's `1183`/`1184`. */
const TS_DIFFERENTIAL_NODE_PORT = 1185;

/** The Bun leg's port. */
const TS_DIFFERENTIAL_BUN_PORT = 1186;

export default create_dual_spawn_global_setup({
	configs: {
		a: () =>
			ts_spine_node_backend_config({
				name: 'ts_spine_node_differential',
				port: TS_DIFFERENTIAL_NODE_PORT
			}),
		b: () =>
			ts_spine_bun_backend_config({
				name: 'ts_spine_bun_differential',
				port: TS_DIFFERENTIAL_BUN_PORT
			})
	},
	provide_keys: { a: 'ts_differential_handle_a', b: 'ts_differential_handle_b' }
});
