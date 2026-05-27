/**
 * D8 — strict target-visibility on relation reads.
 *
 * A caller who can view a parent/source cell must NOT learn about private
 * linked cells they cannot themselves view. Covers:
 *
 * - `cell_get` bundle: a public parent with one public + one private child
 *   (both as `cell_item` and `cell_field`) returns only the public targets
 *   to an unauthenticated viewer.
 * - forward `cell_item_list({parent_id})` / `cell_field_list({source_id})`:
 *   same filtering on the paginating list verbs.
 * - authed-viewer variant: a viewer-grant holder on a private parent sees
 *   only the children they can independently view.
 *
 * Inverts visiones' loose posture (it bundled all relation targets).
 *
 * @module
 */

import {test, assert} from 'vitest';

import {cell_get_action_spec} from '$lib/auth/cell_action_specs.js';
import {
	cell_item_insert_action_spec,
	cell_item_list_action_spec,
	type CellItemPosition,
} from '$lib/auth/cell_item_action_specs.js';
import {
	cell_field_set_action_spec,
	cell_field_list_action_spec,
	type CellFieldName,
} from '$lib/auth/cell_field_action_specs.js';
import {cell_grant_create_action_spec} from '$lib/auth/cell_grant_action_specs.js';
import {fractional_indices_between} from '@fuzdev/fuz_util/fractional_index.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import type {TestApp, TestAccount} from '$lib/testing/app_server.js';
import {describe_db, create_cell_test_app, create_cell, call} from './cell_test_helpers.js';

/**
 * Wire `pub_child` + `priv_child` under `parent` as both ordered items and
 * named fields, using `owner`'s session (owner can edit parent + view both
 * children).
 */
const wire_children = async (
	app: TestApp,
	owner: TestAccount,
	parent_id: Uuid,
	pub_child: Uuid,
	priv_child: Uuid,
): Promise<void> => {
	const headers = owner.create_session_headers();
	const [p0, p1] = fractional_indices_between(null, null, 2);
	const i0 = await call(
		app,
		cell_item_insert_action_spec,
		{parent_id, child_id: pub_child, position: p0! as CellItemPosition},
		headers,
	);
	assert.ok(i0.ok, JSON.stringify(i0));
	const i1 = await call(
		app,
		cell_item_insert_action_spec,
		{parent_id, child_id: priv_child, position: p1! as CellItemPosition},
		headers,
	);
	assert.ok(i1.ok, JSON.stringify(i1));
	const f0 = await call(
		app,
		cell_field_set_action_spec,
		{source_id: parent_id, name: 'pub_link' as CellFieldName, target_id: pub_child},
		headers,
	);
	assert.ok(f0.ok, JSON.stringify(f0));
	const f1 = await call(
		app,
		cell_field_set_action_spec,
		{source_id: parent_id, name: 'priv_link' as CellFieldName, target_id: priv_child},
		headers,
	);
	assert.ok(f1.ok, JSON.stringify(f1));
};

describe_db('cell relation visibility (D8)', (get_db) => {
	test('public parent bundle hides the private child from an anonymous viewer', async () => {
		const app = await create_cell_test_app(get_db);
		const owner = await app.create_account({username: 'rel_owner'});
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
			data: {kind: 'note', label: 'secret'},
			headers: owner.create_session_headers(),
		});
		await wire_children(app, owner, parent, pub_child, priv_child);

		// Anonymous: only the public child surfaces.
		const got = await call(app, cell_get_action_spec, {id: parent});
		assert.ok(got.ok, JSON.stringify(got));
		assert.deepStrictEqual(
			got.result.items.map((i) => i.child_id),
			[pub_child],
		);
		assert.deepStrictEqual(
			got.result.fields.map((f) => f.target_id),
			[pub_child],
		);
		// Truncation flags reflect the raw (pre-filter) relation size: both
		// relations had 2 rows, well under the bundle cap.
		assert.strictEqual(got.result.items_truncated, false);
		assert.strictEqual(got.result.fields_truncated, false);
	});

	test('forward item/field list filters the private child for an anonymous viewer', async () => {
		const app = await create_cell_test_app(get_db);
		const owner = await app.create_account({username: 'rel_owner_list'});
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

		const items = await call(app, cell_item_list_action_spec, {parent_id: parent});
		assert.ok(items.ok, JSON.stringify(items));
		assert.deepStrictEqual(
			items.result.items.map((i) => i.child_id),
			[pub_child],
		);

		const fields = await call(app, cell_field_list_action_spec, {source_id: parent});
		assert.ok(fields.ok, JSON.stringify(fields));
		assert.deepStrictEqual(
			fields.result.fields.map((f) => f.target_id),
			[pub_child],
		);
	});

	test('owner sees both children in their own bundle', async () => {
		const app = await create_cell_test_app(get_db);
		const owner = await app.create_account({username: 'rel_owner_self'});
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

		const got = await call(app, cell_get_action_spec, {id: parent}, owner.create_session_headers());
		assert.ok(got.ok, JSON.stringify(got));
		assert.strictEqual(got.result.items.length, 2);
		assert.strictEqual(got.result.fields.length, 2);
	});

	test('viewer-grant on a private parent sees only independently-viewable children', async () => {
		const app = await create_cell_test_app(get_db);
		const owner = await app.create_account({username: 'rel_owner_grant'});
		const viewer = await app.create_account({username: 'rel_viewer'});
		const {id: parent} = await create_cell(app, {
			data: {kind: 'collection'},
			headers: owner.create_session_headers(),
		});
		const {id: shared_child} = await create_cell(app, {
			data: {kind: 'note'},
			headers: owner.create_session_headers(),
		});
		const {id: priv_child} = await create_cell(app, {
			data: {kind: 'note'},
			headers: owner.create_session_headers(),
		});
		await wire_children(app, owner, parent, shared_child, priv_child);

		// Grant the viewer on parent AND on shared_child (but not priv_child).
		for (const cell_id of [parent, shared_child]) {
			const g = await call(
				app,
				cell_grant_create_action_spec,
				{cell_id, level: 'viewer', principal: {kind: 'actor', actor_id: viewer.actor.id}},
				owner.create_session_headers(),
			);
			assert.ok(g.ok, JSON.stringify(g));
		}

		const got = await call(
			app,
			cell_get_action_spec,
			{id: parent},
			viewer.create_session_headers(),
		);
		assert.ok(got.ok, JSON.stringify(got));
		assert.deepStrictEqual(
			got.result.items.map((i) => i.child_id),
			[shared_child],
		);
		assert.deepStrictEqual(
			got.result.fields.map((f) => f.target_id),
			[shared_child],
		);
	});
});
