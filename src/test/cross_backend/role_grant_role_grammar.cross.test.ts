/**
 * Cross-process parity for an off-grammar `role` on the grant verbs, for
 * fuz_app's own spine over real HTTP. Drives `role_grant_assign` and
 * `role_grant_offer_create` with role strings outside the `RoleName` grammar
 * against each spawned backend — the TS spine binaries + the Rust
 * `testing_spine_stub` — and reads the audit log back: each is refused
 * `invalid_params` with no reason and leaves no audit row carrying it. Both
 * verbs are on the standard surface of every spine, so the suite is ungated.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_role_grant_role_grammar_cross_tests } from '#lib/testing/cross_backend/role_grant_role_grammar.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle, {
	reject_unknown_audit_metadata_keys: true
});
const { rpc_path } = handle.config;

describe_role_grant_role_grammar_cross_tests({ setup_test, rpc_path });
