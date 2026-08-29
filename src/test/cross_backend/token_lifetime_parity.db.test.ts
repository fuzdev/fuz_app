/**
 * In-process leg of the API-token-lifetime parity suite.
 *
 * Runs `describe_token_lifetime_cross_tests` against the in-process Hono spine
 * surface (no process boundary), so the ttl-mint → list round-trip, the
 * eternal control, and the required-`lifetime` refusals are verified under a
 * plain `gro test` — the cross-process leg (`token_lifetime.cross.test.ts`)
 * additionally drives the TS spine binaries + Rust `testing_spine_stub` over
 * real HTTP behind `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * @module
 */

import { default_in_process_setup } from '$lib/testing/cross_backend/in_process_setup.ts';
import { describe_token_lifetime_cross_tests } from '$lib/testing/cross_backend/token_lifetime.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints,
	spine_session_options
} from '$lib/testing/cross_backend/default_spine_surface.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '$lib/auth/role_schema.ts';

const setup_test = default_in_process_setup({
	session_options: spine_session_options,
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: spine_rpc_endpoints
});

describe_token_lifetime_cross_tests({ setup_test });
