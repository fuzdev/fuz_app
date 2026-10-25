/**
 * Cross-process role-grant-offer decline + retract refusals for fuz_app's own
 * spine over real HTTP: a non-party's decline or retract masked as a missing
 * offer, a decided offer refused as terminal, and the audit rows a success
 * writes and a refusal does not, against each spawned backend — the TS spine
 * binaries + the Rust `testing_spine_stub`. The verbs are on every spine, so
 * the suite is ungated. In-process leg: `conformance_participation.db.test.ts`.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_role_grant_offer_lifecycle_cross_tests } from '#lib/testing/cross_backend/role_grant_offer_lifecycle.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle, {
	reject_unknown_audit_metadata_keys: true
});
const { rpc_path } = handle.config;

describe_role_grant_offer_lifecycle_cross_tests({ setup_test, rpc_path });
