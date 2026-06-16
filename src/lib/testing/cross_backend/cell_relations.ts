import '../assert_dev_env.ts';

/**
 * Dedicated cell relation / ACL / audit parity suite for the cross-backend
 * harness — the sibling of `describe_cell_crud_cross_tests` covering every
 * cell verb beyond plain CRUD: `cell_grant_*`, `cell_field_*`,
 * `cell_item_*`, `cell_clone`, and `cell_audit_list`.
 *
 * Like the CRUD suite (and ws / sse), these verbs are live-mounted on the
 * spine RPC path but stay off the standard declared surface, so the generic
 * `describe_rpc_round_trip_tests` never drives them. Every success response
 * is parsed against the verb's declared Zod **output** schema, so a TS↔Rust
 * envelope drift fails the suite — not just a payload-field drift.
 *
 * Coverage (gated on `capabilities.cell_relations`):
 *
 * - **grant lifecycle** — owner grants an actor-shaped editor; the grantee
 *   gains edit (was 404 before the grant); `cell_grant_list` is manage-tier
 *   (owner sees it, the editor gets the IDOR 404); revoke drops the edit path.
 * - **`cell_visibility_manage_only`** — the editor-grant holder can edit
 *   content but flipping `visibility` is 403 (the case the 5-verb CRUD cut
 *   couldn't reach without a grant principal).
 * - **fields** — `cell_field_set` UPSERT, forward + reverse `cell_field_list`,
 *   idempotent `cell_field_delete`.
 * - **items** — `cell_item_insert` at fractional-index positions, forward
 *   (lex-ordered) + reverse `cell_item_list`, `cell_item_move`, idempotent
 *   `cell_item_delete`.
 * - **clone** — shallow copies item / field *edges* (shared `child_id` /
 *   `target_id`); deep clones each viewable child into a fresh cell at the
 *   same position. Both null `path` and stamp the caller as owner.
 * - **audit** — `cell_audit_list` is manage-tier: the owner reads the cell's
 *   timeline; a viewer-grant holder who can `cell_get` the cell still gets the
 *   IDOR 404 on the timeline (D14).
 * - **relation-read visibility (D8)** — listing edges toward a cell the caller
 *   can't view filters them out (no-existence-leak-via-edge): an anonymous
 *   viewer of a public parent — and a viewer-grant holder of a private parent —
 *   sees only independently-viewable children in the `cell_get` bundle and the
 *   forward `cell_item_list` / `cell_field_list`. The cross twin of the
 *   in-process `auth/cell_relation_visibility.db.test.ts`.
 * - **clone D8** — a cloner who can view a public parent but not a private child
 *   silently drops that child: an admin (who *can* view it) reading the clone
 *   still sees only the viewable edge/child, and the `cell_clone` audit row
 *   records no skipped-child count — so the source's hidden-child count can't
 *   leak to the cloner. The cross twin of `auth/cell_actions.clone.db.test.ts`.
 *
 * Only **actor-shaped** grants are exercised — role-shaped principals need a
 * closed role registry the Rust spine deliberately lacks, so role-grant
 * parity is out of scope here (the TS impl covers it in-process).
 *
 * `$lib`-free by contract (relative specifiers only) so the suite can be
 * imported from the spawnable cross-process test files.
 *
 * @module
 */

import {describe, assert} from 'vitest';
import {fractional_index_between} from '@fuzdev/fuz_util/fractional_index.ts';

import {
	CellCreateOutput,
	CellUpdateOutput,
	CellCloneOutput,
	CellGetOutput,
} from '../../auth/cell_action_specs.ts';
import {AuditLogListOutput} from '../../auth/admin_action_specs.ts';
import {
	CellGrantCreateOutput,
	CellGrantListOutput,
	CellGrantRevokeOutput,
} from '../../auth/cell_grant_action_specs.ts';
import {
	CellFieldDeleteOutput,
	CellFieldListOutput,
	CellFieldSetOutput,
} from '../../auth/cell_field_action_specs.ts';
import {
	CellItemDeleteOutput,
	CellItemInsertOutput,
	CellItemListOutput,
	CellItemMoveOutput,
} from '../../auth/cell_item_action_specs.ts';
import {CellAuditListOutput} from '../../auth/cell_audit_action_specs.ts';
import type {FetchTransport} from '../transports/fetch_transport.ts';
import {test_if} from './capabilities.ts';
import {cross_rpc_call, error_reason, expect_output} from './cell_cross_helpers.ts';
import type {RpcPathCrossSuiteOptions} from './setup.ts';
import {SPINE_RPC_PATH} from './default_spine_surface.ts';

/** Create a cell over the wire and return its id (the parity gate parses the output). */
const create_cell = async (
	t: FetchTransport,
	rpc_path: string,
	h: Record<string, string>,
	params: Record<string, unknown>,
): Promise<string> =>
	expect_output(await cross_rpc_call(t, rpc_path, 'cell_create', params, h), CellCreateOutput).cell
		.id;

/**
 * Wire `pub_child` + `priv_child` under `parent` as both ordered items and
 * named fields, using the owner's headers (owner can edit parent + view both
 * children). The cross-process twin of the in-process `wire_children` in
 * `auth/cell_relation_visibility.db.test.ts`.
 */
const wire_children = async (
	t: FetchTransport,
	rpc_path: string,
	owner_h: Record<string, string>,
	parent: string,
	pub_child: string,
	priv_child: string,
): Promise<void> => {
	const pos_a = fractional_index_between(null, null);
	const pos_b = fractional_index_between(pos_a, null);
	expect_output(
		await cross_rpc_call(
			t,
			rpc_path,
			'cell_item_insert',
			{parent_id: parent, child_id: pub_child, position: pos_a},
			owner_h,
		),
		CellItemInsertOutput,
	);
	expect_output(
		await cross_rpc_call(
			t,
			rpc_path,
			'cell_item_insert',
			{parent_id: parent, child_id: priv_child, position: pos_b},
			owner_h,
		),
		CellItemInsertOutput,
	);
	expect_output(
		await cross_rpc_call(
			t,
			rpc_path,
			'cell_field_set',
			{source_id: parent, name: 'pub_link', target_id: pub_child},
			owner_h,
		),
		CellFieldSetOutput,
	);
	expect_output(
		await cross_rpc_call(
			t,
			rpc_path,
			'cell_field_set',
			{source_id: parent, name: 'priv_link', target_id: priv_child},
			owner_h,
		),
		CellFieldSetOutput,
	);
};

/**
 * Await in-flight fire-and-forget audit writes so a following `audit_log_list`
 * is authoritative on both spines (the real await on Rust; satisfied by
 * construction on the TS spine's `await_pending_effects`). Mirrors the
 * `account_lifecycle` cross suite's barrier.
 */
const drain_effects = async (
	td: FetchTransport,
	rpc_path: string,
	daemon_h: Record<string, string>,
): Promise<void> => {
	const drained = await cross_rpc_call(td, rpc_path, '_testing_drain_effects', undefined, daemon_h);
	assert.ok(drained.ok, `_testing_drain_effects failed: ${JSON.stringify(drained.error)}`);
};

export const describe_cell_relations_cross_tests = (options: RpcPathCrossSuiteOptions): void => {
	const {setup_test, capabilities} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('cell relations parity', () => {
		test_if(
			capabilities.cell_relations,
			'grant lifecycle: editor grant enables edit; grant_list is manage-tier; revoke drops it',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_grant_owner'});
				const editor = await fixture.create_account({username: 'cell_grant_editor'});
				const t = fixture.fresh_transport();
				const owner_h = owner.create_session_headers();
				const editor_h = editor.create_session_headers();

				const cell = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_create', {data: {kind: 'note'}}, owner_h),
					CellCreateOutput,
				).cell;

				// Before the grant the editor can't even see the private cell.
				const pre = await cross_rpc_call(
					t,
					rpc_path,
					'cell_update',
					{cell_id: cell.id, data: {kind: 'note', label: 'x'}},
					editor_h,
				);
				assert.ok(!pre.ok, 'non-grantee edited a private cell');
				assert.strictEqual(error_reason(pre), 'cell_not_found');

				// Owner (manage-tier) grants the editor an actor-shaped editor grant.
				const grant = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_grant_create',
						{
							cell_id: cell.id,
							level: 'editor',
							principal: {kind: 'actor', actor_id: editor.actor.id},
						},
						owner_h,
					),
					CellGrantCreateOutput,
				).grant;
				assert.strictEqual(grant.level, 'editor');
				assert.strictEqual(grant.actor_id, editor.actor.id);
				assert.strictEqual(grant.role, null);

				// The editor can now edit content.
				const edited = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_update',
						{cell_id: cell.id, data: {kind: 'note', label: 'by editor'}},
						editor_h,
					),
					CellUpdateOutput,
				);
				assert.strictEqual(edited.cell.updated_by, editor.actor.id);

				// grant_list is manage-tier: owner sees the grant.
				const owner_grants = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_grant_list', {cell_id: cell.id}, owner_h),
					CellGrantListOutput,
				);
				assert.ok(
					owner_grants.grants.some((g) => g.id === grant.id),
					'owner grant_list omitted the grant',
				);

				// The editor (non-manage) gets the IDOR 404 on grant_list.
				const editor_grants = await cross_rpc_call(
					t,
					rpc_path,
					'cell_grant_list',
					{cell_id: cell.id},
					editor_h,
				);
				assert.ok(!editor_grants.ok, 'editor read the grant list');
				assert.strictEqual(error_reason(editor_grants), 'cell_not_found');

				// Revoke and confirm the edit path is gone.
				const revoked = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_grant_revoke', {grant_id: grant.id}, owner_h),
					CellGrantRevokeOutput,
				);
				assert.strictEqual(revoked.ok, true);
				const post = await cross_rpc_call(
					t,
					rpc_path,
					'cell_update',
					{cell_id: cell.id, data: {kind: 'note', label: 'y'}},
					editor_h,
				);
				assert.ok(!post.ok, 'revoked editor still edited');
				assert.strictEqual(error_reason(post), 'cell_not_found');
			},
		);

		test_if(
			capabilities.cell_relations,
			'editor-grant holder cannot flip visibility → cell_visibility_manage_only',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_vis_owner'});
				const editor = await fixture.create_account({username: 'cell_vis_editor'});
				const t = fixture.fresh_transport();
				const owner_h = owner.create_session_headers();
				const editor_h = editor.create_session_headers();

				const cell = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_create', {data: {kind: 'note'}}, owner_h),
					CellCreateOutput,
				).cell;
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_grant_create',
						{
							cell_id: cell.id,
							level: 'editor',
							principal: {kind: 'actor', actor_id: editor.actor.id},
						},
						owner_h,
					),
					CellGrantCreateOutput,
				);

				// Content edits pass (editor tier); a visibility write is manage-tier.
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_update',
						{cell_id: cell.id, data: {kind: 'note', label: 'ok'}},
						editor_h,
					),
					CellUpdateOutput,
				);
				const vis = await cross_rpc_call(
					t,
					rpc_path,
					'cell_update',
					{cell_id: cell.id, visibility: 'public'},
					editor_h,
				);
				assert.ok(!vis.ok, 'editor flipped visibility');
				assert.strictEqual(error_reason(vis), 'cell_visibility_manage_only');
			},
		);

		test_if(
			capabilities.cell_relations,
			'field set → forward + reverse list → idempotent delete',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_field_owner'});
				const t = fixture.fresh_transport();
				const h = owner.create_session_headers();

				const source = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_create', {data: {kind: 'note'}}, h),
					CellCreateOutput,
				).cell;
				const target = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_create', {data: {kind: 'note'}}, h),
					CellCreateOutput,
				).cell;

				const set = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_field_set',
						{source_id: source.id, name: 'cover', target_id: target.id},
						h,
					),
					CellFieldSetOutput,
				);
				assert.strictEqual(set.field.name, 'cover');
				assert.strictEqual(set.field.source_id, source.id);
				assert.strictEqual(set.field.target_id, target.id);

				const forward = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_field_list', {source_id: source.id}, h),
					CellFieldListOutput,
				);
				assert.ok(
					forward.fields.some((f) => f.name === 'cover' && f.target_id === target.id),
					'forward field_list missing the field',
				);

				const reverse = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_field_list', {target_id: target.id}, h),
					CellFieldListOutput,
				);
				assert.ok(
					reverse.fields.some((f) => f.source_id === source.id),
					'reverse field_list missing the upfield',
				);

				const del = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_field_delete',
						{source_id: source.id, name: 'cover'},
						h,
					),
					CellFieldDeleteOutput,
				);
				assert.strictEqual(del.deleted, true);
				const del2 = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_field_delete',
						{source_id: source.id, name: 'cover'},
						h,
					),
					CellFieldDeleteOutput,
				);
				assert.strictEqual(del2.deleted, false);
			},
		);

		test_if(
			capabilities.cell_relations,
			'item insert → ordered forward + reverse list → move → idempotent delete',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_item_owner'});
				const t = fixture.fresh_transport();
				const h = owner.create_session_headers();

				const make = async (): Promise<string> =>
					expect_output(
						await cross_rpc_call(t, rpc_path, 'cell_create', {data: {kind: 'note'}}, h),
						CellCreateOutput,
					).cell.id;
				const parent = await make();
				const child_a = await make();
				const child_b = await make();

				const pos_a = fractional_index_between(null, null);
				const ins_a = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_item_insert',
						{parent_id: parent, child_id: child_a, position: pos_a},
						h,
					),
					CellItemInsertOutput,
				);
				assert.strictEqual(ins_a.item.child_id, child_a);

				const pos_b = fractional_index_between(pos_a, null);
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_item_insert',
						{parent_id: parent, child_id: child_b, position: pos_b},
						h,
					),
					CellItemInsertOutput,
				);

				// Forward list is lex-ordered by position; child_a (pos_a < pos_b) first.
				const forward = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_item_list', {parent_id: parent}, h),
					CellItemListOutput,
				);
				assert.strictEqual(forward.items.length, 2);
				assert.strictEqual(forward.items[0]!.child_id, child_a);
				assert.strictEqual(forward.items[1]!.child_id, child_b);

				// Reverse list — which parents contain child_a.
				const reverse = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_item_list', {child_id: child_a}, h),
					CellItemListOutput,
				);
				assert.ok(
					reverse.items.some((i) => i.parent_id === parent),
					'reverse item_list missing the parent',
				);

				// Move child_b ahead of child_a.
				const new_pos = fractional_index_between(null, pos_a);
				const moved = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_item_move',
						{parent_id: parent, position: pos_b, new_position: new_pos},
						h,
					),
					CellItemMoveOutput,
				);
				assert.strictEqual(moved.item.position, new_pos);
				assert.strictEqual(moved.item.child_id, child_b);

				// Idempotent delete on the slot key.
				const del = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_item_delete',
						{parent_id: parent, position: pos_a},
						h,
					),
					CellItemDeleteOutput,
				);
				assert.strictEqual(del.deleted, true);
				const del2 = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_item_delete',
						{parent_id: parent, position: pos_a},
						h,
					),
					CellItemDeleteOutput,
				);
				assert.strictEqual(del2.deleted, false);
			},
		);

		test_if(
			capabilities.cell_relations,
			'clone: shallow shares edges; deep clones children',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_clone_owner'});
				const t = fixture.fresh_transport();
				const h = owner.create_session_headers();

				const make = async (label?: string): Promise<string> =>
					expect_output(
						await cross_rpc_call(
							t,
							rpc_path,
							'cell_create',
							{data: {kind: 'note', ...(label === undefined ? {} : {label})}},
							h,
						),
						CellCreateOutput,
					).cell.id;

				const source = await make('orig');
				const child = await make('child');
				const field_target = await make('target');
				const child_pos = fractional_index_between(null, null);
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_item_insert',
						{parent_id: source, child_id: child, position: child_pos},
						h,
					),
					CellItemInsertOutput,
				);
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_field_set',
						{source_id: source, name: 'link', target_id: field_target},
						h,
					),
					CellFieldSetOutput,
				);

				// Shallow clone: new owned cell, path nulled, item edge shares the
				// same child_id, field edge shares the same target_id.
				const shallow = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_clone', {source_id: source}, h),
					CellCloneOutput,
				).cell;
				assert.notStrictEqual(shallow.id, source);
				assert.strictEqual(shallow.created_by, owner.actor.id);
				assert.strictEqual(shallow.path, null);

				const shallow_items = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_item_list', {parent_id: shallow.id}, h),
					CellItemListOutput,
				);
				assert.strictEqual(shallow_items.items.length, 1);
				assert.strictEqual(
					shallow_items.items[0]!.child_id,
					child,
					'shallow clone re-pointed the child',
				);

				const shallow_fields = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_field_list', {source_id: shallow.id}, h),
					CellFieldListOutput,
				);
				assert.strictEqual(shallow_fields.fields.length, 1);
				assert.strictEqual(shallow_fields.fields[0]!.target_id, field_target);

				// Deep clone: the child edge points at a NEW cloned cell, not the
				// original child; the field edge still shares the target.
				const deep = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_clone', {source_id: source, deep: true}, h),
					CellCloneOutput,
				).cell;
				const deep_items = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_item_list', {parent_id: deep.id}, h),
					CellItemListOutput,
				);
				assert.strictEqual(deep_items.items.length, 1);
				assert.notStrictEqual(
					deep_items.items[0]!.child_id,
					child,
					'deep clone reused the original child',
				);
				const deep_fields = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_field_list', {source_id: deep.id}, h),
					CellFieldListOutput,
				);
				assert.strictEqual(deep_fields.fields.length, 1);
				assert.strictEqual(deep_fields.fields[0]!.target_id, field_target);
			},
		);

		test_if(
			capabilities.cell_relations,
			'audit_list is manage-tier: owner reads the timeline; viewer-grant gets 404',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_audit_owner'});
				const viewer = await fixture.create_account({username: 'cell_audit_viewer'});
				const t = fixture.fresh_transport();
				const owner_h = owner.create_session_headers();
				const viewer_h = viewer.create_session_headers();

				const cell = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_create', {data: {kind: 'note'}}, owner_h),
					CellCreateOutput,
				).cell;
				// A mutation so the timeline has at least the create + update events.
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_update',
						{cell_id: cell.id, data: {kind: 'note', label: 'v2'}},
						owner_h,
					),
					CellUpdateOutput,
				);

				// Owner (manage-tier) reads the timeline.
				const timeline = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_audit_list', {cell_id: cell.id}, owner_h),
					CellAuditListOutput,
				);
				assert.ok(timeline.events.length > 0, 'owner audit timeline empty');
				assert.ok(
					timeline.events.some((e) => e.event_type === 'cell_create'),
					'audit timeline missing the create event',
				);

				// Grant the viewer a view-only grant: they can read the cell …
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_grant_create',
						{
							cell_id: cell.id,
							level: 'viewer',
							principal: {kind: 'actor', actor_id: viewer.actor.id},
						},
						owner_h,
					),
					CellGrantCreateOutput,
				);
				const can_read = await cross_rpc_call(t, rpc_path, 'cell_get', {id: cell.id}, viewer_h);
				assert.ok(can_read.ok, 'viewer-grant holder could not read the cell');

				// … but the timeline is manage-tier, so they get the IDOR 404.
				const denied = await cross_rpc_call(
					t,
					rpc_path,
					'cell_audit_list',
					{cell_id: cell.id},
					viewer_h,
				);
				assert.ok(!denied.ok, 'viewer read the audit timeline');
				assert.strictEqual(error_reason(denied), 'cell_not_found');
			},
		);

		test_if(
			capabilities.cell_relations,
			'relation reads filter non-viewable targets (D8): anon sees only public children',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_relvis_owner'});
				const t = fixture.fresh_transport();
				const owner_h = owner.create_session_headers();

				// A public parent linking one public + one private child, as both
				// items and fields. The private child is owned by `owner`, so only
				// `owner` (and admin) can view it.
				const parent = await create_cell(t, rpc_path, owner_h, {
					data: {kind: 'collection'},
					visibility: 'public',
				});
				const pub_child = await create_cell(t, rpc_path, owner_h, {
					data: {kind: 'note'},
					visibility: 'public',
				});
				const priv_child = await create_cell(t, rpc_path, owner_h, {data: {kind: 'note'}});
				await wire_children(t, rpc_path, owner_h, parent, pub_child, priv_child);

				// Anonymous: only the public child surfaces in the bundle …
				const anon = fixture.fresh_transport({origin: null});
				const bundle = expect_output(
					await cross_rpc_call(anon, rpc_path, 'cell_get', {id: parent}, {}),
					CellGetOutput,
				);
				assert.deepStrictEqual(
					bundle.items.map((i) => i.child_id),
					[pub_child],
					'anon bundle leaked the private child item',
				);
				assert.deepStrictEqual(
					bundle.fields.map((f) => f.target_id),
					[pub_child],
					'anon bundle leaked the private child field',
				);

				// … and in the forward paginating list verbs.
				const items = expect_output(
					await cross_rpc_call(anon, rpc_path, 'cell_item_list', {parent_id: parent}, {}),
					CellItemListOutput,
				);
				assert.deepStrictEqual(
					items.items.map((i) => i.child_id),
					[pub_child],
					'anon item_list leaked the private child',
				);
				const fields = expect_output(
					await cross_rpc_call(anon, rpc_path, 'cell_field_list', {source_id: parent}, {}),
					CellFieldListOutput,
				);
				assert.deepStrictEqual(
					fields.fields.map((f) => f.target_id),
					[pub_child],
					'anon field_list leaked the private child',
				);
			},
		);

		test_if(
			capabilities.cell_relations,
			'relation reads filter non-viewable targets (D8): viewer-grant sees only independently-viewable children',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_relvis_grant_owner'});
				const viewer = await fixture.create_account({username: 'cell_relvis_viewer'});
				const t = fixture.fresh_transport();
				const owner_h = owner.create_session_headers();
				const viewer_h = viewer.create_session_headers();

				// Private parent; one child the viewer will be granted, one they won't.
				const parent = await create_cell(t, rpc_path, owner_h, {data: {kind: 'collection'}});
				const shared_child = await create_cell(t, rpc_path, owner_h, {data: {kind: 'note'}});
				const priv_child = await create_cell(t, rpc_path, owner_h, {data: {kind: 'note'}});
				await wire_children(t, rpc_path, owner_h, parent, shared_child, priv_child);

				// Grant the viewer on parent AND shared_child — but not priv_child.
				for (const cell_id of [parent, shared_child]) {
					expect_output(
						await cross_rpc_call(
							t,
							rpc_path,
							'cell_grant_create',
							{cell_id, level: 'viewer', principal: {kind: 'actor', actor_id: viewer.actor.id}},
							owner_h,
						),
						CellGrantCreateOutput,
					);
				}

				// The viewer can reach the parent, but its bundle exposes only the
				// child they can independently view.
				const bundle = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_get', {id: parent}, viewer_h),
					CellGetOutput,
				);
				assert.deepStrictEqual(
					bundle.items.map((i) => i.child_id),
					[shared_child],
					'viewer bundle leaked the un-granted child item',
				);
				assert.deepStrictEqual(
					bundle.fields.map((f) => f.target_id),
					[shared_child],
					'viewer bundle leaked the un-granted child field',
				);
			},
		);

		test_if(
			capabilities.cell_relations,
			'clone D8: shallow drops edges to non-viewable children (no count leak)',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_clone_d8_owner'});
				const cloner = await fixture.create_account({username: 'cell_clone_d8_cloner'});
				const t = fixture.fresh_transport();
				const owner_h = owner.create_session_headers();
				const cloner_h = cloner.create_session_headers();
				// The keeper holds [keeper, admin], so its headers are the admin probe.
				const admin_h = fixture.create_session_headers();

				const parent = await create_cell(t, rpc_path, owner_h, {
					data: {kind: 'collection'},
					visibility: 'public',
				});
				const pub_child = await create_cell(t, rpc_path, owner_h, {
					data: {kind: 'note'},
					visibility: 'public',
				});
				const priv_child = await create_cell(t, rpc_path, owner_h, {data: {kind: 'note'}});
				await wire_children(t, rpc_path, owner_h, parent, pub_child, priv_child);

				// The cloner can read the public parent but not the private child.
				const clone = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_clone', {source_id: parent}, cloner_h),
					CellCloneOutput,
				).cell;
				assert.strictEqual(clone.created_by, cloner.actor.id);

				// The ADMIN can view the private child, so an admin read of the clone
				// would surface the private edge if it had been copied — it must not.
				const admin_items = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_item_list', {parent_id: clone.id}, admin_h),
					CellItemListOutput,
				);
				assert.deepStrictEqual(
					admin_items.items.map((i) => i.child_id),
					[pub_child],
					'shallow clone copied the non-viewable item edge',
				);
				const admin_fields = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_field_list', {source_id: clone.id}, admin_h),
					CellFieldListOutput,
				);
				assert.deepStrictEqual(
					admin_fields.fields.map((f) => f.target_id),
					[pub_child],
					'shallow clone copied the non-viewable field edge',
				);

				// No skipped-child count surfaced in the clone's audit row — the
				// hidden child's existence must not leak to the cloner. (`_testing_reset`
				// wiped audit_log at setup, so this is the only cell_clone event.)
				const td = fixture.fresh_transport({origin: null});
				await drain_effects(td, rpc_path, fixture.create_daemon_token_headers());
				const events = expect_output(
					await cross_rpc_call(t, rpc_path, 'audit_log_list', {event_type: 'cell_clone'}, admin_h),
					AuditLogListOutput,
				).events;
				const ev = events.find(
					(e) => (e.metadata as {new_id?: unknown} | null)?.new_id === clone.id,
				);
				assert.ok(ev, 'no cell_clone audit row for the shallow clone');
				assert.strictEqual(
					(ev.metadata as {skipped_item_count?: number}).skipped_item_count,
					undefined,
					'shallow clone leaked the hidden-child count via skipped_item_count',
				);
			},
		);

		test_if(
			capabilities.cell_relations,
			'clone D8: deep silently skips non-viewable children (no count leak)',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_clone_d8_deep_owner'});
				const cloner = await fixture.create_account({username: 'cell_clone_d8_deep_cloner'});
				const t = fixture.fresh_transport();
				const owner_h = owner.create_session_headers();
				const cloner_h = cloner.create_session_headers();
				const admin_h = fixture.create_session_headers();

				const parent = await create_cell(t, rpc_path, owner_h, {
					data: {kind: 'collection'},
					visibility: 'public',
				});
				const pub_child = await create_cell(t, rpc_path, owner_h, {
					data: {kind: 'note'},
					visibility: 'public',
				});
				const priv_child = await create_cell(t, rpc_path, owner_h, {data: {kind: 'note'}});
				await wire_children(t, rpc_path, owner_h, parent, pub_child, priv_child);

				const clone = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_clone',
						{source_id: parent, deep: true},
						cloner_h,
					),
					CellCloneOutput,
				).cell;

				// Deep clone copies viewable children into fresh cells; the
				// non-viewable child is dropped. The admin (who can view everything)
				// reading the clone still sees exactly one item — proving the private
				// child was never cloned, not merely filtered from the cloner's view.
				const admin_items = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_item_list', {parent_id: clone.id}, admin_h),
					CellItemListOutput,
				);
				assert.strictEqual(admin_items.items.length, 1, 'deep clone cloned the non-viewable child');
				assert.notStrictEqual(
					admin_items.items[0]!.child_id,
					pub_child,
					'deep clone reused the original child instead of cloning it',
				);

				const td = fixture.fresh_transport({origin: null});
				await drain_effects(td, rpc_path, fixture.create_daemon_token_headers());
				const events = expect_output(
					await cross_rpc_call(t, rpc_path, 'audit_log_list', {event_type: 'cell_clone'}, admin_h),
					AuditLogListOutput,
				).events;
				const ev = events.find(
					(e) => (e.metadata as {new_id?: unknown} | null)?.new_id === clone.id,
				);
				assert.ok(ev, 'no cell_clone audit row for the deep clone');
				const meta = ev.metadata as {
					deep?: boolean;
					item_count?: number;
					skipped_item_count?: number;
				};
				assert.strictEqual(meta.deep, true);
				assert.strictEqual(meta.item_count, 1, 'deep clone counted a non-viewable child');
				assert.strictEqual(
					meta.skipped_item_count,
					undefined,
					'deep clone leaked the hidden-child count via skipped_item_count',
				);
			},
		);
	});
};
