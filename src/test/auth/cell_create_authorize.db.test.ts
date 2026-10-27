/**
 * In-process coverage of the cell-creation authorizer (`CellCreateAuthorize`)
 * and the `kind`-as-a-top-level-column invariants.
 *
 * The cross-backend `describe_cell_gated_create_cross_tests` proves TS↔Rust
 * authorizer parity on the spine binaries; this is the in-process leg that
 * makes bare `gro test` exercise the hook and the `kind` invariants (the cross
 * suite skips in-process, where the default app mounts no authorizer). The
 * gate is mounted via the optional third arg of `create_cell_test_app`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	cell_create_action_spec,
	cell_delete_action_spec,
	cell_update_action_spec,
	cell_get_action_spec,
	cell_list_action_spec,
	ERROR_CELL_NOT_FOUND,
	ERROR_CELL_CREATE_FORBIDDEN,
	ERROR_CELL_KIND_IN_DATA,
	ERROR_CELL_KIND_EMPTY,
	ERROR_CELL_PATH_ADMIN_ONLY,
	type CellPath,
	type CellUpdateInput
} from '#lib/auth/cell_action_specs.ts';
import type { CellCreateAuthorize } from '#lib/auth/cell_actions.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import type { TestApp } from '#lib/testing/app_server.ts';
import { create_cell_test_app, create_cell, call } from './cell_test_helpers.ts';
import { error_reason } from './rpc_test_helpers.ts';
import { describe_db } from '../cell_db_fixture.ts';

// Authorizer doubles — pure functions of the input returning a `CellCreateVerdict`
// (no role logic; the directory-policy gating is the cross suite's
// `test_cell_gated_create_authorize`). These creates are parentless (roots), so
// a `{allow: false}` verdict surfaces as the 403 `cell_create_forbidden` (the
// 404 mask is reserved for a *hidden parent*, which never runs the authorizer).
const deny_all: CellCreateAuthorize = { authorize: () => ({ allow: false }) };
const allow_all: CellCreateAuthorize = {
	authorize: () => ({ allow: true, moderation_required: false })
};
const deny_gated: CellCreateAuthorize = {
	authorize: (_auth, input) =>
		input.kind === 'gated' ? { allow: false } : { allow: true, moderation_required: false }
};

describe_db('cell create authorizer + kind invariants', (get_db) => {
	install_audit_drift_guard();

	describe('authorize_create gate', () => {
		test('deny-all → cell_create is forbidden (403) for a parentless create', async () => {
			const app = await create_cell_test_app(get_db, [], { authorize_create: deny_all });
			const actor = await app.create_account({ username: 'authz_deny' });
			const res = await call(
				app,
				cell_create_action_spec,
				{ kind: 'note', data: {} },
				actor.create_session_headers()
			);
			assert.ok(!res.ok, 'deny-all must block create');
			assert.strictEqual(error_reason(res), ERROR_CELL_CREATE_FORBIDDEN);
		});

		test('allow-all → create succeeds and stamps the kind column', async () => {
			const app = await create_cell_test_app(get_db, [], { authorize_create: allow_all });
			const actor = await app.create_account({ username: 'authz_allow' });
			const res = await call(
				app,
				cell_create_action_spec,
				{ kind: 'note', data: { label: 'x' } },
				actor.create_session_headers()
			);
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.cell.kind, 'note');
		});

		test('gate-by-kind → gated denied, ungated open, typeless open', async () => {
			const app = await create_cell_test_app(get_db, [], { authorize_create: deny_gated });
			const actor = await app.create_account({ username: 'authz_gate' });
			const h = actor.create_session_headers();
			const gated = await call(app, cell_create_action_spec, { kind: 'gated', data: {} }, h);
			assert.ok(!gated.ok, 'the gated kind is denied');
			assert.strictEqual(error_reason(gated), ERROR_CELL_CREATE_FORBIDDEN);
			const ungated = await call(app, cell_create_action_spec, { kind: 'note', data: {} }, h);
			assert.ok(ungated.ok, JSON.stringify(ungated));
			const typeless = await call(app, cell_create_action_spec, { data: {} }, h);
			assert.ok(typeless.ok, 'a typeless cell (kind=null) is not the gated kind');
			assert.strictEqual(typeless.result.cell.kind, null);
		});

		test('no authorizer mounted → create is open for any kind', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({ username: 'authz_open' });
			const res = await call(
				app,
				cell_create_action_spec,
				{ kind: 'gated', data: {} },
				actor.create_session_headers()
			);
			assert.ok(res.ok, 'no authorizer → open create');
		});

		test('an async authorizer is awaited', async () => {
			const async_deny: CellCreateAuthorize = {
				authorize: () => Promise.resolve({ allow: false })
			};
			const app = await create_cell_test_app(get_db, [], { authorize_create: async_deny });
			const actor = await app.create_account({ username: 'authz_async' });
			const res = await call(
				app,
				cell_create_action_spec,
				{ kind: 'note', data: {} },
				actor.create_session_headers()
			);
			assert.ok(!res.ok, 'an async deny is awaited and blocks');
			assert.strictEqual(error_reason(res), ERROR_CELL_CREATE_FORBIDDEN);
		});
	});

	describe('authz runs before the input-shape checks', () => {
		test('a non-editor update with kind-in-data gets the 404 IDOR mask, not the kind error', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'order_owner' });
			const stranger = await app.create_account({ username: 'order_stranger' });
			const { id } = await create_cell(app, {
				kind: 'note',
				data: { label: 'a' },
				headers: owner.create_session_headers()
			});
			// `can_edit` (404 IDOR mask) must fire before `reject_kind_in_data`,
			// so a caller who can't edit can't tell a malformed payload from a
			// missing cell. (The cross suite pins the same shape on the Rust spine.)
			const res = await call(
				app,
				cell_update_action_spec,
				{ cell_id: id, data: { kind: 'post' } },
				stranger.create_session_headers()
			);
			assert.ok(!res.ok, 'a non-editor must not reach the kind check');
			assert.strictEqual(error_reason(res), ERROR_CELL_NOT_FOUND);
		});

		test('a non-admin create with a path + kind-in-data gets path_admin_only, not the kind error', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({ username: 'order_path' });
			// The path-admin gate (403) fires before `reject_kind_in_data`.
			const res = await call(
				app,
				cell_create_action_spec,
				{ data: { kind: 'note' }, path: '/order/x' as CellPath },
				actor.create_session_headers()
			);
			assert.ok(!res.ok, 'a non-admin path write must be refused first');
			assert.strictEqual(error_reason(res), ERROR_CELL_PATH_ADMIN_ONLY);
		});
	});

	describe('kind is a top-level column, fixed at birth', () => {
		test('a kind key inside data is rejected fail-loud on create', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({ username: 'kind_in_data' });
			const res = await call(
				app,
				cell_create_action_spec,
				{ data: { kind: 'note' } },
				actor.create_session_headers()
			);
			assert.ok(!res.ok, 'kind belongs at the top level, not inside data');
			assert.strictEqual(error_reason(res), ERROR_CELL_KIND_IN_DATA);
		});

		test('a kind key inside data is rejected on update too', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({ username: 'kind_in_data_update' });
			const h = actor.create_session_headers();
			const { id } = await create_cell(app, { kind: 'note', data: { label: 'a' }, headers: h });
			const res = await call(
				app,
				cell_update_action_spec,
				{ cell_id: id, data: { kind: 'post', label: 'b' } },
				h
			);
			assert.ok(!res.ok, 'update may not smuggle a kind change through data');
			assert.strictEqual(error_reason(res), ERROR_CELL_KIND_IN_DATA);
		});

		test('a top-level kind on cell_update is rejected by the wire schema', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({ username: 'kind_top_level_update' });
			const h = actor.create_session_headers();
			const { id } = await create_cell(app, { kind: 'note', data: { label: 'a' }, headers: h });
			// `kind` is not a field on `CellUpdateInput` (z.strictObject), so a
			// top-level `kind` has no wire path in — kind is structurally immutable.
			const res = await call(
				app,
				cell_update_action_spec,
				{ cell_id: id, kind: 'post' } as unknown as CellUpdateInput,
				h
			);
			assert.ok(!res.ok, 'a top-level kind on update must be rejected');
			// The rejected update never touched the column.
			const got = await call(app, cell_get_action_spec, { id }, h);
			assert.ok(got.ok);
			assert.strictEqual(got.result.cell.kind, 'note');
		});

		test('kind survives a data update (write-once column)', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({ username: 'kind_persist' });
			const h = actor.create_session_headers();
			const { id } = await create_cell(app, { kind: 'note', data: { label: 'a' }, headers: h });
			const updated = await call(
				app,
				cell_update_action_spec,
				{ cell_id: id, data: { label: 'b' } },
				h
			);
			assert.ok(updated.ok, JSON.stringify(updated));
			assert.strictEqual(updated.result.cell.kind, 'note', 'kind unchanged by a data-only update');
			const got = await call(app, cell_get_action_spec, { id }, h);
			assert.ok(got.ok);
			assert.strictEqual(got.result.cell.kind, 'note');
		});
	});

	describe('empty kind is not a valid tag', () => {
		test('an empty-string kind is rejected on create (fail-loud)', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({ username: 'kind_empty' });
			const res = await call(
				app,
				cell_create_action_spec,
				{ kind: '', data: {} },
				actor.create_session_headers()
			);
			assert.ok(!res.ok, 'an empty kind is a tag that tags nothing');
			assert.strictEqual(error_reason(res), ERROR_CELL_KIND_EMPTY);
		});

		test('an empty-kind list filter matches nothing (not an error)', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({ username: 'kind_empty_list' });
			const h = actor.create_session_headers();
			await create_cell(app, { kind: 'note', data: {}, headers: h });
			await create_cell(app, { data: {}, headers: h }); // typeless (kind = null)
			// The filter accepts '' (no min-length) and matches nothing, so TS and
			// Rust agree — Rust never imposed the min-length the TS filter used to.
			const res = await call(app, cell_list_action_spec, { kind: '' }, h);
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.cells.length, 0, 'empty kind matches no cells');
		});
	});

	describe('a tombstoned root refuses contributions', () => {
		const count_cells = async (): Promise<number> => {
			const rows = await get_db().query<{ n: number }>(`SELECT count(*)::int AS n FROM cell`);
			return rows[0]!.n;
		};

		// A public space with a post under it, a comment under the post that
		// lands governed by the space (the live-root control), then the space is
		// soft-deleted — soft delete doesn't cascade, so the post stays live.
		const seed_post_under_deleted_space = async (
			app: TestApp,
			h: Record<string, string>
		): Promise<Uuid> => {
			const space = await call(
				app,
				cell_create_action_spec,
				{ kind: 'space', data: {}, visibility: 'public' },
				h
			);
			assert.ok(space.ok, JSON.stringify(space));
			const space_id = space.result.cell.id;
			const post = await call(
				app,
				cell_create_action_spec,
				{ kind: 'post', data: {}, parent_id: space_id },
				h
			);
			assert.ok(post.ok, JSON.stringify(post));
			const post_id = post.result.cell.id;
			const comment = await call(
				app,
				cell_create_action_spec,
				{ kind: 'comment', data: {}, parent_id: post_id },
				h
			);
			assert.ok(comment.ok, JSON.stringify(comment));
			assert.strictEqual(comment.result.cell.root_id, space_id, 'live root: governed');
			const deleted = await call(app, cell_delete_action_spec, { cell_id: space_id }, h);
			assert.ok(deleted.ok, JSON.stringify(deleted));
			return post_id;
		};

		test('no authorizer mounted → cell_not_found, nothing written', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({ username: 'tomb_open' });
			const h = actor.create_session_headers();
			const post_id = await seed_post_under_deleted_space(app, h);
			const before = await count_cells();
			const res = await call(
				app,
				cell_create_action_spec,
				{ kind: 'comment', data: {}, parent_id: post_id },
				h
			);
			assert.ok(!res.ok, 'a create under a deleted root must be refused');
			assert.strictEqual(error_reason(res), ERROR_CELL_NOT_FOUND);
			assert.strictEqual(await count_cells(), before, 'nothing was written');
		});

		test('an authorizer mounted → cell_not_found before it is consulted', async () => {
			let calls = 0;
			const counting_allow: CellCreateAuthorize = {
				authorize: (auth, input) => {
					calls++;
					return allow_all.authorize(auth, input);
				}
			};
			const app = await create_cell_test_app(get_db, [], { authorize_create: counting_allow });
			const actor = await app.create_account({ username: 'tomb_gated' });
			const h = actor.create_session_headers();
			const post_id = await seed_post_under_deleted_space(app, h);
			const before = await count_cells();
			const calls_before = calls;
			const res = await call(
				app,
				cell_create_action_spec,
				{ kind: 'comment', data: {}, parent_id: post_id },
				h
			);
			assert.ok(!res.ok, 'a create under a deleted root must be refused');
			assert.strictEqual(error_reason(res), ERROR_CELL_NOT_FOUND);
			assert.strictEqual(await count_cells(), before, 'nothing was written');
			assert.strictEqual(calls, calls_before, 'the authorizer is not consulted');
		});
	});
});
