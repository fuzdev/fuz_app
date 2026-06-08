/**
 * In-process leg of the `/ready` readiness-probe parity suite.
 *
 * Runs `describe_ready_cross_tests` against the in-process Hono app (no process
 * boundary): a fresh PGlite migrated with the full spine namespace set (auth +
 * cell + cell_history + fact) mounts `create_spine_ready_route_spec`, so an
 * anonymous `GET /ready` reports `200 {ready: true}` under a plain `gro test`.
 * The cross-process leg (`ready.cross.test.ts`) additionally drives the TS spine
 * binaries + Rust `testing_spine_stub` over real HTTP behind
 * `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * Migrating the same namespace set the spine binaries bootstrap is what makes
 * the in-process DB cover the committed `expected_schema.json` — an auth-only
 * default would report drift (missing cell / fact tables → `503`).
 *
 * @module
 */

import {default_in_process_setup} from '$lib/testing/cross_backend/setup.js';
import {in_process_capabilities} from '$lib/testing/cross_backend/capabilities.js';
import {describe_ready_cross_tests} from '$lib/testing/cross_backend/ready.js';
import {
	create_spine_ready_route_spec,
	spine_session_options,
} from '$lib/testing/cross_backend/default_spine_surface.js';
import {CELL_MIGRATION_NS} from '$lib/db/cell_ddl.js';
import {CELL_HISTORY_MIGRATION_NS} from '$lib/db/cell_history_ddl.js';
import {FACT_MIGRATION_NS} from '$lib/db/fact_ddl.js';

const setup_test = default_in_process_setup({
	session_options: spine_session_options,
	migration_namespaces: [CELL_MIGRATION_NS, CELL_HISTORY_MIGRATION_NS, FACT_MIGRATION_NS],
	create_route_specs: () => [create_spine_ready_route_spec()],
});

describe_ready_cross_tests({setup_test, capabilities: in_process_capabilities});
