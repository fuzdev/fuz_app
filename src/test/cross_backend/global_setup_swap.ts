/**
 * Vitest `globalSetup` for the `cross_backend_swap` project — prepares the
 * backend swap and spawns nothing: `backend_swap.cross.test.ts` starts and
 * stops the TS spine (Node) and the Rust `testing_spine_stub` itself, one at
 * a time over one database, so each boots over what the other left.
 *
 * It makes the stub current (`rebuild_rust_spine_stub`) and opens the one
 * database both spines run over (`open_rust_spine_database`: a `pglet_server`
 * both reach over the wire, or a PostgreSQL database under
 * `FUZ_TEST_POSTGRES_URL`), then provides both configs as
 * `swap_backend_configs`; the teardown closes the database. Each order of the
 * suite empties it before its first spawn.
 *
 * @module
 */

import type { TestProject } from 'vitest/node';

import { rust_spine_stub_backend_config } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import { ts_spine_node_backend_config } from '#lib/testing/cross_backend/ts_spine_backend_config.ts';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';
import './cross_test_types.ts';
import {
	open_rust_spine_database,
	rebuild_rust_spine_stub,
	RUST_SPINE_STUB_CRATE,
	with_legible_setup_failure
} from './global_setup_helpers.ts';

const { ts: SWAP_TS, stub: SWAP_STUB } = CROSS_PROJECT_RESOURCES.cross_backend_swap;

const setup = async (project: TestProject): Promise<() => Promise<void>> => {
	rebuild_rust_spine_stub({ crate: RUST_SPINE_STUB_CRATE });
	// one database for both spines, the stub's
	const database = await open_rust_spine_database(SWAP_STUB.database);
	const database_url = database.url;
	try {
		project.provide('swap_backend_configs', {
			ts: ts_spine_node_backend_config({
				name: SWAP_TS.name,
				port: SWAP_TS.port,
				database_url
			}),
			// reads the binary path the rebuild just set
			stub: rust_spine_stub_backend_config({
				name: SWAP_STUB.name,
				port: SWAP_STUB.port,
				database_url
			})
		});
	} catch (error) {
		await database.close();
		throw error;
	}
	return database.close;
};

export default with_legible_setup_failure('swap', setup);
