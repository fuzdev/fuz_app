import '../assert_dev_env.ts';

/**
 * Test `CellCreateAuthorize` policy mounted on **both** reference spines — the
 * TS spine binary's full mount (`full_spine_mount.ts`) and the Rust
 * `testing_spine_stub` — so the cross-backend `cell_gated_create` suite proves
 * the cell-creation authorizer agrees TS↔Rust. The twin of the Rust
 * `TestCellGatedCreateAuthorize`.
 *
 * The policy gates exactly one kind: creating a `kind: 'gated'` cell requires
 * the `participant` app-role (registered on both spines, `grant_paths:
 * ['admin']`) or admin. Every other kind — and a typeless cell — is open, so
 * the existing cell suites (which use `note` / `collection` kinds) are
 * unaffected, exactly as on the Rust stub.
 *
 * **`$lib`-free by contract** — reached by the spawned TS spine binary under
 * Gro's loader (no `$lib` alias). Keep every import relative.
 *
 * @module
 */

import {has_role, type RequestActorContext} from '../../auth/request_context.ts';
import {ROLE_ADMIN} from '../../auth/role_schema.ts';
import type {CellCreateAuthorize, CellCreateAuthorizeInput} from '../../auth/cell_actions.ts';
import {SPINE_PARTICIPANT_ROLE} from './spine_surface_constants.ts';

/** The single kind the test policy gates (shared with the driving suite). */
export const GATED_CELL_KIND = 'gated';

/**
 * The app-role that unlocks creating the gated kind (besides admin) — the
 * `participant` role both reference spines register. Mirrors the Rust policy's
 * `"participant"` literal.
 */
export const GATED_CELL_ROLE = SPINE_PARTICIPANT_ROLE;

/**
 * Allow unless the cell's `kind` is `'gated'`, in which case the actor must
 * hold the `participant` role or be a (scope-agnostic) admin. Mirrors the Rust
 * `TestCellGatedCreateAuthorize` exactly.
 */
export const test_cell_gated_create_authorize: CellCreateAuthorize = (
	auth: RequestActorContext,
	input: CellCreateAuthorizeInput,
): boolean =>
	input.kind !== GATED_CELL_KIND || has_role(auth, GATED_CELL_ROLE) || has_role(auth, ROLE_ADMIN);
