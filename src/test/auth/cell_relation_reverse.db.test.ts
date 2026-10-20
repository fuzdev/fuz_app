/**
 * Reverse relation-list 2-layer authz — `cell_item_list({child_id})` and
 * `cell_field_list({target_id})`.
 *
 * The reverse direction enumerates the parents/sources that point at a
 * cell. Two authz layers must hold:
 *   1. gate on `can_view_cell(child/target)` — an unviewable anchor 404s,
 *      so the row count can't leak "N viewable cells link here";
 *   2. per-row filter on `can_view_cell(parent/source)` — only edges from
 *      cells the caller can independently view come back.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { cell_item_list_action_spec } from '#lib/auth/cell_item_action_specs.ts';
import {
	cell_field_set_action_spec,
	cell_field_list_action_spec,
	type CellFieldName
} from '#lib/auth/cell_field_action_specs.ts';
import { cell_grant_create_action_spec } from '#lib/auth/cell_grant_action_specs.ts';
import { ERROR_CELL_NOT_FOUND } from '#lib/auth/cell_action_specs.ts';
import { CELL_RELATION_LIST_LIMIT_DEFAULT } from '#lib/auth/cell_relation_list_limit.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import type { TestApp, TestAccount } from '#lib/testing/app_server.ts';
import { create_cell_test_app, create_cell, call } from './cell_test_helpers.ts';
import { error_reason } from './rpc_test_helpers.ts';
import { describe_db } from '../cell_db_fixture.ts';

const grant_viewer = (app: TestApp, granter: TestAccount, cell_id: Uuid, actor_id: Uuid) =>
	call(
		app,
		cell_grant_create_action_spec,
		{ cell_id, level: 'viewer', principal: { kind: 'actor', actor_id } },
		granter.create_session_headers()
	);

describe_db('cell relation reverse authz', (get_db) => {
	describe('reverse cell_item_list({child_id})', () => {
		test('anonymous sees only public parents of a public child', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'rv_owner' });
			const h = owner.create_session_headers();
			const { id: child } = await create_cell(app, {
				kind: 'note',
				data: {},
				visibility: 'public',
				headers: h
			});
			const { id: pub_parent } = await create_cell(app, {
				kind: 'collection',
				data: {},
				visibility: 'public',
				items: [child],
				headers: h
			});
			// A private parent of the same child — must NOT surface to anon.
			await create_cell(app, { kind: 'collection', data: {}, items: [child], headers: h });

			const res = await call(app, cell_item_list_action_spec, { child_id: child });
			assert.ok(res.ok, JSON.stringify(res));
			assert.deepStrictEqual(
				res.result.items.map((i) => i.parent_id),
				[pub_parent]
			);
		});

		test('a viewer-grant on a private parent reveals it in the reverse list', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'rv_owner2' });
			const viewer = await app.create_account({ username: 'rv_viewer' });
			const h = owner.create_session_headers();
			const { id: child } = await create_cell(app, {
				kind: 'note',
				data: {},
				visibility: 'public',
				headers: h
			});
			const { id: priv_parent } = await create_cell(app, {
				kind: 'collection',
				data: {},
				items: [child],
				headers: h
			});
			assert.ok((await grant_viewer(app, owner, priv_parent, viewer.actor.id)).ok);

			const res = await call(
				app,
				cell_item_list_action_spec,
				{ child_id: child },
				viewer.create_session_headers()
			);
			assert.ok(res.ok, JSON.stringify(res));
			assert.deepStrictEqual(
				res.result.items.map((i) => i.parent_id),
				[priv_parent]
			);
		});

		test('an unviewable child 404s the reverse list (count-leak guard)', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'rv_priv_owner' });
			const h = owner.create_session_headers();
			const { id: priv_child } = await create_cell(app, { kind: 'note', data: {}, headers: h });
			await create_cell(app, { kind: 'collection', data: {}, items: [priv_child], headers: h });

			const res = await call(app, cell_item_list_action_spec, { child_id: priv_child });
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(error_reason(res), ERROR_CELL_NOT_FOUND);
		});
	});

	describe('reverse cell_field_list({target_id})', () => {
		test('anonymous sees only public sources of a public target', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'rvf_owner' });
			const h = owner.create_session_headers();
			const { id: target } = await create_cell(app, {
				kind: 'note',
				data: {},
				visibility: 'public',
				headers: h
			});
			const { id: pub_source } = await create_cell(app, {
				kind: 'note',
				data: {},
				visibility: 'public',
				headers: h
			});
			const { id: priv_source } = await create_cell(app, { kind: 'note', data: {}, headers: h });
			for (const source of [pub_source, priv_source]) {
				const r = await call(
					app,
					cell_field_set_action_spec,
					{ source_id: source, name: 'link' as CellFieldName, target_id: target },
					h
				);
				assert.ok(r.ok, JSON.stringify(r));
			}

			const res = await call(app, cell_field_list_action_spec, { target_id: target });
			assert.ok(res.ok, JSON.stringify(res));
			assert.deepStrictEqual(
				res.result.fields.map((f) => f.source_id),
				[pub_source]
			);
		});

		test('an unviewable target 404s the reverse list', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'rvf_priv_owner' });
			const h = owner.create_session_headers();
			const { id: target } = await create_cell(app, { kind: 'note', data: {}, headers: h }); // private
			const { id: source } = await create_cell(app, { kind: 'note', data: {}, headers: h });
			assert.ok(
				(
					await call(
						app,
						cell_field_set_action_spec,
						{ source_id: source, name: 'link' as CellFieldName, target_id: target },
						h
					)
				).ok
			);

			const res = await call(app, cell_field_list_action_spec, { target_id: target });
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
		});
	});

	describe('reverse lists are capped', () => {
		// one past the default page, so an omitted limit shows the cap
		const inbound = CELL_RELATION_LIST_LIMIT_DEFAULT + 1;

		test('cell_item_list({child_id}) defaults to the page cap and honors limit', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'rv_cap_items' });
			const h = owner.create_session_headers();
			const { id: child } = await create_cell(app, { kind: 'note', data: {}, headers: h });
			await create_cell(app, {
				kind: 'collection',
				data: {},
				items: Array.from({ length: inbound }, () => child),
				headers: h
			});
			const list = async (params: { limit?: number }) => {
				const res = await call(app, cell_item_list_action_spec, { child_id: child, ...params }, h);
				assert.ok(res.ok, JSON.stringify(res));
				return res.result.items;
			};
			assert.strictEqual((await list({})).length, CELL_RELATION_LIST_LIMIT_DEFAULT);
			assert.strictEqual((await list({ limit: inbound })).length, inbound);
			const page = await list({ limit: 3 });
			assert.strictEqual(page.length, 3);
			// oldest first, the same rows a wider page starts with
			assert.deepStrictEqual(
				page.map((i) => i.position),
				(await list({ limit: inbound })).slice(0, 3).map((i) => i.position)
			);
		});

		test('cell_field_list({target_id}) defaults to the page cap and honors limit', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'rv_cap_fields' });
			const h = owner.create_session_headers();
			const { id: target } = await create_cell(app, { kind: 'note', data: {}, headers: h });
			const { id: source } = await create_cell(app, { kind: 'note', data: {}, headers: h });
			for (let i = 0; i < inbound; i++) {
				const r = await call(
					app,
					cell_field_set_action_spec,
					{ source_id: source, name: `link_${i}` as CellFieldName, target_id: target },
					h
				);
				assert.ok(r.ok, JSON.stringify(r));
			}
			const list = async (params: { limit?: number }) => {
				const res = await call(
					app,
					cell_field_list_action_spec,
					{ target_id: target, ...params },
					h
				);
				assert.ok(res.ok, JSON.stringify(res));
				return res.result.fields;
			};
			assert.strictEqual((await list({})).length, CELL_RELATION_LIST_LIMIT_DEFAULT);
			assert.strictEqual((await list({ limit: inbound })).length, inbound);
			assert.strictEqual((await list({ limit: 3 })).length, 3);
		});

		test('the forward lists default to the page cap too', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'fw_cap' });
			const h = owner.create_session_headers();
			const { id: child } = await create_cell(app, { kind: 'note', data: {}, headers: h });
			const { id: parent } = await create_cell(app, {
				kind: 'collection',
				data: {},
				items: Array.from({ length: inbound }, () => child),
				headers: h
			});
			const res = await call(app, cell_item_list_action_spec, { parent_id: parent }, h);
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.items.length, CELL_RELATION_LIST_LIMIT_DEFAULT);
		});
	});
});
