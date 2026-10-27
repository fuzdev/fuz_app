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
 * space is gated by the space's `policy[kind] = {min_role, moderation_required}`
 * (the root's manage-tier `policy` column), with the moderation outcome folded
 * into the verdict; plain parentless creates stay open. The suite asserts all
 * spines agree on:
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
 * - **a soft-deleted root refuses contributions** — soft delete doesn't
 *   cascade, so a live post can sit under a deleted space; a comment under it
 *   → **404** `cell_not_found`, the same shape as a missing parent (the
 *   authorizer never sees a root id without its data).
 * - **clone is no side door** — `cell_clone` runs the authorizer for every cell
 *   it writes as a parentless create, so a non-admin clone of a viewable
 *   `space` root → **403** `cell_create_forbidden`; admin → succeeds.
 * - **the root policy is the manager's** — `cell_policy_set` writes it (the new
 *   and the previous policy audited), answers an editor-grant holder **403**
 *   `cell_policy_manage_only` and a non-viewer the 404 mask, refuses a
 *   contribution `cell_policy_root_only` (as `cell_create` refuses a policy
 *   beside a `parent_id`), and passes each policy through the authorizer's
 *   validation (`cell_policy_invalid`); an editor rewriting the root's
 *   `data.policy` leaves moderation as the column says. The refusal with no
 *   authorizer mounted (`cell_policy_unsupported`) can't run here — both spines
 *   mount one — and is pinned in-process on each.
 *
 * Gated on `capabilities.cell_gated_create` — `true` only on the reference
 * spine binaries that mount the policy, so it skips for generic consumers and
 * the in-process default app (the authorizer hook's in-process coverage is the
 * standalone `auth/cell_create_authorize.db.test.ts`).
 *
 * @module
 */

import { describe, assert } from 'vitest';

import {
	CellCreateOutput,
	CellGetOutput,
	CellPolicySetOutput,
	CellUpdateOutput
} from '../../auth/cell_action_specs.ts';
import { CellGrantCreateOutput } from '../../auth/cell_grant_action_specs.ts';
import { list_audit_events } from './audit_cross_helpers.ts';
import { test_if } from './capabilities.ts';
import { cross_rpc_call, error_reason, expect_output } from './cross_rpc.ts';
import type { RpcPathCapabilityGatedCrossSuiteOptions } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import {
	PARTICIPATION_ROLE,
	SPACE_CELL_KIND,
	TEST_SPACE_POLICY
} from './test_cell_gated_create_authorize.ts';

export const describe_cell_gated_create_cross_tests = (
	options: RpcPathCapabilityGatedCrossSuiteOptions
): void => {
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
						{ kind: SPACE_CELL_KIND, data: {}, policy: TEST_SPACE_POLICY, visibility: 'public' },
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
						{ kind: SPACE_CELL_KIND, data: {}, policy: TEST_SPACE_POLICY, visibility: 'public' },
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
						{ kind: SPACE_CELL_KIND, data: {}, policy: TEST_SPACE_POLICY, visibility: 'public' },
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
						{ kind: SPACE_CELL_KIND, data: {}, policy: TEST_SPACE_POLICY, visibility: 'private' },
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
						{ kind: SPACE_CELL_KIND, data: {}, policy: TEST_SPACE_POLICY, visibility: 'public' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);
				const participant = await fixture.create_account({
					username: 'deep_participant',
					roles: [PARTICIPATION_ROLE]
				});

				// A post lives directly under the space — the shallow case
				// (`root_id === parent_id`), so the handler reuses the parent row's
				// `policy`. The post is gated `moderation_required: true`, so it's
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
				// policy, not the post's. This is the only case that exercises the
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

		test_if(
			capabilities.cell_gated_create,
			'a contribution under a soft-deleted root is 404 cell_not_found (the missing-parent shape)',
			async () => {
				const fixture = await setup_test();
				const admin_headers = fixture.create_session_headers();
				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: {}, policy: TEST_SPACE_POLICY, visibility: 'public' },
						admin_headers
					),
					CellCreateOutput
				);
				const participant = await fixture.create_account({
					username: 'tombstone_participant',
					roles: [PARTICIPATION_ROLE]
				});
				const participant_headers = participant.create_session_headers();
				const post = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'post', data: {}, parent_id: space.cell.id },
						participant_headers
					),
					CellCreateOutput
				);
				// Soft delete doesn't cascade: the post stays live (and viewable by
				// its author) under the tombstoned space.
				const deleted = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_delete',
					{ cell_id: space.cell.id },
					admin_headers
				);
				assert.ok(deleted.ok, `cell_delete failed: ${JSON.stringify(deleted.error)}`);

				const refused = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{ kind: 'comment', data: {}, parent_id: post.cell.id },
					participant_headers
				);
				assert.ok(!refused.ok, 'a contribution under a deleted root must be refused');
				assert.strictEqual(error_reason(refused), 'cell_not_found');
				// Byte-identical to the missing-parent refusal.
				const missing_parent = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{ kind: 'comment', data: {}, parent_id: '00000000-0000-4000-8000-000000000000' },
					participant_headers
				);
				assert.deepStrictEqual(refused.error, missing_parent.error);
			}
		);

		describe('cell root policy parity', () => {
			test_if(
				capabilities.cell_gated_create,
				'a root takes a policy at create and through cell_policy_set, audited old and new',
				async () => {
					const fixture = await setup_test();
					const admin_headers = fixture.create_session_headers();
					const space = expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_create',
							{ kind: SPACE_CELL_KIND, data: {}, policy: TEST_SPACE_POLICY, visibility: 'public' },
							admin_headers
						),
						CellCreateOutput
					);
					assert.deepStrictEqual(
						space.cell.policy,
						TEST_SPACE_POLICY,
						'the create stores the policy'
					);
					// Any viewer reads it.
					const stranger = await fixture.create_account({ username: 'policy_reader' });
					const read = expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_get',
							{ id: space.cell.id },
							stranger.create_session_headers()
						),
						CellGetOutput
					);
					assert.deepStrictEqual(read.cell.policy, TEST_SPACE_POLICY);

					const opened = { post: { min_role: PARTICIPATION_ROLE, moderation_required: false } };
					const set = expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_policy_set',
							{ cell_id: space.cell.id, policy: opened },
							admin_headers
						),
						CellPolicySetOutput
					);
					assert.deepStrictEqual(set.cell.policy, opened);
					const participant = await fixture.create_account({
						username: 'policy_participant',
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
					assert.strictEqual(post.cell.moderation, 'approved', 'the new policy governs');
					assert.strictEqual(post.cell.policy, null, 'a contribution carries no policy');

					const cleared = expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_policy_set',
							{ cell_id: space.cell.id, policy: null },
							admin_headers
						),
						CellPolicySetOutput
					);
					assert.strictEqual(cleared.cell.policy, null);

					const events = await list_audit_events(
						fixture,
						{ event_type: 'cell_policy_set' },
						rpc_path
					);
					assert.deepStrictEqual(
						events.map((e) => e.metadata).reverse(),
						[
							{ cell_id: space.cell.id, policy: opened, previous_policy: TEST_SPACE_POLICY },
							{ cell_id: space.cell.id, policy: null, previous_policy: opened }
						],
						'each set is audited with the policy it wrote and the one it replaced'
					);
				}
			);

			test_if(
				capabilities.cell_gated_create,
				'a policy is root-only and must pass the authorizer',
				async () => {
					const fixture = await setup_test();
					const admin_headers = fixture.create_session_headers();
					const space = expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_create',
							{ kind: SPACE_CELL_KIND, data: {}, policy: TEST_SPACE_POLICY, visibility: 'public' },
							admin_headers
						),
						CellCreateOutput
					);
					const react = expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_create',
							{ kind: 'react', data: {}, parent_id: space.cell.id },
							admin_headers
						),
						CellCreateOutput
					);
					const on_contribution = await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_policy_set',
						{ cell_id: react.cell.id, policy: TEST_SPACE_POLICY },
						admin_headers
					);
					assert.ok(!on_contribution.ok);
					assert.strictEqual(error_reason(on_contribution), 'cell_policy_root_only');
					const beside_parent = await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'react', data: {}, parent_id: space.cell.id, policy: TEST_SPACE_POLICY },
						admin_headers
					);
					assert.ok(!beside_parent.ok);
					assert.strictEqual(error_reason(beside_parent), 'cell_policy_root_only');

					for (const bad of [
						{ post: true },
						{ post: { min_role: 1 } },
						{ post: { other: true } }
					]) {
						const refused = await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_policy_set',
							{ cell_id: space.cell.id, policy: bad },
							admin_headers
						);
						assert.ok(!refused.ok, JSON.stringify(bad));
						assert.strictEqual(error_reason(refused), 'cell_policy_invalid', JSON.stringify(bad));
						const refused_create = await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_create',
							{ kind: SPACE_CELL_KIND, data: {}, policy: bad },
							admin_headers
						);
						assert.strictEqual(
							error_reason(refused_create),
							'cell_policy_invalid',
							JSON.stringify(bad)
						);
					}
				}
			);

			test_if(
				capabilities.cell_gated_create,
				"an editor-grant holder can't change a root's policy, through the verb or through data",
				async () => {
					const fixture = await setup_test();
					// A non-admin's root (a parentless non-`space` kind is open), its
					// policy moderating posts.
					const owner = await fixture.create_account({ username: 'policy_owner' });
					const owner_headers = owner.create_session_headers();
					const root = expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_create',
							{ kind: 'forum', data: {}, policy: TEST_SPACE_POLICY, visibility: 'public' },
							owner_headers
						),
						CellCreateOutput
					);
					const editor = await fixture.create_account({ username: 'policy_editor' });
					expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_grant_create',
							{
								cell_id: root.cell.id,
								level: 'editor',
								principal: { kind: 'actor', actor_id: editor.actor.id }
							},
							owner_headers
						),
						CellGrantCreateOutput
					);
					const editor_headers = editor.create_session_headers();
					const opened = { post: { min_role: PARTICIPATION_ROLE, moderation_required: false } };
					const refused = await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_policy_set',
						{ cell_id: root.cell.id, policy: opened },
						editor_headers
					);
					assert.ok(!refused.ok, 'an editor must not set the policy');
					assert.strictEqual(error_reason(refused), 'cell_policy_manage_only');

					// The editor may rewrite `data` — a `data.policy` is just content.
					const edited = expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_update',
							{ cell_id: root.cell.id, data: { policy: opened } },
							editor_headers
						),
						CellUpdateOutput
					);
					assert.deepStrictEqual(
						edited.cell.policy,
						TEST_SPACE_POLICY,
						'a data write leaves the policy'
					);
					const participant = await fixture.create_account({
						username: 'policy_poster',
						roles: [PARTICIPATION_ROLE]
					});
					const post = expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_create',
							{ kind: 'post', data: {}, parent_id: root.cell.id },
							participant.create_session_headers()
						),
						CellCreateOutput
					);
					assert.strictEqual(
						post.cell.moderation,
						'pending',
						"moderation follows the root's policy column, not its `data.policy`"
					);

					// Someone who can't view a private root gets the mask.
					const hidden = expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_create',
							{ kind: 'forum', data: {}, policy: TEST_SPACE_POLICY },
							owner_headers
						),
						CellCreateOutput
					);
					const masked = await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_policy_set',
						{ cell_id: hidden.cell.id, policy: opened },
						editor_headers
					);
					assert.strictEqual(error_reason(masked), 'cell_not_found');
				}
			);
		});
	});
};
