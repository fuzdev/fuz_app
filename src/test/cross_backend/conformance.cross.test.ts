/**
 * Cross-process leg of the conformance-table runner proof.
 *
 * Runs the shared `conformance_proof_cases` over real HTTP against each
 * spawned spine (TS node/deno/bun + the Rust `testing_spine_stub`),
 * exercising each impl's real auth resolution. Same cases as the
 * in-process leg (`conformance.db.test.ts`) — same-green pins that the
 * runner drives both transports.
 *
 * @module
 */

import {inject} from 'vitest';

import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.js';
import {describe_conformance_table_tests} from '$lib/testing/cross_backend/conformance_table.js';
import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_session_options,
} from '$lib/testing/cross_backend/default_spine_surface.js';

import {conformance_proof_cases} from './conformance_proof_cases.js';
import {conformance_security_cases} from './conformance_security_cases.js';
import {conformance_expiry_cases} from './conformance_expiry_cases.js';
import './cross_test_types.js';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
// `ROLE_ADMIN` on the fresh-per-test keeper so the success case can list
// accounts; `ROLE_KEEPER` alone does not grant admin reach.
const setup_test = default_cross_process_setup(handle, {extra_keeper_roles: [ROLE_ADMIN]});
const {capabilities} = handle.config;

describe_conformance_table_tests({
	cases: [...conformance_proof_cases, ...conformance_security_cases, ...conformance_expiry_cases],
	setup_test,
	surface_source: create_spine_surface_spec(),
	capabilities,
	rpc_endpoints: spine_rpc_endpoints,
	session_options: spine_session_options,
	suite_name: 'conformance table (cross-process)',
});
