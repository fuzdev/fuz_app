/**
 * Vitest `globalSetup` for the `cross_backend_both_live` project — prepares
 * both spines live and spawns nothing: `backend_both_live.cross.test.ts`
 * starts the TS spine (Node) and the Rust `testing_spine_stub` itself, over
 * one database and running at once, in the order the per-process keeper cache
 * forces (the first bootstraps before the second boots).
 *
 * It makes the stub current (`rebuild_rust_spine_stub`) and opens the one
 * database both spines run over (`open_rust_spine_database`: a `pglet_server`
 * both reach over the wire, or a PostgreSQL database under
 * `FUZ_TEST_POSTGRES_URL`), then provides both configs as
 * `both_live_backend_configs`; the teardown closes the database. Each order of
 * the suite empties it before each spawn sequence.
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

const { ts: BOTH_LIVE_TS, stub: BOTH_LIVE_STUB } = CROSS_PROJECT_RESOURCES.cross_backend_both_live;

const setup = async (project: TestProject): Promise<() => Promise<void>> => {
	rebuild_rust_spine_stub({ crate: RUST_SPINE_STUB_CRATE });
	// one database for both spines, the stub's
	const database = await open_rust_spine_database(BOTH_LIVE_STUB.database);
	const database_url = database.url;
	try {
		project.provide('both_live_backend_configs', {
			ts: ts_spine_node_backend_config({
				name: BOTH_LIVE_TS.name,
				port: BOTH_LIVE_TS.port,
				database_url
			}),
			// reads the binary path the rebuild just set
			stub: rust_spine_stub_backend_config({
				name: BOTH_LIVE_STUB.name,
				port: BOTH_LIVE_STUB.port,
				database_url
			})
		});
	} catch (error) {
		await database.close();
		throw error;
	}
	return database.close;
};

export default with_legible_setup_failure('both live', setup);
