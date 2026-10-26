/**
 * The role-shaped suites on the builtin roles, as a backend whose registry
 * holds no app roles runs them: `cell_grant_role` granting to `ROLE_KEEPER`,
 * `role_grant_offer_lifecycle` and `role_grant_participation` offering and
 * conferring `ROLE_ADMIN` (the scoped-assign case skips — a builtin is
 * global-only). Pins the `role` options the spine's own wiring leaves at
 * their defaults. Runs under `cross_backend_ts_node` only
 * (`NODE_ONLY_CROSS_TESTS`): the option paths are the harness's, the same on
 * every backend, and `spine_suites.cross.test.ts` already holds each backend
 * to the suites.
 *
 * @module
 */

import { describe } from 'vitest';

import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import {
	CELL_ROLE_HOLDER_USERNAME,
	describe_cell_grant_role_cross_tests
} from '#lib/testing/cross_backend/cell_grant_role.ts';
import { inject_backend_handle } from '#lib/testing/cross_backend/provided_context.ts';
import { describe_role_grant_offer_lifecycle_cross_tests } from '#lib/testing/cross_backend/role_grant_offer_lifecycle.ts';
import { describe_role_grant_participation_cross_tests } from '#lib/testing/cross_backend/role_grant_participation.ts';
import { default_cross_process_setup } from '#lib/testing/cross_backend/setup.ts';

const handle = inject_backend_handle();
const { capabilities, rpc_path } = handle.config;

describe('builtin roles: cell_grant_role on keeper', () => {
	describe_cell_grant_role_cross_tests({
		setup_test: default_cross_process_setup(handle, {
			extra_accounts: [{ username: CELL_ROLE_HOLDER_USERNAME, roles: [ROLE_KEEPER] }]
		}),
		capabilities,
		rpc_path,
		role: ROLE_KEEPER
	});
});

describe('builtin roles: offer lifecycle on admin', () => {
	describe_role_grant_offer_lifecycle_cross_tests({
		setup_test: default_cross_process_setup(handle),
		rpc_path,
		role: ROLE_ADMIN
	});
});

describe('builtin roles: participation on admin', () => {
	describe_role_grant_participation_cross_tests({
		setup_test: default_cross_process_setup(handle),
		rpc_path,
		role: ROLE_ADMIN
	});
});
