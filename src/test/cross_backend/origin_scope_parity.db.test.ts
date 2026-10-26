/**
 * In-process leg of the origin-scope parity suite.
 *
 * Runs `describe_origin_scope_cross_tests` against the in-process Hono app (no
 * process boundary): the same spine-migrated database and `/ready` route the
 * readiness leg mounts (`ready_parity.db.test.ts`), so the origin check's
 * every-path scope is pinned off `/api` under a plain `gro test`. The
 * cross-process leg (`spine_suites.cross.test.ts`) additionally drives the TS
 * spine binaries + Rust `testing_spine_stub` over real HTTP behind
 * `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * @module
 */

import { default_in_process_setup } from '#lib/testing/cross_backend/in_process_setup.ts';
import { in_process_capabilities } from '#lib/testing/cross_backend/capabilities.ts';
import { describe_origin_scope_cross_tests } from '#lib/testing/cross_backend/origin_scope.ts';
import {
	create_spine_ready_route_spec,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { CELL_MIGRATION_NS } from '#lib/db/cell_ddl.ts';
import { FACT_MIGRATION_NS } from '#lib/db/fact_ddl.ts';

const setup_test = default_in_process_setup({
	session_options: spine_session_options,
	migration_namespaces: [CELL_MIGRATION_NS, FACT_MIGRATION_NS],
	create_route_specs: () => [create_spine_ready_route_spec()]
});

describe_origin_scope_cross_tests({ setup_test, capabilities: in_process_capabilities });
