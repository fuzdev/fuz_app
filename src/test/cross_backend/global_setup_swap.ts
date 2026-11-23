/**
 * Vitest `globalSetup` for the `cross_backend_swap` project — prepares the
 * backend swap and spawns nothing: `backend_swap.cross.test.ts` starts and
 * stops the TS spine (Node) and the Rust `testing_spine_stub` itself, one at
 * a time over one database, so each boots over what the other left.
 *
 * It makes the stub current and creates the database when missing
 * (`prepare_rust_spine_backend`), on the server
 * `FUZ_TESTING_RUST_SPINE_STUB_DATABASE_URL` names, else the local default,
 * then provides both configs as `swap_backend_configs`. The stub's startup
 * reset is off (`reset_db_on_startup: false`) — on, its boot would drop
 * every row the TS spine wrote. Each order of the suite empties the database
 * before its first spawn.
 *
 * @module
 */

import type { TestProject } from 'vitest/node';

import { rust_spine_stub_backend_config } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import { ts_spine_node_backend_config } from '#lib/testing/cross_backend/ts_spine_backend_config.ts';
import { with_database_name } from '#lib/testing/cross_backend/postgres_database.ts';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';
import './cross_test_types.ts';
import {
	prepare_rust_spine_backend,
	resolve_rust_spine_stub_database_url,
	RUST_SPINE_STUB_CRATE,
	with_legible_setup_failure
} from './global_setup_helpers.ts';

const { ts: SWAP_TS, stub: SWAP_STUB } = CROSS_PROJECT_RESOURCES.cross_backend_swap;

const setup = async (project: TestProject): Promise<void> => {
	// the stub's URL with the database name replaced, so one env var moves the
	// swap to another server
	const database_url = with_database_name(resolve_rust_spine_stub_database_url(), SWAP_TS.database);
	prepare_rust_spine_backend({ crate: RUST_SPINE_STUB_CRATE, database_url });
	project.provide('swap_backend_configs', {
		ts: ts_spine_node_backend_config({
			name: SWAP_TS.name,
			port: SWAP_TS.port,
			database_url
		}),
		// reads the binary path `prepare_rust_spine_backend` just set
		stub: rust_spine_stub_backend_config({
			name: SWAP_STUB.name,
			port: SWAP_STUB.port,
			database_url,
			reset_db_on_startup: false
		})
	});
};

export default with_legible_setup_failure('swap', setup);
