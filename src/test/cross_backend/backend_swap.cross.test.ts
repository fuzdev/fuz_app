/**
 * The backend swap between fuz_app's TS spine and the Rust
 * `testing_spine_stub`, both ways: TS→Rust and Rust→TS over one
 * database, each spine booting over what the other left and honoring it
 * (`describe_backend_swap_tests`). The configs come from
 * `global_setup_swap.ts`; the database (a `pglet_server`, or PostgreSQL under
 * `FUZ_TEST_POSTGRES_URL`) is the project's own, emptied before each order.
 *
 * @module
 */

import { inject } from 'vitest';

import { describe_backend_swap_tests } from '#lib/testing/cross_backend/backend_swap.ts';
import { empty_test_database } from '#lib/testing/cross_backend/test_database.ts';

import './cross_test_types.ts';

const { ts, stub } = inject('swap_backend_configs');
const database_url = stub.env.DATABASE_URL;
if (database_url === undefined) {
	throw new Error("backend_swap.cross.test.ts: the stub's config names no DATABASE_URL");
}

describe_backend_swap_tests({
	orders: [
		{ label: 'TS → Rust', first: ts, second: stub },
		{ label: 'Rust → TS', first: stub, second: ts }
	],
	database_url,
	empty_database: () => empty_test_database(database_url)
});
