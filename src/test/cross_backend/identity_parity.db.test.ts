/**
 * In-process leg of the identity-primitive parity suite.
 *
 * Runs `describe_identity_parity_cross_tests` against the in-process Hono spine
 * surface (no process boundary), so the login canonicalization + username-or-email
 * lookup, the no-Unicode-fold-collision negative, login/signup input validation,
 * and the username + email creation rules (ASCII-only, length/format,
 * `local@domain.tld` email shape) are verified under a plain `gro test` — the
 * cross-process leg (`spine_suites.cross.test.ts`) additionally drives the TS
 * spine binaries + Rust `testing_spine_stub` over real HTTP behind
 * `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * @module
 */

import { default_in_process_setup } from '#lib/testing/cross_backend/in_process_setup.ts';
import { describe_identity_parity_cross_tests } from '#lib/testing/cross_backend/identity_parity.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';

// The keeper holds `ROLE_ADMIN` by default, which the fixture's `create_account`
// invite step (`invite_create`, admin-gated) needs; `ROLE_KEEPER` alone isn't admin.
const setup_test = default_in_process_setup({
	session_options: spine_session_options,
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: spine_rpc_endpoints
});

// the in-process spine surface mounts no bootstrap route
describe_identity_parity_cross_tests({ setup_test, bootstrap_path: null });
