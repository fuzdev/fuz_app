/**
 * Cross-process role_grant_offer_accept enumeration parity for fuz_app's own
 * spine over real HTTP. Companion to `conformance_security_cases.ts`'s IDOR
 * masks: pins the deliberate 403 (intra-account sibling-actor mismatch) vs 404
 * (cross-principal not-found) split on the accept path against each spawned
 * backend — the TS spine binaries + the Rust `testing_spine_stub`. The keeper
 * is seeded multi-actor so the actor-mismatch arm is reachable. The accept verb
 * is on every spine, so the suite is ungated.
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.ts';
import {ROLE_ADMIN} from '$lib/auth/role_schema.ts';
import {
	describe_role_grant_offer_enumeration_cross_tests,
	OFFER_GRANTOR_USERNAME,
} from '$lib/testing/cross_backend/role_grant_offer_enumeration.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
// Seed the keeper with a sibling actor (the actor-targeted offer is rejected for
// the wrong persona — the 403 actor_mismatch arm), plus a single-actor admin
// grantor (the keeper can't offer to itself, and being multi-actor can't offer
// without an `acting`).
const setup_test = default_cross_process_setup(handle, {
	extra_actors: ['offer_sibling'],
	extra_accounts: [{username: OFFER_GRANTOR_USERNAME, roles: [ROLE_ADMIN]}],
});
const {rpc_path} = handle.config;

describe_role_grant_offer_enumeration_cross_tests({setup_test, rpc_path});
