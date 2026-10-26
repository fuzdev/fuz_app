/**
 * In-process leg of the testing-backdoor suite's declaration check.
 *
 * The in-process app mounts no `_testing_*` action and declares none
 * (`in_process_capabilities`), so every known backdoor gets the undeclared →
 * `method_not_found` row under a plain `gro test`, and none gets a
 * credential-gate row. The cross-process leg (`spine_suites.cross.test.ts`,
 * behind `FUZ_TEST_CROSS_BACKEND=1`) declares every one against the spine
 * binaries, so there the credential rows run and no declaration row does.
 *
 * @module
 */

import { default_in_process_setup } from '#lib/testing/cross_backend/in_process_setup.ts';
import { in_process_capabilities } from '#lib/testing/cross_backend/capabilities.ts';
import { describe_testing_backdoor_cross_tests } from '#lib/testing/cross_backend/testing_backdoor.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';

const setup_test = default_in_process_setup({
	session_options: spine_session_options,
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: (ctx) => spine_rpc_endpoints(ctx)
});

describe_testing_backdoor_cross_tests({ setup_test, capabilities: in_process_capabilities });
