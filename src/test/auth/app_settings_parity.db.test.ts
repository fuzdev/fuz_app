/**
 * In-process leg of the `open_signup` effect suite.
 *
 * Runs `describe_app_settings_cross_tests` against the in-process Hono app
 * (no process boundary), so the admin-toggle → fresh-read-on-signup contract
 * is verified under a plain `gro test` — the cross-process leg
 * (`app_settings.cross.test.ts`) additionally drives the TS spine binary +
 * Rust `testing_spine_stub` over real HTTP behind `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * Reuses the spine surface helpers (standard RPC bundle + the `/api/account`
 * signup route) so the in-process leg mounts the same surface the spine
 * binary serves.
 *
 * @module
 */

import {default_in_process_setup} from '$lib/testing/cross_backend/in_process_setup.ts';
import {in_process_capabilities} from '$lib/testing/cross_backend/capabilities.ts';
import {describe_app_settings_cross_tests} from '$lib/testing/cross_backend/app_settings.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints,
	spine_session_options,
} from '$lib/testing/cross_backend/default_spine_surface.ts';
import {SPINE_RPC_PATH} from '$lib/testing/cross_backend/spine_surface_constants.ts';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.ts';

const setup_test = default_in_process_setup({
	session_options: spine_session_options,
	// The keeper needs `ROLE_ADMIN` to call the admin-gated `app_settings_update`.
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: spine_rpc_endpoints,
});

describe_app_settings_cross_tests({
	setup_test,
	capabilities: in_process_capabilities,
	rpc_path: SPINE_RPC_PATH,
});
