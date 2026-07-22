import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **parent-aware cell-creation authorizer**
 * (`CellCreateAuthorize`) — the directory model.
 *
 * The authorizer adds no method, column, or wire shape, so the schema-snapshot
 * and action-manifest parity gates are **blind** to a TS↔Rust authorizer
 * divergence (the authorizer in the wrong phase, a different deny shape, the
 * 404/403 split, the moderation outcome). This behavioral cross case is the
 * only gate that catches one — proven *here in fuz_app*, against both reference
 * spines.
 *
 * Both spines mount the same directory-model policy (the TS spine binary via
 * `create_test_cell_gated_create_authorize`, the Rust `testing_spine_stub` via
 * `TestCellGatedCreateAuthorize`): admin bypasses; a non-admin creating a
 * `kind: 'space'` **root** is denied (admin-only); a **contribution** under a
 * space is gated by the space's `data.policy[kind] = {min_role, moderation_required}`,
 * with the moderation outcome folded into the verdict; plain parentless creates
 * stay open. The suite asserts all spines agree on:
 *
 * - **root-create admin-only** — a non-admin `space` root → **403**
 *   `cell_create_forbidden`; admin → succeeds.
 * - **contribution gated by the root's policy** — under a public space, an
 *   unauthorized stranger → **403**; a `participant` → succeeds.
 * - **moderation per `moderation_required`** — a `participant`'s `post`
 *   (`moderation_required: true`) is born `moderation: 'pending'` + private; a
 *   `react` (`moderation_required: false`) is born `moderation: 'approved'` at
 *   the author's visibility.
 * - **404 on a hidden parent vs 403 on a visible one** — a contribution under a
 *   **private** space the caller can't view → **404** `cell_not_found` (the
 *   parent is masked); under a **public** space → **403** (you see it, you
 *   can't contribute).
 *
 * Gated on `capabilities.cell_gated_create` — `true` only on the reference
 * spine binaries that mount the policy, so it skips for generic consumers and
 * the in-process default app (the authorizer hook's in-process coverage is the
 * standalone `auth/cell_create_authorize.db.test.ts`).
 *
 * `$lib`-free by contract (relative specifiers only).
 *
 * @module
 */

import { describe, assert } from 'vitest';

import { CellCreateOutput, CellModerateOutput } from '../../auth/cell_action_specs.ts';
import { test_if } from './capabilities.ts';
import { cross_rpc_call, error_reason, expect_output } from './cell_cross_helpers.ts';
import type { RpcPathCrossSuiteOptions } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import { SPACE_CELL_KIND, PARTICIPATION_ROLE } from './test_cell_gated_create_authorize.ts';

/**
 * A space `data.policy` mirroring the test ladder: gated `post` (moderated) +
 * `react` (live) + `comment` (live). `comment` exists so the deep-case test can
 * create a comment under a post (`root_id !== parent_id`) and prove the policy
 * resolves from the governing root (the space), not the immediate parent.
 */
const SPACE_POLICY = {
	policy: {
		post: { min_role: PARTICIPATION_ROLE, moderation_required: true },
		react: { min_role: PARTICIPATION_ROLE, moderation_required: false },
		comment: { min_role: PARTICIPATION_ROLE, moderation_required: false }
	}
};

export const describe_cell_gated_create_cross_tests = (options: RpcPathCrossSuiteOptions): void => {
	const { setup_test, capabilities } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('cell_gated_create authorizer parity (directory model)', () => {
		test_if(
			capabilities.cell_gated_create,
			'a non-admin is denied a `space` root (admin-only), admin succeeds',
			async () => {
				const fixture = await setup_test();
				const stranger = await fixture.create_account({ username: 'space_stranger' });
				const denied = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{ kind: SPACE_CELL_KIND, data: {} },
					stranger.create_session_headers()
				);
				assert.ok(!denied.ok, 'a non-admin must not create a space root');
				assert.strictEqual(error_reason(denied), 'cell_create_forbidden');

				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(space.cell.kind, SPACE_CELL_KIND, 'admin creates the space root');
				assert.strictEqual(space.cell.parent_id, null, 'a root is parentless');
				assert.strictEqual(space.cell.root_id, null, 'a root has no governing root');
				assert.strictEqual(
					space.cell.moderation,
					null,
					'a root carries no moderation marker even under a mounted authorizer (moderation is a contribution concept)'
				);
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a contribution under a public space: unauthorized → 403, participant → allowed',
			async () => {
				const fixture = await setup_test();
				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);

				// A non-participant sees the public space but can't contribute → 403.
				const stranger = await fixture.create_account({ username: 'post_stranger' });
				const forbidden = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{ kind: 'post', data: {}, parent_id: space.cell.id },
					stranger.create_session_headers()
				);
				assert.ok(!forbidden.ok, 'a non-participant must not post in the space');
				assert.strictEqual(error_reason(forbidden), 'cell_create_forbidden');

				// A participant may post; the contribution carries the directory edges.
				const participant = await fixture.create_account({
					username: 'post_participant',
					roles: [PARTICIPATION_ROLE]
				});
				const post = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'post', data: {}, parent_id: space.cell.id },
						participant.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(post.cell.parent_id, space.cell.id, 'parent edge set');
				assert.strictEqual(post.cell.root_id, space.cell.id, 'root resolved to the space');
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'moderation is set per `moderation_required` (post → pending+private, react → approved)',
			async () => {
				const fixture = await setup_test();
				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);
				const participant = await fixture.create_account({
					username: 'mod_participant',
					roles: [PARTICIPATION_ROLE]
				});

				// `post` requires moderation → born pending + forced private.
				const post = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'post', data: {}, parent_id: space.cell.id, visibility: 'public' },
						participant.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(post.cell.moderation, 'pending', 'gated post is born pending');
				assert.strictEqual(
					post.cell.visibility,
					'private',
					'a pending contribution is forced private until approved'
				);

				// `react` does not require moderation → born approved at the author's visibility.
				const react = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'react', data: {}, parent_id: space.cell.id, visibility: 'public' },
						participant.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(react.cell.moderation, 'approved', 'unmoderated kind is born approved');
				assert.strictEqual(react.cell.visibility, 'public', "the author's visibility is honored");
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a contribution under a hidden (private) space is 404-masked (not 403)',
			async () => {
				const fixture = await setup_test();
				// A private space — only admin/owner can view it.
				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'private' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);
				const stranger = await fixture.create_account({ username: 'hidden_stranger' });
				const masked = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{ kind: 'post', data: {}, parent_id: space.cell.id },
					stranger.create_session_headers()
				);
				assert.ok(!masked.ok, 'a stranger must not contribute under a hidden space');
				assert.strictEqual(
					error_reason(masked),
					'cell_not_found',
					'a hidden parent 404-masks the attempt (never reveals it exists)'
				);
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a deep contribution (comment under a post) resolves policy from the governing root, not the parent',
			async () => {
				const fixture = await setup_test();
				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);
				const participant = await fixture.create_account({
					username: 'deep_participant',
					roles: [PARTICIPATION_ROLE]
				});

				// A post lives directly under the space — the shallow case
				// (`root_id === parent_id`), so the handler reuses the parent row as
				// `root_data`. The post is gated `moderation_required: true`, so it's
				// born pending + private; the author can still view their own pending
				// cell, so it's a valid parent for the comment below.
				const post = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'post', data: {}, parent_id: space.cell.id },
						participant.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(post.cell.root_id, space.cell.id, 'a post roots at the space');

				// A comment lives under the post — the DEEP case. Here
				// `root_id !== parent_id`, so the handler must read the governing
				// root (the space) *through* the post (the separate in-tx root read),
				// and the authorizer must resolve `policy.comment` from the SPACE's
				// data, not the post's. This is the only case that exercises the
				// deep-read branch on both spines.
				const comment = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'comment', data: {}, parent_id: post.cell.id },
						participant.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(
					comment.cell.parent_id,
					post.cell.id,
					'the immediate parent is the post'
				);
				assert.strictEqual(
					comment.cell.root_id,
					space.cell.id,
					'the governing root resolves to the space (deep read through the post), not the post'
				);
				assert.strictEqual(
					comment.cell.moderation,
					'approved',
					'the comment policy (moderation_required: false) resolved from the space, not the post'
				);
			}
		);
	});
};

/**
 * Cross-backend parity for the **`cell_moderate` verb** (the `pending →
 * approved | rejected` transition) — root-authority-gated.
 *
 * Builds a moderated public space (admin) + a `participant`'s `post` (born
 * `pending` + private under the `moderation_required: true` policy), then
 * proves both spines agree:
 *
 * - **a root manager (admin) approves** → `moderation: 'approved'` +
 *   `visibility: 'public'` (the contribution goes live).
 * - **the author cannot self-approve** → `403 cell_moderate_forbidden` (the
 *   author can *view* their own pending cell, so they reach the gate, and are
 *   denied — moderation authority is over the governing root, not the
 *   contribution).
 * - **a non-viewer is 404-masked** → a stranger who can't see the pending
 *   contribution gets `cell_not_found`, never learns it exists.
 * - **reject** → `moderation: 'rejected'`, visibility stays private.
 *
 * Gated on `capabilities.cell_gated_create` — a `pending` contribution only
 * exists when the directory authorizer is mounted (reference spine binaries).
 *
 * `$lib`-free by contract (relative specifiers only).
 */
export const describe_cell_moderate_cross_tests = (options: RpcPathCrossSuiteOptions): void => {
	const { setup_test, capabilities } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	// Build an admin-owned public space (moderated `post` policy) + a
	// participant's pending post under it.
	const setup_pending_post = async () => {
		const fixture = await setup_test();
		const space = expect_output(
			await cross_rpc_call(
				fixture.transport,
				rpc_path,
				'cell_create',
				{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
				fixture.create_session_headers()
			),
			CellCreateOutput
		);
		const author = await fixture.create_account({
			username: 'moderate_author',
			roles: [PARTICIPATION_ROLE]
		});
		const post = expect_output(
			await cross_rpc_call(
				fixture.transport,
				rpc_path,
				'cell_create',
				{ kind: 'post', data: {}, parent_id: space.cell.id },
				author.create_session_headers()
			),
			CellCreateOutput
		);
		return { fixture, author, post };
	};

	describe('cell_moderate verb parity (root-authority-gated)', () => {
		test_if(
			capabilities.cell_gated_create,
			'a root manager (admin) approves a pending post → approved + public',
			async () => {
				const { fixture, post } = await setup_pending_post();
				assert.strictEqual(post.cell.moderation, 'pending', 'the post is born pending');
				const moderated = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_moderate',
						{ cell_id: post.cell.id, moderation: 'approved' },
						fixture.create_session_headers() // keeper = admin = root manager
					),
					CellModerateOutput
				);
				assert.strictEqual(moderated.cell.moderation, 'approved', 'approval sets the marker');
				assert.strictEqual(moderated.cell.visibility, 'public', 'approval publishes the post');
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'the author (non-manager) cannot moderate their own pending post → 403',
			async () => {
				const { fixture, author, post } = await setup_pending_post();
				const denied = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_moderate',
					{ cell_id: post.cell.id, moderation: 'approved' },
					author.create_session_headers()
				);
				assert.ok(!denied.ok, 'the author must not self-approve');
				assert.strictEqual(error_reason(denied), 'cell_moderate_forbidden');
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a non-viewer is 404-masked from moderating a pending post',
			async () => {
				const { fixture, post } = await setup_pending_post();
				const stranger = await fixture.create_account({ username: 'moderate_stranger' });
				const masked = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_moderate',
					{ cell_id: post.cell.id, moderation: 'approved' },
					stranger.create_session_headers()
				);
				assert.ok(!masked.ok, 'a non-viewer must not moderate');
				assert.strictEqual(
					error_reason(masked),
					'cell_not_found',
					'a non-viewer never learns the pending post exists'
				);
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a root manager rejects a pending post → rejected, stays private',
			async () => {
				const { fixture, post } = await setup_pending_post();
				const moderated = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_moderate',
						{ cell_id: post.cell.id, moderation: 'rejected' },
						fixture.create_session_headers()
					),
					CellModerateOutput
				);
				assert.strictEqual(moderated.cell.moderation, 'rejected', 'rejection sets the marker');
				assert.strictEqual(
					moderated.cell.visibility,
					'private',
					'rejection leaves the post private'
				);
			}
		);
	});
};
