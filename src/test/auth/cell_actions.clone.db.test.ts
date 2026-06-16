/**
 * `cell_clone` coverage — the second-pass gap left by the focused checklist.
 *
 * - shallow clone: new owner = caller, `path` nulled, zero grants, shares
 *   item + field edges with the source.
 * - deep clone (depth=1): direct children are cloned as new caller-owned
 *   cells; field edges still shallow-share targets.
 * - `with_data_patch` patch-last merge; cross-kind patch rejected.
 * - 404 IDOR mask when the source is unviewable.
 * - audit `cell_clone` envelope (`source_id` / `new_id` / `deep` /
 *   `item_count`) — no skipped-child count, so the source's hidden-child
 *   count can't leak to the cloner via the clone's audit trail.
 * - REGRESSION (strict-D8 edge copy): clone must NOT copy item / field
 *   edges whose target the caller can't view — verified by inspecting the
 *   raw `cell_item` / `cell_field` rows on the clone.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {
	cell_clone_action_spec,
	cell_get_action_spec,
	ERROR_CELL_CLONE_KIND_MISMATCH,
	ERROR_CELL_NOT_FOUND,
} from '$lib/auth/cell_action_specs.ts';
import {
	cell_item_insert_action_spec,
	type CellItemPosition,
} from '$lib/auth/cell_item_action_specs.ts';
import {cell_field_set_action_spec, type CellFieldName} from '$lib/auth/cell_field_action_specs.ts';
import {query_audit_log_list} from '$lib/auth/audit_log_queries.ts';
import {fractional_indices_between} from '@fuzdev/fuz_util/fractional_index.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';
import type {Db} from '$lib/db/db.ts';
import type {TestApp, TestAccount} from '$lib/testing/app_server.ts';
import {describe_db, create_cell_test_app, create_cell, call} from './cell_test_helpers.ts';

/** Wire `pub_child` + `priv_child` under `parent` as items AND fields. */
const wire_children = async (
	app: TestApp,
	owner: TestAccount,
	parent_id: Uuid,
	pub_child: Uuid,
	priv_child: Uuid,
): Promise<void> => {
	const headers = owner.create_session_headers();
	const [p0, p1] = fractional_indices_between(null, null, 2);
	for (const [pos, child] of [
		[p0!, pub_child],
		[p1!, priv_child],
	] as const) {
		const r = await call(
			app,
			cell_item_insert_action_spec,
			{parent_id, child_id: child, position: pos as CellItemPosition},
			headers,
		);
		assert.ok(r.ok, JSON.stringify(r));
	}
	for (const [name, child] of [
		['pub_link', pub_child],
		['priv_link', priv_child],
	] as const) {
		const r = await call(
			app,
			cell_field_set_action_spec,
			{source_id: parent_id, name: name as CellFieldName, target_id: child},
			headers,
		);
		assert.ok(r.ok, JSON.stringify(r));
	}
};

/** Raw child ids on a clone's `cell_item` rows (bypasses D8 read filtering). */
const raw_item_children = (db: Db, parent_id: Uuid): Promise<Array<{child_id: Uuid}>> =>
	db.query(`SELECT child_id FROM cell_item WHERE parent_id = $1`, [parent_id]);

/** Raw field targets on a clone's `cell_field` rows. */
const raw_field_targets = (db: Db, source_id: Uuid): Promise<Array<{target_id: Uuid}>> =>
	db.query(`SELECT target_id FROM cell_field WHERE source_id = $1`, [source_id]);

describe_db('cell_clone', (get_db) => {
	describe('shallow clone basics', () => {
		test('new owner is the caller, path is nulled, zero grants, edges shared', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'cl_owner'});
			const cloner = await app.create_account({username: 'cl_cloner'});

			// Public source so the cloner can view it.
			const {id: child} = await create_cell(app, {
				data: {kind: 'note', label: 'shared-child'},
				visibility: 'public',
				headers: owner.create_session_headers(),
			});
			const {id: source} = await create_cell(app, {
				data: {kind: 'collection', label: 'src'},
				visibility: 'public',
				items: [child],
				headers: owner.create_session_headers(),
			});

			const res = await call(
				app,
				cell_clone_action_spec,
				{source_id: source},
				cloner.create_session_headers(),
			);
			assert.ok(res.ok, JSON.stringify(res));
			const clone = res.result.cell;
			assert.notStrictEqual(clone.id, source);
			assert.strictEqual(clone.created_by, cloner.actor.id);
			assert.strictEqual(clone.path, null);
			assert.strictEqual(clone.grant_count, 0);
			assert.strictEqual(clone.data.label, 'src');

			// Shallow shares the child edge (same target id).
			const rows = await raw_item_children(get_db(), clone.id);
			assert.deepStrictEqual(
				rows.map((r) => r.child_id),
				[child],
			);
		});

		test('with_data_patch merges patch-last', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'cl_patch'});
			const {id: source} = await create_cell(app, {
				data: {kind: 'note', label: 'orig', summary: 'keep'},
				visibility: 'public',
				headers: owner.create_session_headers(),
			});
			const res = await call(
				app,
				cell_clone_action_spec,
				{source_id: source, with_data_patch: {label: 'patched'}},
				owner.create_session_headers(),
			);
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.cell.data.label, 'patched');
			assert.strictEqual(res.result.cell.data.summary, 'keep');
		});
	});

	describe('kind + authz guards', () => {
		test('cross-kind with_data_patch is rejected', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'cl_kind'});
			const {id: source} = await create_cell(app, {
				data: {kind: 'note'},
				visibility: 'public',
				headers: owner.create_session_headers(),
			});
			const res = await call(
				app,
				cell_clone_action_spec,
				{source_id: source, with_data_patch: {kind: 'event'}},
				owner.create_session_headers(),
			);
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(
				(res.error.data as {reason?: string}).reason,
				ERROR_CELL_CLONE_KIND_MISMATCH,
			);
		});

		test('cloning an unviewable source 404s (IDOR mask)', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'cl_priv_owner'});
			const stranger = await app.create_account({username: 'cl_stranger'});
			const {id: source} = await create_cell(app, {
				data: {kind: 'note'}, // private
				headers: owner.create_session_headers(),
			});
			const res = await call(
				app,
				cell_clone_action_spec,
				{source_id: source},
				stranger.create_session_headers(),
			);
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
			assert.strictEqual((res.error.data as {reason?: string}).reason, ERROR_CELL_NOT_FOUND);
		});
	});

	describe('deep clone (depth=1)', () => {
		test('direct children are cloned as new caller-owned cells', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'cl_deep_owner'});
			const {id: child} = await create_cell(app, {
				data: {kind: 'note', label: 'kid'},
				visibility: 'public',
				headers: owner.create_session_headers(),
			});
			const {id: source} = await create_cell(app, {
				data: {kind: 'collection'},
				visibility: 'public',
				items: [child],
				headers: owner.create_session_headers(),
			});

			const res = await call(
				app,
				cell_clone_action_spec,
				{source_id: source, deep: true},
				owner.create_session_headers(),
			);
			assert.ok(res.ok, JSON.stringify(res));

			// The cloned item points at a NEW cell (not the original child).
			const rows = await raw_item_children(get_db(), res.result.cell.id);
			assert.strictEqual(rows.length, 1);
			assert.notStrictEqual(rows[0]!.child_id, child);

			// The new child is owned by the cloner and carries the kid's data.
			const got = await call(
				app,
				cell_get_action_spec,
				{id: rows[0]!.child_id},
				owner.create_session_headers(),
			);
			assert.ok(got.ok, JSON.stringify(got));
			assert.strictEqual(got.result.cell.created_by, owner.actor.id);
			assert.strictEqual(got.result.cell.data.label, 'kid');
		});
	});

	describe('strict-D8 edge copy (regression)', () => {
		test('shallow clone skips item + field edges to unviewable children', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'cl_d8_owner'});
			const cloner = await app.create_account({username: 'cl_d8_cloner'});

			const {id: parent} = await create_cell(app, {
				data: {kind: 'collection'},
				visibility: 'public',
				headers: owner.create_session_headers(),
			});
			const {id: pub_child} = await create_cell(app, {
				data: {kind: 'note', label: 'pub'},
				visibility: 'public',
				headers: owner.create_session_headers(),
			});
			const {id: priv_child} = await create_cell(app, {
				data: {kind: 'note', label: 'secret'}, // private, owned by owner
				headers: owner.create_session_headers(),
			});
			await wire_children(app, owner, parent, pub_child, priv_child);

			const res = await call(
				app,
				cell_clone_action_spec,
				{source_id: parent},
				cloner.create_session_headers(),
			);
			assert.ok(res.ok, JSON.stringify(res));
			const clone_id = res.result.cell.id;

			// Only the viewable child's edges are carried over — inspecting the
			// raw rows proves the private edge was never written (it would be
			// invisible to a D8-filtered read either way).
			const items = await raw_item_children(get_db(), clone_id);
			assert.deepStrictEqual(
				items.map((r) => r.child_id),
				[pub_child],
			);
			const fields = await raw_field_targets(get_db(), clone_id);
			assert.deepStrictEqual(
				fields.map((r) => r.target_id),
				[pub_child],
			);

			// The dropped item is NOT reported anywhere — no skipped-child count
			// in the audit envelope, so the source's hidden-child count can't
			// leak to the cloner (who owns and can audit the clone). D8.
			const audit = await query_audit_log_list({db: get_db()}, {event_type: 'cell_clone'});
			const meta = audit[0]!.metadata as {new_id: Uuid; skipped_item_count?: number};
			assert.strictEqual(meta.new_id, clone_id);
			assert.strictEqual(meta.skipped_item_count, undefined);
		});

		test('deep clone silently skips unviewable children (no count leak)', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'cl_d8_deep_owner'});
			const cloner = await app.create_account({username: 'cl_d8_deep_cloner'});

			const {id: parent} = await create_cell(app, {
				data: {kind: 'collection'},
				visibility: 'public',
				headers: owner.create_session_headers(),
			});
			const {id: pub_child} = await create_cell(app, {
				data: {kind: 'note'},
				visibility: 'public',
				headers: owner.create_session_headers(),
			});
			const {id: priv_child} = await create_cell(app, {
				data: {kind: 'note'},
				headers: owner.create_session_headers(),
			});
			await wire_children(app, owner, parent, pub_child, priv_child);

			const res = await call(
				app,
				cell_clone_action_spec,
				{source_id: parent, deep: true},
				cloner.create_session_headers(),
			);
			assert.ok(res.ok, JSON.stringify(res));

			const items = await raw_item_children(get_db(), res.result.cell.id);
			assert.strictEqual(items.length, 1, 'only the viewable child cloned');

			const audit = await query_audit_log_list({db: get_db()}, {event_type: 'cell_clone'});
			const meta = audit[0]!.metadata as {
				deep: boolean;
				item_count: number;
				skipped_item_count?: number;
			};
			assert.strictEqual(meta.deep, true);
			assert.strictEqual(meta.item_count, 1);
			// No skipped-child count surfaced — the hidden child's existence
			// must not leak to the cloner via the clone's audit trail. D8.
			assert.strictEqual(meta.skipped_item_count, undefined);
		});
	});
});
