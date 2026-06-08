/**
 * Vitest `globalSetup` for the `cross_backend_schema_parity` project —
 * spawns + bootstraps BOTH backends in one run (the TS spine on Node +
 * PGlite as `a`, the Rust `testing_spine_stub` over real Postgres as `b`)
 * and provides both serialized handles, so `schema_parity.cross.test.ts`
 * can capture each one's schema and diff them.
 *
 * The single-backend `global_setup_*.ts` makers derive one backend per
 * project; this gate needs both alive at once. The Rust side is made
 * current first (rebuild + `createdb`) via `prepare_rust_spine_backend`, the
 * same prerequisite the single-backend `cross_backend_rust_spine_stub` project
 * runs; the TS-spine side needs no prep.
 *
 * @module
 */

import {create_schema_parity_global_setup} from '$lib/testing/cross_backend/create_schema_parity_global_setup.js';
import {ts_spine_node_backend_config} from '$lib/testing/cross_backend/ts_spine_backend_config.js';
import {rust_spine_stub_backend_config} from '$lib/testing/cross_backend/rust_spine_stub_backend_config.js';
import type {TestProject} from 'vitest/node';

import './cross_test_types.js';
import {prepare_rust_spine_backend} from './global_setup_helpers.js';

const dual_spawn = create_schema_parity_global_setup({
	configs: {a: ts_spine_node_backend_config, b: rust_spine_stub_backend_config},
});

const setup = (project: TestProject): Promise<() => Promise<void>> => {
	// Make the Rust stub binary current + ensure its DB before the dual spawn.
	// (Matches `global_setup.ts`'s `database` so both projects share the DB.)
	prepare_rust_spine_backend({
		crate: 'testing_spine_stub',
		database: 'fuz_app_test_rust_spine_stub',
	});
	return dual_spawn(project);
};

export default setup;
