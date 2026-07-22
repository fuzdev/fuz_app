/**
 * Cross-process role-shaped `cell_grant` parity for fuz_app's own spine over
 * real HTTP. Drives the role-validity gate (admit holder, exclude non-holder,
 * reject unregistered role, editor-level edit) against each spawned backend —
 * the TS spine binaries + the Rust `testing_spine_stub`. The cell surface is
 * live-mounted off the declared surface on every spine, so the suite is
 * ungated. The `cell_editor`-holding account is seeded via `extra_accounts`
 * (the role has no grant path, so the bootstrap-cradle seed is the only way
 * to grant it).
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import {
	describe_cell_grant_role_cross_tests,
	CELL_EDITOR_ROLE,
	CELL_ROLE_HOLDER_USERNAME
} from '$lib/testing/cross_backend/cell_grant_role.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle, {
	extra_accounts: [{ username: CELL_ROLE_HOLDER_USERNAME, roles: [CELL_EDITOR_ROLE] }]
});
const { capabilities, rpc_path } = handle.config;

describe_cell_grant_role_cross_tests({ setup_test, capabilities, rpc_path });
