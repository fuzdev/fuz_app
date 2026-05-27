import '../assert_dev_env.js';

/**
 * Dedicated stateful cell-CRUD parity suite for the cross-backend harness.
 *
 * The generic `describe_rpc_round_trip_tests` can't cover cells: the verbs
 * are stateful (update / delete / get-by-id need a real cell id threaded
 * from a prior create) and `cell_get`'s input has a top-level `.refine()`.
 * So cells stay off the standard declared surface (`create_spine_surface_spec`)
 * — exactly like ws / sse — and this suite plus its sibling
 * `describe_cell_relations_cross_tests` (grant / field / item / clone / audit)
 * are the cell validators. This one gates on `capabilities.cell_crud`; it runs
 * against any backend that live-mounts the cell surface (the TS spine binary,
 * the in-process Hono app, and the Rust `testing_spine_stub`).
 *
 * Drives the full lifecycle (create → get → update → delete → list, threading
 * the created id) plus the authz matrix the wire contract guarantees. Every
 * success response is parsed against the verb's declared Zod **output** schema
 * (`CellCreateOutput` / `CellGetOutput` / …), so a TS↔Rust envelope drift —
 * not just a `CellJson` field drift — fails the suite:
 *
 * - owner does full CRUD; responses match the output schemas exactly;
 * - anon sees `public` cells only — `private` is 404 (existence not leaked);
 * - a non-owner non-admin editing / reading / deleting another's private cell
 *   gets 404 (IDOR mask), never 403;
 * - admin reaches any cell;
 * - duplicate active `path` → 409 (`cell_path_taken`);
 * - `path` write by a non-admin → 403 (`cell_path_admin_only`), on both create
 *   and update (even by the owner);
 * - `cell_get` with neither `id` nor `path` → `invalid_params`;
 * - null-auth `cell_list` with `created_by` → `invalid_params`.
 *
 * The visibility-manage-tier 403 (`cell_visibility_manage_only`) needs a
 * non-owner editor, which only a `cell_grant` can produce, so it lives in
 * `describe_cell_relations_cross_tests` alongside the grant verbs rather than
 * here.
 *
 * `$lib`-free by contract (relative specifiers only) so the suite can be
 * imported from the spawnable cross-process test files.
 *
 * @module
 */

import {describe, assert} from 'vitest';

import {
	CellCreateOutput,
	CellDeleteOutput,
	CellGetOutput,
	CellListOutput,
	CellUpdateOutput,
} from '../../auth/cell_action_specs.js';
import {test_if} from './capabilities.js';
import {
	cross_rpc_call,
	error_reason,
	expect_output,
	type CellCrossTestOptions,
} from './cell_cross_helpers.js';
import {SPINE_RPC_PATH} from './default_spine_surface.js';

export const describe_cell_crud_cross_tests = (options: CellCrossTestOptions): void => {
	const {setup_test, capabilities} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('cell CRUD parity', () => {
		test_if(
			capabilities.cell_crud,
			'owner lifecycle: create → get → update → delete → list',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_owner'});
				const t = fixture.fresh_transport();
				const owner_headers = owner.create_session_headers();

				// create — default visibility, owner-stamped, no grants
				const created = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{data: {kind: 'note', label: 'hi'}},
						owner_headers,
					),
					CellCreateOutput,
				);
				assert.strictEqual(created.cell.visibility, 'private');
				assert.strictEqual(created.cell.created_by, owner.actor.id);
				assert.strictEqual(created.cell.updated_by, null);
				assert.strictEqual(created.cell.grant_count, 0);
				const cell_id = created.cell.id;

				// get by id — full CellGetOutput envelope; relations empty in the first cut
				const got = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_get', {id: cell_id}, owner_headers),
					CellGetOutput,
				);
				assert.strictEqual(got.cell.id, cell_id);
				assert.deepStrictEqual(got.fields, []);
				assert.deepStrictEqual(got.items, []);
				assert.strictEqual(got.fields_truncated, false);
				assert.strictEqual(got.items_truncated, false);
				assert.strictEqual(got.can_edit, true);
				assert.strictEqual(got.can_grant, true); // owner is manage-tier

				// update data + flip to public (owner is manage-tier, so visibility write is allowed)
				const updated = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_update',
						{cell_id, data: {kind: 'note', label: 'hi2'}, visibility: 'public'},
						owner_headers,
					),
					CellUpdateOutput,
				);
				assert.strictEqual(updated.cell.visibility, 'public');
				assert.strictEqual(updated.cell.updated_by, owner.actor.id);

				// list includes it
				const listed = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_list', {}, owner_headers),
					CellListOutput,
				);
				assert.ok(
					listed.cells.some((c) => c.id === cell_id),
					'owner cell_list omitted the cell',
				);

				// delete → subsequent get is 404
				const deleted = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_delete', {cell_id}, owner_headers),
					CellDeleteOutput,
				);
				assert.strictEqual(deleted.deleted, true);
				const gone = await cross_rpc_call(t, rpc_path, 'cell_get', {id: cell_id}, owner_headers);
				assert.ok(!gone.ok, 'deleted cell still readable');
				assert.strictEqual(error_reason(gone), 'cell_not_found');
			},
		);

		test_if(capabilities.cell_crud, 'anon sees public cells only; private is 404', async () => {
			const fixture = await setup_test();
			const owner = await fixture.create_account({username: 'cell_anon_owner'});
			const owner_headers = owner.create_session_headers();
			const authed = fixture.fresh_transport();

			const priv = expect_output(
				await cross_rpc_call(
					authed,
					rpc_path,
					'cell_create',
					{data: {kind: 'note'}, visibility: 'private'},
					owner_headers,
				),
				CellCreateOutput,
			).cell;
			const pub = expect_output(
				await cross_rpc_call(
					authed,
					rpc_path,
					'cell_create',
					{data: {kind: 'note'}, visibility: 'public'},
					owner_headers,
				),
				CellCreateOutput,
			).cell;

			const anon = fixture.fresh_transport({origin: null});
			const anon_pub = await cross_rpc_call(anon, rpc_path, 'cell_get', {id: pub.id}, {});
			assert.ok(anon_pub.ok, `anon could not read public cell: ${JSON.stringify(anon_pub.error)}`);

			const anon_priv = await cross_rpc_call(anon, rpc_path, 'cell_get', {id: priv.id}, {});
			assert.ok(!anon_priv.ok, 'anon read a private cell');
			assert.strictEqual(error_reason(anon_priv), 'cell_not_found');

			const anon_list = expect_output(
				await cross_rpc_call(anon, rpc_path, 'cell_list', {}, {}),
				CellListOutput,
			);
			const anon_ids = anon_list.cells.map((c) => c.id);
			assert.ok(anon_ids.includes(pub.id), 'anon list missing public cell');
			assert.ok(!anon_ids.includes(priv.id), 'anon list leaked private cell');
		});

		test_if(
			capabilities.cell_crud,
			'non-owner edit/read/delete of a private cell → 404 (IDOR mask)',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_idor_owner'});
				const other = await fixture.create_account({username: 'cell_idor_other'});
				const t = fixture.fresh_transport();

				const priv = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{data: {kind: 'note'}},
						owner.create_session_headers(),
					),
					CellCreateOutput,
				).cell;
				const other_headers = other.create_session_headers();

				const read = await cross_rpc_call(t, rpc_path, 'cell_get', {id: priv.id}, other_headers);
				assert.strictEqual(error_reason(read), 'cell_not_found');

				const edit = await cross_rpc_call(
					t,
					rpc_path,
					'cell_update',
					{cell_id: priv.id, data: {kind: 'note', label: 'x'}},
					other_headers,
				);
				assert.ok(!edit.ok, 'non-owner edited a private cell');
				assert.strictEqual(error_reason(edit), 'cell_not_found');

				const del = await cross_rpc_call(
					t,
					rpc_path,
					'cell_delete',
					{cell_id: priv.id},
					other_headers,
				);
				assert.ok(!del.ok, 'non-owner deleted a private cell');
				assert.strictEqual(error_reason(del), 'cell_not_found');
			},
		);

		test_if(
			capabilities.cell_crud,
			'admin (keeper) reaches another actor’s private cell',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_admin_owner'});
				const t = fixture.fresh_transport();
				const priv = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{data: {kind: 'note'}},
						owner.create_session_headers(),
					),
					CellCreateOutput,
				).cell;
				// `fixture` is the bootstrapped keeper (holds ROLE_ADMIN).
				const admin_read = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_get',
						{id: priv.id},
						fixture.create_session_headers(),
					),
					CellGetOutput,
				);
				assert.strictEqual(admin_read.cell.id, priv.id);
			},
		);

		test_if(capabilities.cell_crud, 'duplicate active path → 409 conflict', async () => {
			const fixture = await setup_test();
			const t = fixture.fresh_transport();
			// `path` writes are admin-only; the keeper is admin.
			const admin_headers = fixture.create_session_headers();
			expect_output(
				await cross_rpc_call(
					t,
					rpc_path,
					'cell_create',
					{data: {kind: 'note'}, path: 'parity/dup'},
					admin_headers,
				),
				CellCreateOutput,
			);
			const dup = await cross_rpc_call(
				t,
				rpc_path,
				'cell_create',
				{data: {kind: 'note'}, path: 'parity/dup'},
				admin_headers,
			);
			assert.ok(!dup.ok, 'duplicate path was accepted');
			assert.strictEqual(error_reason(dup), 'cell_path_taken');
		});

		test_if(
			capabilities.cell_crud,
			'path write by non-admin → 403 (create and update)',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({username: 'cell_path_owner'});
				const t = fixture.fresh_transport();
				const owner_headers = owner.create_session_headers();

				const create_with_path = await cross_rpc_call(
					t,
					rpc_path,
					'cell_create',
					{data: {kind: 'note'}, path: 'parity/forbidden'},
					owner_headers,
				);
				assert.ok(!create_with_path.ok, 'non-admin set a path on create');
				assert.strictEqual(error_reason(create_with_path), 'cell_path_admin_only');

				// Even owning the cell, a non-admin cannot write `path` on update.
				const owned = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_create', {data: {kind: 'note'}}, owner_headers),
					CellCreateOutput,
				).cell;
				const update_path = await cross_rpc_call(
					t,
					rpc_path,
					'cell_update',
					{cell_id: owned.id, path: 'parity/owned'},
					owner_headers,
				);
				assert.ok(!update_path.ok, 'non-admin set a path on update');
				assert.strictEqual(error_reason(update_path), 'cell_path_admin_only');
			},
		);

		test_if(capabilities.cell_crud, 'cell_get without id or path → invalid_params', async () => {
			const fixture = await setup_test();
			const bad = await cross_rpc_call(
				fixture.fresh_transport(),
				rpc_path,
				'cell_get',
				{},
				fixture.create_session_headers(),
			);
			assert.ok(!bad.ok, 'cell_get with empty params succeeded');
			// -32602 invalid_params (refine or handler guard).
			assert.strictEqual(bad.error?.code, -32602);
		});

		test_if(
			capabilities.cell_crud,
			'null-auth cell_list with created_by → invalid_params',
			async () => {
				const fixture = await setup_test();
				const anon = fixture.fresh_transport({origin: null});
				const bad = await cross_rpc_call(
					anon,
					rpc_path,
					'cell_list',
					{created_by: fixture.actor.id},
					{},
				);
				assert.ok(!bad.ok, 'anon created_by filter accepted');
				assert.strictEqual(error_reason(bad), 'cell_list_created_by_requires_auth');
			},
		);
	});
};
