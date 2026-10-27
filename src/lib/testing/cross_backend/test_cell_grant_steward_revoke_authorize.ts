import '../assert_dev_env.ts';

/**
 * Test `CellGrantRevokeAuthorize` policy mounted on **both** reference spines —
 * the TS spine binary's full mount (`full_spine_mount.ts`) and the Rust
 * `testing_spine_stub` — so the cross-backend `cell_grant_steward` suite proves
 * the steward-revoke seam agrees TS↔Rust. The twin of the Rust
 * `TestCellGrantStewardRevokeAuthorize`.
 *
 * The caller stewards a scope when it holds an active `participant` grant bound
 * to that scope. The spine asks only for a non-manager, non-grantee caller
 * revoking a role-shaped grant with a scope, so the policy reads the scope
 * alone; it is pure, with no DB read of its own.
 *
 * @module
 */

import { has_scoped_role } from '../../auth/request_context.ts';
import type { CellGrantRevokeAuthorize } from '../../auth/cell_grant_actions.ts';
import { SPINE_PARTICIPANT_ROLE } from './spine_surface_constants.ts';

/**
 * The steward-revoke test policy: a scoped `SPINE_PARTICIPANT_ROLE` grant
 * stewards its scope.
 */
export const test_cell_grant_steward_revoke_authorize: CellGrantRevokeAuthorize = (auth, input) =>
	has_scoped_role(auth, SPINE_PARTICIPANT_ROLE, input.scope_id);
