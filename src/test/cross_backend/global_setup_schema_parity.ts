/**
 * Vitest `globalSetup` for the `cross_backend_parity` project — spawns +
 * bootstraps BOTH backends in one run (the TS spine on Node + PGlite as `a`,
 * the Rust `testing_spine_stub` over real Postgres as `b`) and provides both
 * serialized handles, so both parity gates that run under this project —
 * `schema_parity.cross.test.ts` (live DDL) and
 * `action_manifest_parity.cross.test.ts` (live RPC method set + auth) — can
 * capture each backend and diff. One dual-spawn serves both.
 *
 * The single-backend `global_setup_*.ts` makers derive one backend per
 * project; these gates need both alive at once. The Rust side is made
 * current first (rebuild + `createdb`) via `prepare_rust_spine_backend`, the
 * same prerequisite the single-backend `cross_backend_rust_spine_stub` project
 * runs; the TS-spine side needs no prep.
 *
 * @module
 */

import {create_dual_spawn_global_setup} from '$lib/testing/cross_backend/create_dual_spawn_global_setup.ts';
import {ts_spine_node_backend_config} from '$lib/testing/cross_backend/ts_spine_backend_config.ts';
import {rust_spine_stub_backend_config} from '$lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import type {TestProject} from 'vitest/node';

import './cross_test_types.ts';
import {prepare_rust_spine_backend} from './global_setup_helpers.ts';

const dual_spawn = create_dual_spawn_global_setup({
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
