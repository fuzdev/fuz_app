/**
 * In-process leg of the role-shaped `cell_grant` parity suite.
 *
 * Runs `describe_cell_grant_role_cross_tests` against the in-process Hono app
 * under a plain `gro test` — role grant admits a holder / excludes a
 * non-holder, unregistered-role rejection at create, and editor-level edit.
 * The cross-process leg (`cell_grant_role.cross.test.ts`) additionally drives
 * the TS spine binary + Rust `testing_spine_stub` over real HTTP behind
 * `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * Shares the full-surface `create_cell_parity_setup`, seeding the
 * `cell_editor`-holding account via `extra_accounts` (the role has no grant
 * path, so the bootstrap-cradle seed is the only way to grant it).
 *
 * @module
 */

import {in_process_capabilities} from '$lib/testing/cross_backend/capabilities.ts';
import {
	describe_cell_grant_role_cross_tests,
	CELL_EDITOR_ROLE,
	CELL_ROLE_HOLDER_USERNAME,
} from '$lib/testing/cross_backend/cell_grant_role.ts';

import {create_cell_parity_setup} from './cell_parity_helpers.ts';

describe_cell_grant_role_cross_tests({
	setup_test: create_cell_parity_setup([
		{username: CELL_ROLE_HOLDER_USERNAME, roles: [CELL_EDITOR_ROLE]},
	]),
	capabilities: in_process_capabilities,
});
