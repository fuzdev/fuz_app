/**
 * Vitest `globalSetup` for the `cross_backend_ts_differential` project —
 * spawns + bootstraps the TS spine binary twice, on Node as `a` and on Bun as
 * `b`, each on `memory://`, and provides both serialized handles to
 * `differential_ts.cross.test.ts`.
 *
 * Both run on ports and backend names of their own
 * (`CROSS_PROJECT_RESOURCES`), so this project runs beside every other cross
 * project. Needs `bun` on PATH, no Postgres.
 *
 * @module
 */

import { create_dual_spawn_global_setup } from '#lib/testing/cross_backend/create_dual_spawn_global_setup.ts';
import {
	ts_spine_bun_backend_config,
	ts_spine_node_backend_config
} from '#lib/testing/cross_backend/ts_spine_backend_config.ts';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';
import './cross_test_types.ts';

const { node: TS_DIFFERENTIAL_NODE, bun: TS_DIFFERENTIAL_BUN } =
	CROSS_PROJECT_RESOURCES.cross_backend_ts_differential;

export default create_dual_spawn_global_setup({
	configs: {
		a: () =>
			ts_spine_node_backend_config({
				name: TS_DIFFERENTIAL_NODE.name,
				port: TS_DIFFERENTIAL_NODE.port
			}),
		b: () =>
			ts_spine_bun_backend_config({
				name: TS_DIFFERENTIAL_BUN.name,
				port: TS_DIFFERENTIAL_BUN.port
			})
	},
	provide_keys: { a: 'ts_differential_handle_a', b: 'ts_differential_handle_b' }
});
