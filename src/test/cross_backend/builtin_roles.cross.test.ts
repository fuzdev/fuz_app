/**
 * The role-shaped suites on the builtin roles, as a backend whose registry
 * holds no app roles runs them: `cell_grant_role` granting to `ROLE_KEEPER`,
 * `role_grant_offer_lifecycle` and `role_grant_participation` offering and
 * conferring `ROLE_ADMIN` (the scoped-assign case skips — a builtin is
 * global-only) — and the socket-opening suites with their accounts holding
 * `ROLE_ADMIN` (`ws_account_roles`). Pins the role options the spine's own
 * wiring leaves at their defaults. Runs under `cross_backend_ts_node` only
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
import { describe_credential_deadline_cross_tests } from '#lib/testing/cross_backend/credential_deadline.ts';
import { describe_session_cap_cross_tests } from '#lib/testing/cross_backend/session_cap.ts';
import { describe_cross_process_ws_tests } from '#lib/testing/cross_backend/ws_round_trip.ts';

const handle = inject_backend_handle();
const { capabilities, rpc_path, base_url, ws_path } = handle.config;

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

// the socket-opening suites with admin accounts, as on a backend whose WS
// upgrade is admin-gated (this one's isn't: the path is what's pinned)
describe('builtin roles: socket accounts holding admin', () => {
	describe_cross_process_ws_tests({
		setup_test: default_cross_process_setup(handle),
		capabilities,
		base_url,
		ws_path,
		rpc_path,
		ws_account_roles: [ROLE_ADMIN]
	});
	describe_session_cap_cross_tests({
		setup_test: default_cross_process_setup(handle),
		ws: { base_url, ws_path },
		ws_account_roles: [ROLE_ADMIN]
	});
	describe_credential_deadline_cross_tests({
		setup_test: default_cross_process_setup(handle),
		capabilities,
		base_url,
		ws_path,
		rpc_path,
		ws_account_roles: [ROLE_ADMIN]
	});
});
