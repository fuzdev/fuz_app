/**
 * Focused `cell_list` coverage — exercises every filter so the SQL-side
 * visibility predicate + positional-parameter layout are validated end to
 * end (this is what guards the no-hub parameter renumbering in
 * `query_cell_list`):
 *
 * - `kind`, `visibility`, `created_by`, `path_prefix`, `ids`, `ref`.
 * - `order_by` / `order_direction` + `limit` / `offset` paging.
 * - `shared_with: 'me'` (grant-admitted, owner-excluded, `cell_grants`
 *   enrichment) and its null-auth guard.
 * - null-auth `created_by` guard; anonymous sees public-only.
 *
 * Also covers no-hub global `path` uniqueness.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	cell_create_action_spec,
	cell_delete_action_spec,
	cell_list_action_spec,
	ERROR_CELL_LIST_CREATED_BY_REQUIRES_AUTH,
	ERROR_CELL_LIST_SHARED_WITH_REQUIRES_AUTH,
	ERROR_CELL_PATH_TAKEN,
	type CellPath
} from '$lib/auth/cell_action_specs.ts';
import { cell_grant_create_action_spec } from '$lib/auth/cell_grant_action_specs.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import type { FactHash } from '@fuzdev/fuz_util/fact_hash.ts';
import {
	describe_db,
	create_cell_test_app,
	create_cell,
	call,
	error_reason
} from './cell_test_helpers.ts';

const FACT_HASH = `blake3:${'a'.repeat(64)}` as FactHash;

describe_db('cell_actions cell_list', (get_db) => {
	describe('scalar filters', () => {
		test('kind narrows to the matching kind', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'l_kind' });
			const h = owner.create_session_headers();
			await create_cell(app, { kind: 'apple', data: {}, headers: h });
			await create_cell(app, { kind: 'apple', data: {}, headers: h });
			await create_cell(app, { kind: 'banana', data: {}, headers: h });

			const res = await call(app, cell_list_action_spec, { kind: 'apple' }, h);
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.cells.length, 2);
			assert.ok(res.result.cells.every((c) => c.kind === 'apple'));
		});

		test('visibility filter narrows owner results to public', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'l_vis' });
			const h = owner.create_session_headers();
			await create_cell(app, { kind: 'note', data: {}, visibility: 'public', headers: h });
			await create_cell(app, { kind: 'note', data: {}, headers: h }); // private

			const res = await call(app, cell_list_action_spec, { visibility: 'public' }, h);
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.cells.length, 1);
			assert.strictEqual(res.result.cells[0]!.visibility, 'public');
		});

		test('created_by filter (admin viewer) narrows to the creator', async () => {
			const app = await create_cell_test_app(get_db);
			const owner1 = await app.create_account({ username: 'l_cb1' });
			const owner2 = await app.create_account({ username: 'l_cb2' });
			const admin = await app.create_account({ username: 'l_cb_admin', roles: [ROLE_ADMIN] });
			await create_cell(app, { kind: 'note', data: {}, headers: owner1.create_session_headers() });
			await create_cell(app, { kind: 'note', data: {}, headers: owner2.create_session_headers() });

			const res = await call(
				app,
				cell_list_action_spec,
				{ created_by: owner1.actor.id },
				admin.create_session_headers()
			);
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.cells.length, 1);
			assert.strictEqual(res.result.cells[0]!.created_by, owner1.actor.id);
		});

		test('path_prefix matches a path subtree (admin-authored paths)', async () => {
			const app = await create_cell_test_app(get_db);
			const admin = await app.create_account({ username: 'l_pp_admin', roles: [ROLE_ADMIN] });
			const h = admin.create_session_headers();
			await create_cell(app, { kind: 'note', data: {}, path: '/a/1' as CellPath, headers: h });
			await create_cell(app, { kind: 'note', data: {}, path: '/a/2' as CellPath, headers: h });
			await create_cell(app, { kind: 'note', data: {}, path: '/b/1' as CellPath, headers: h });

			const res = await call(app, cell_list_action_spec, { path_prefix: '/a' as CellPath }, h);
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.cells.length, 2);
			assert.ok(res.result.cells.every((c) => c.path?.startsWith('/a')));
		});

		test('ids batch-fetches the requested cells', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'l_ids' });
			const h = owner.create_session_headers();
			const { id: a } = await create_cell(app, { kind: 'note', data: {}, headers: h });
			const { id: b } = await create_cell(app, { kind: 'note', data: {}, headers: h });
			await create_cell(app, { kind: 'note', data: {}, headers: h }); // not requested

			const res = await call(app, cell_list_action_spec, { ids: [a, b] }, h);
			assert.ok(res.ok, JSON.stringify(res));
			assert.deepStrictEqual(new Set(res.result.cells.map((c) => c.id)), new Set([a, b]));
		});

		test('ref matches cells whose data references a fact hash', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'l_ref' });
			const h = owner.create_session_headers();
			const { id } = await create_cell(app, {
				kind: 'note',
				data: { cover: FACT_HASH },
				headers: h
			});
			await create_cell(app, { kind: 'note', data: {}, headers: h }); // no ref

			const res = await call(app, cell_list_action_spec, { ref: FACT_HASH }, h);
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.cells.length, 1);
			assert.strictEqual(res.result.cells[0]!.id, id);
		});
	});

	describe('ordering + paging', () => {
		test('order_by created_at with direction + limit/offset', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'l_order' });
			const h = owner.create_session_headers();
			const { id: first } = await create_cell(app, {
				kind: 'note',
				data: { label: '1' },
				headers: h
			});
			const { id: second } = await create_cell(app, {
				kind: 'note',
				data: { label: '2' },
				headers: h
			});
			const { id: third } = await create_cell(app, {
				kind: 'note',
				data: { label: '3' },
				headers: h
			});

			const asc = await call(
				app,
				cell_list_action_spec,
				{ order_by: 'created_at', order_direction: 'asc', limit: 2 },
				h
			);
			assert.ok(asc.ok, JSON.stringify(asc));
			assert.deepStrictEqual(
				asc.result.cells.map((c) => c.id),
				[first, second]
			);

			const page2 = await call(
				app,
				cell_list_action_spec,
				{ order_by: 'created_at', order_direction: 'asc', limit: 2, offset: 2 },
				h
			);
			assert.ok(page2.ok, JSON.stringify(page2));
			assert.deepStrictEqual(
				page2.result.cells.map((c) => c.id),
				[third]
			);
		});
	});

	describe('shared_with: me', () => {
		test('lists grant-admitted cells, excludes owned, enriches cell_grants', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'sw_owner' });
			const viewer = await app.create_account({ username: 'sw_viewer' });
			const { id: shared } = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers()
			});
			// A cell the viewer owns — must NOT appear under shared_with: me.
			await create_cell(app, { kind: 'note', data: {}, headers: viewer.create_session_headers() });

			const g = await call(
				app,
				cell_grant_create_action_spec,
				{
					cell_id: shared,
					level: 'viewer',
					principal: { kind: 'actor', actor_id: viewer.actor.id }
				},
				owner.create_session_headers()
			);
			assert.ok(g.ok, JSON.stringify(g));

			const res = await call(
				app,
				cell_list_action_spec,
				{ shared_with: 'me' },
				viewer.create_session_headers()
			);
			assert.ok(res.ok, JSON.stringify(res));
			assert.deepStrictEqual(
				res.result.cells.map((c) => c.id),
				[shared]
			);
			assert.ok(res.result.cell_grants);
			assert.ok(res.result.cell_grants[shared]);
			assert.strictEqual(res.result.cell_grants[shared].length, 1);
		});
	});

	describe('null-auth guards + anonymous scope', () => {
		test('anonymous sees public-only', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'anon_owner' });
			const h = owner.create_session_headers();
			await create_cell(app, { kind: 'note', data: {}, visibility: 'public', headers: h });
			await create_cell(app, { kind: 'note', data: {}, headers: h }); // private

			const res = await call(app, cell_list_action_spec, {});
			assert.ok(res.ok, JSON.stringify(res));
			assert.ok(res.result.cells.every((c) => c.visibility === 'public'));
			assert.strictEqual(res.result.cells.length, 1);
		});

		test('null-auth created_by is rejected', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'anon_cb' });
			const res = await call(app, cell_list_action_spec, { created_by: owner.actor.id });
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(error_reason(res), ERROR_CELL_LIST_CREATED_BY_REQUIRES_AUTH);
		});

		test('null-auth shared_with is rejected', async () => {
			const app = await create_cell_test_app(get_db);
			const res = await call(app, cell_list_action_spec, { shared_with: 'me' });
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(error_reason(res), ERROR_CELL_LIST_SHARED_WITH_REQUIRES_AUTH);
		});
	});

	describe('no-hub global path uniqueness', () => {
		test('a duplicate active path is rejected', async () => {
			const app = await create_cell_test_app(get_db);
			const admin = await app.create_account({ username: 'dup_admin', roles: [ROLE_ADMIN] });
			const h = admin.create_session_headers();
			await create_cell(app, { kind: 'note', data: {}, path: '/dup' as CellPath, headers: h });

			// Second create at the same global path violates idx_cell_path_unique
			// and surfaces as a clean conflict (409).
			const dup = await call(
				app,
				cell_create_action_spec,
				{ kind: 'note', data: {}, path: '/dup' as CellPath },
				h
			);
			assert.ok(!dup.ok);
			assert.strictEqual(dup.status, 409);
			assert.strictEqual(error_reason(dup), ERROR_CELL_PATH_TAKEN);
		});

		test('a soft-deleted cell frees its path for reuse', async () => {
			const app = await create_cell_test_app(get_db);
			const admin = await app.create_account({ username: 'reuse_admin', roles: [ROLE_ADMIN] });
			const h = admin.create_session_headers();
			const { id } = await create_cell(app, {
				kind: 'note',
				data: {},
				path: '/reuse' as CellPath,
				headers: h
			});

			const del = await call(app, cell_delete_action_spec, { cell_id: id }, h);
			assert.ok(del.ok, JSON.stringify(del));

			// The partial unique index is scoped to `deleted_at IS NULL`, so
			// the tombstone frees `/reuse`.
			const reuse = await call(
				app,
				cell_create_action_spec,
				{ kind: 'note', data: {}, path: '/reuse' as CellPath },
				h
			);
			assert.ok(reuse.ok, JSON.stringify(reuse));
			assert.strictEqual(reuse.result.cell.path, '/reuse');
		});
	});
});
