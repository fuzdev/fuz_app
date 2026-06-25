import '../assert_dev_env.ts';

/**
 * Test `CellCreateAuthorize` policy mounted on **both** reference spines — the
 * TS spine binary's full mount (`full_spine_mount.ts`) and the Rust
 * `testing_spine_stub` — so the cross-backend `cell_gated_create` suite proves
 * the parent-aware cell-creation authorizer agrees TS↔Rust. The twin of the
 * Rust `TestCellGatedCreateAuthorize`, **directory model**.
 *
 * Admin bypasses everything (`{allow: true, moderation_required: false}`). For
 * a non-admin:
 *
 * - **Root creation** (`root_id` null): `kind: 'space'` is admin-only (denied);
 *   every other parentless kind stays open, so the plain-create `cell_crud` /
 *   `cell_relations` suites are unaffected.
 * - **Contribution** (`root_id` set): the governing root's
 *   `data.policy[kind] = {min_role?, moderation_required?}` decides — a missing
 *   entry denies, a present `min_role` the actor lacks denies, and otherwise it
 *   admits with the entry's `moderation_required` folded into the verdict. The
 *   root's `data` arrives in `input.root_data` (the handler read it in-tx), so
 *   the predicate is **pure** — no DB read of its own (which also dodges the
 *   single-connection PGlite deadlock a separate handle would hit).
 *
 * **`$lib`-free by contract** — reached by the spawned TS spine binary under
 * Gro's loader (no `$lib` alias). Keep every import relative.
 *
 * @module
 */

import {has_role, type RequestActorContext} from '../../auth/request_context.ts';
import {ROLE_ADMIN} from '../../auth/role_schema.ts';
import type {
	CellCreateAuthorize,
	CellCreateAuthorizeInput,
	CellCreateVerdict,
} from '../../auth/cell_actions.ts';
import {SPINE_PARTICIPANT_ROLE} from './spine_surface_constants.ts';

/** The admin-only root kind the test policy gates (talk's `space` analog). */
export const SPACE_CELL_KIND = 'space';

/**
 * The app-role a space policy references as `min_role` (besides admin) — the
 * `participant` role both reference spines register. Mirrors the Rust policy's
 * `"participant"` literal.
 */
export const PARTICIPATION_ROLE = SPINE_PARTICIPANT_ROLE;

/** A space's per-kind contribution rule (the shape stamped into `space.data.policy`). */
export interface ContributionRule {
	min_role?: string;
	moderation_required?: boolean;
}

/** Pull the governing root's `data.policy[kind]` rule, defensively (loose `data`). */
const get_contribution_rule = (data: unknown, kind: string): ContributionRule | undefined => {
	if (data === null || typeof data !== 'object') return undefined;
	const policy = (data as Record<string, unknown>).policy;
	if (policy === null || typeof policy !== 'object') return undefined;
	const rule = (policy as Record<string, unknown>)[kind];
	if (rule === null || typeof rule !== 'object') return undefined;
	return rule as ContributionRule;
};

/**
 * The directory-model test authorizer — a **pure** function of the input (it
 * reads the governing root's policy off `input.root_data`, supplied by the
 * handler). Byte-equivalent with the Rust `TestCellGatedCreateAuthorize`.
 */
export const test_cell_gated_create_authorize: CellCreateAuthorize = (
	auth: RequestActorContext,
	input: CellCreateAuthorizeInput,
): CellCreateVerdict => {
	// Admin bypass — admins create roots + any kind, live immediately.
	if (has_role(auth, ROLE_ADMIN)) return {allow: true, moderation_required: false};
	// Root creation (no governing root): `space` is admin-only; other parentless
	// kinds stay open (the plain-create suites).
	if (input.root_id === null) {
		return input.kind === SPACE_CELL_KIND
			? {allow: false}
			: {allow: true, moderation_required: false};
	}
	// Contribution: resolve the governing root's per-kind policy.
	const rule = get_contribution_rule(input.root_data, input.kind ?? '');
	if (!rule) return {allow: false};
	const admitted = rule.min_role === undefined || has_role(auth, rule.min_role);
	return admitted
		? {allow: true, moderation_required: rule.moderation_required ?? false}
		: {allow: false};
};
