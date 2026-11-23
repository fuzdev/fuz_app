/**
 * Both spines live: fuz_app's TS spine and the Rust `testing_spine_stub` over
 * one Postgres database at once, both ways (TS first, Rust first) — each
 * honoring the other's credential revocations live, with the per-process
 * limits pinned by name (`describe_backend_both_live_tests`). The configs come
 * from `global_setup_both_live.ts`, the stub's startup reset off; the database
 * is the project's own, emptied before each spawn sequence.
 *
 * @module
 */

import { inject } from 'vitest';

import { describe_backend_both_live_tests } from '#lib/testing/cross_backend/backend_both_live.ts';
import { empty_owned_database } from '#lib/testing/cross_backend/postgres_database.ts';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';
import './cross_test_types.ts';

const { ts, stub } = inject('both_live_backend_configs');
const database_url = stub.env.DATABASE_URL;
if (database_url === undefined) {
	throw new Error("backend_both_live.cross.test.ts: the stub's config names no DATABASE_URL");
}

describe_backend_both_live_tests({
	orders: [
		{ label: 'TS first', first: ts, second: stub },
		{ label: 'Rust first', first: stub, second: ts }
	],
	database_url,
	empty_database: () =>
		empty_owned_database(database_url, {
			owned_name: CROSS_PROJECT_RESOURCES.cross_backend_both_live.ts.database,
			label: 'backend both live'
		})
});
