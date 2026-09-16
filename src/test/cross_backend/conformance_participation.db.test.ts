/**
 * In-process leg of the role-gated-participation capstone.
 *
 * Runs the same declarative `conformance_participation_cases` + imperative
 * success suite against the in-process Hono spine surface (fast, every
 * `gro test`). The cross-process leg (`conformance_participation.cross.test.ts`)
 * runs the *same* assertions over real HTTP against the spawned spines.
 * Same-green both legs pins that the conferral algorithm is transport- and
 * impl-independent.
 *
 * @module
 */

import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import { describe_conformance_table_tests } from '$lib/testing/cross_backend/conformance_table.ts';
import { describe_role_grant_participation_cross_tests } from '$lib/testing/cross_backend/role_grant_participation.ts';
import { default_in_process_suite_options } from '$lib/testing/cross_backend/in_process_setup.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints,
	spine_session_options
} from '$lib/testing/cross_backend/default_spine_surface.ts';
import { SPINE_PARTICIPANT_ROLE } from '$lib/testing/cross_backend/spine_surface_constants.ts';

import {
	conformance_participation_cases,
	PARTICIPATION_HOLDER_USERNAME
} from './conformance_participation_cases.ts';

const suite_options = default_in_process_suite_options({
	session_options: spine_session_options,
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: spine_rpc_endpoints,
	// Keeper needs ROLE_ADMIN to clear the dispatcher admin gate; the
	// `role_holder` principal holds the admin-grantable `participant` role,
	// seeded directly at the bootstrap cradle (an offer would 403 it first).
	extra_keeper_roles: [ROLE_ADMIN],
	extra_accounts: [{ username: PARTICIPATION_HOLDER_USERNAME, roles: [SPINE_PARTICIPANT_ROLE] }]
});

describe_conformance_table_tests({
	...suite_options,
	cases: conformance_participation_cases,
	principals: { role_holder: PARTICIPATION_HOLDER_USERNAME },
	suite_name: 'role-gated participation conformance (in-process)'
});

describe_role_grant_participation_cross_tests({ setup_test: suite_options.setup_test });
