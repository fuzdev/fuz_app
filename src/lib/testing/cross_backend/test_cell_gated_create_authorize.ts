import '../assert_dev_env.ts';

/**
 * Test `CellCreateAuthorize` policy mounted on **both** reference spines — the
 * TS spine binary's full mount (`full_spine_mount.ts`) and the Rust
 * `testing_spine_stub` — so the cross-backend `cell_gated_create` suite proves
 * the parent-aware cell-creation authorizer agrees TS↔Rust. The twin of the
 * Rust `TestCellGatedCreateAuthorize`, **directory model**.
 *
 * A **global** admin bypasses everything (`{allow: true, moderation_required:
 * false}`) — a scoped `admin` row is no admin here. For anyone else:
 *
 * - **Root creation** (`root_id` null): `kind: 'space'` is admin-only (denied);
 *   every other parentless kind stays open, so the plain-create `cell_crud` /
 *   `cell_relations` suites are unaffected.
 * - **Contribution** (`root_id` set): the governing root's
 *   `policy[kind] = {min_role?, moderation_required?}` decides — a missing
 *   entry (or no policy) denies, a present `min_role` the actor lacks globally
 *   denies, and otherwise it admits with the entry's `moderation_required`
 *   folded into the verdict. The root's policy arrives in `input.root_policy`
 *   (the handler read it in-tx), so the predicate is **pure** — no DB read of
 *   its own (which also dodges the single-connection in-memory deadlock a
 *   separate handle would hit — pglet, PGlite).
 *
 * Its `validate_policy` accepts a policy whose every entry is an object with
 * an optional string `min_role` and an optional boolean `moderation_required`,
 * and refuses any other with `ERROR_CELL_POLICY_INVALID`.
 *
 * @module
 */

import { has_scoped_role } from '../../auth/request_context.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import type { CellCreateAuthorize } from '../../auth/cell_actions.ts';
import { ERROR_CELL_POLICY_INVALID, type CellPolicy } from '../../auth/cell_action_specs.ts';
import { jsonrpc_errors } from '../../http/jsonrpc_errors.ts';
import { SPINE_PARTICIPANT_ROLE } from './spine_surface_constants.ts';

/** The admin-only root kind the test policy gates (talk's `space` analog). */
export const SPACE_CELL_KIND = 'space';

/**
 * The app-role a space policy references as `min_role` (besides admin) — the
 * `participant` role both reference spines register. Mirrors the Rust policy's
 * `"participant"` literal.
 */
export const PARTICIPATION_ROLE = SPINE_PARTICIPANT_ROLE;

/**
 * A space `policy` mirroring the test ladder: gated `post` (moderated) +
 * `react` (live) + `comment` (live), each on `PARTICIPATION_ROLE`. `comment`
 * exists so a suite can create a comment under a post (`root_id !==
 * parent_id`) and prove the policy resolves from the governing root (the
 * space), not the immediate parent. Shared by the gated-create and moderate
 * cross suites, which pass it as a root's `cell_create` `policy`.
 */
export const TEST_SPACE_POLICY = {
	post: { min_role: PARTICIPATION_ROLE, moderation_required: true },
	react: { min_role: PARTICIPATION_ROLE, moderation_required: false },
	comment: { min_role: PARTICIPATION_ROLE, moderation_required: false }
} as const;

/** A space's per-kind contribution rule (the shape of each `policy` entry). */
export interface ContributionRule {
	min_role?: string;
	moderation_required?: boolean;
}

/** Whether `value` is a `ContributionRule` — an object of only those two keys, each its type. */
const is_contribution_rule = (value: unknown): value is ContributionRule =>
	value !== null &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	Object.entries(value).every(([key, v]) => {
		if (key === 'min_role') return typeof v === 'string';
		if (key === 'moderation_required') return typeof v === 'boolean';
		return false;
	});

/** Pull the governing root's `policy[kind]` rule, defensively. */
const get_contribution_rule = (
	policy: CellPolicy | null,
	kind: string
): ContributionRule | undefined => {
	if (policy === null) return undefined;
	const rule = policy[kind];
	if (rule === null || typeof rule !== 'object') return undefined;
	return rule;
};

/**
 * The directory-model test authorizer — `authorize` is a **pure** function of
 * the input (it reads the governing root's policy off `input.root_policy`,
 * supplied by the handler). Byte-equivalent with the Rust
 * `TestCellGatedCreateAuthorize`.
 */
export const test_cell_gated_create_authorize: CellCreateAuthorize = {
	authorize: (auth, input) => {
		// Admin bypass — admins create roots + any kind, live immediately. The
		// global grant only: a scoped `admin` row bypasses nothing.
		if (has_scoped_role(auth, ROLE_ADMIN, null)) {
			return { allow: true, moderation_required: false };
		}
		// Root creation (no governing root): `space` is admin-only; other
		// parentless kinds stay open (the plain-create suites).
		if (input.root_id === null) {
			return input.kind === SPACE_CELL_KIND
				? { allow: false }
				: { allow: true, moderation_required: false };
		}
		// Contribution: resolve the governing root's per-kind policy.
		const rule = get_contribution_rule(input.root_policy, input.kind ?? '');
		if (!rule) return { allow: false };
		// `min_role` names no scope, so only the global grant satisfies it.
		const admitted = rule.min_role === undefined || has_scoped_role(auth, rule.min_role, null);
		return admitted
			? { allow: true, moderation_required: rule.moderation_required ?? false }
			: { allow: false };
	},
	validate_policy: (policy) => {
		if (!Object.values(policy).every(is_contribution_rule)) {
			throw jsonrpc_errors.invalid_params('invalid space policy', {
				reason: ERROR_CELL_POLICY_INVALID
			});
		}
	}
};
