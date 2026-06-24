/**
 * Cross-process leg of the role-gated-participation capstone.
 *
 * Proves the TS spine binary (node/deno/bun) and the Rust `testing_spine_stub`
 * agree, over real HTTP, on conferral of the admin-grantable `participant`
 * app-role: (a) grantability, (b) admin-only conferral (no holder-propagation),
 * (c) `role_grant_assign`. The single-request matrix runs through the
 * declarative `conformance_participation_cases`; the multi-step success paths
 * (assign-lands, offer→accept-lands) run through the imperative escape-hatch
 * suite. Same cases as the in-process leg
 * (`conformance_participation.db.test.ts`) — same-green pins TS↔Rust parity.
 *
 * @module
 */

import {inject} from 'vitest';

import {ROLE_ADMIN} from '$lib/auth/role_schema.ts';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.ts';
import {describe_conformance_table_tests} from '$lib/testing/cross_backend/conformance_table.ts';
import {describe_role_grant_participation_cross_tests} from '$lib/testing/cross_backend/role_grant_participation.ts';
import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_session_options,
} from '$lib/testing/cross_backend/default_spine_surface.ts';
import {SPINE_PARTICIPANT_ROLE} from '$lib/testing/cross_backend/spine_surface_constants.ts';

import {
	conformance_participation_cases,
	PARTICIPATION_HOLDER_USERNAME,
} from './conformance_participation_cases.ts';
import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
// `ROLE_ADMIN` on the per-test keeper so the `keeper` principal clears the
// dispatcher admin gate; a non-admin holder of `participant` seeded as the
// `role_holder` principal (its `grant_paths: ['admin']` would otherwise reject
// at offer time, so the bootstrap-cradle seed is the only path).
const setup_test = default_cross_process_setup(handle, {
	extra_keeper_roles: [ROLE_ADMIN],
	extra_accounts: [{username: PARTICIPATION_HOLDER_USERNAME, roles: [SPINE_PARTICIPANT_ROLE]}],
});
const {capabilities, rpc_path} = handle.config;

describe_conformance_table_tests({
	cases: conformance_participation_cases,
	setup_test,
	surface_source: create_spine_surface_spec(),
	capabilities,
	rpc_endpoints: spine_rpc_endpoints,
	session_options: spine_session_options,
	principals: {role_holder: PARTICIPATION_HOLDER_USERNAME},
	suite_name: 'role-gated participation conformance (cross-process)',
});

describe_role_grant_participation_cross_tests({setup_test, rpc_path});
