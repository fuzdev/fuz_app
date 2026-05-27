/**
 * Focused authz-matrix coverage for the generic cell verbs:
 *
 * - owner / admin / stranger / viewer-grant / editor-grant on
 *   `cell_get` / `cell_update` / `cell_delete` (D6 manage tier =
 *   admin / owner; edit tier = admin / owner / editor-grant).
 * - public cells readable by unauthenticated callers; private cells
 *   404 (IDOR mask) for non-admitted callers.
 * - D7: `visibility` writes are manage-tier only — an editor-grant
 *   holder editing `data` cannot flip visibility
 *   (`ERROR_CELL_VISIBILITY_MANAGE_ONLY`), but round-tripping the
 *   unchanged value is allowed.
 * - D9: `path` writes are admin-only on both create and update
 *   (`ERROR_CELL_PATH_ADMIN_ONLY`).
 *
 * Part of the focused first-pass checklist suite. Broader CRUD shape /
 * clone / audit coverage is a later pass.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {
	cell_create_action_spec,
	cell_get_action_spec,
	cell_update_action_spec,
	cell_delete_action_spec,
	ERROR_CELL_NOT_FOUND,
	ERROR_CELL_PATH_ADMIN_ONLY,
	ERROR_CELL_VISIBILITY_MANAGE_ONLY,
	type CellPath,
} from '$lib/auth/cell_action_specs.js';
import {cell_grant_create_action_spec} from '$lib/auth/cell_grant_action_specs.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import type {TestApp, TestAccount} from '$lib/testing/app_server.js';
import {
	describe_db,
	create_cell_test_app,
	create_cell,
	call,
	error_reason,
} from './cell_test_helpers.js';

/** Grant an actor-shaped grant from `granter` onto `cell_id`. */
const grant_actor = (
	app: TestApp,
	granter: TestAccount,
	cell_id: Uuid,
	level: 'viewer' | 'editor',
	actor_id: Uuid,
) =>
	call(
		app,
		cell_grant_create_action_spec,
		{cell_id, level, principal: {kind: 'actor', actor_id}},
		granter.create_session_headers(),
	);

describe_db('cell_actions authz', (get_db) => {
	describe('owner / admin / stranger on private cell', () => {
		test('owner can get, update, and delete their own private cell', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_self'});
			const {id} = await create_cell(app, {
				data: {kind: 'note', label: 'mine'},
				headers: owner.create_session_headers(),
			});

			const got = await call(app, cell_get_action_spec, {id}, owner.create_session_headers());
			assert.ok(got.ok, JSON.stringify(got));
			assert.strictEqual(got.result.cell.id, id);
			assert.strictEqual(got.result.can_edit, true);
			assert.strictEqual(got.result.can_grant, true);

			const upd = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {kind: 'note', label: 'edited'}},
				owner.create_session_headers(),
			);
			assert.ok(upd.ok, JSON.stringify(upd));
			assert.strictEqual(upd.result.cell.data.label, 'edited');

			const del = await call(
				app,
				cell_delete_action_spec,
				{cell_id: id},
				owner.create_session_headers(),
			);
			assert.ok(del.ok, JSON.stringify(del));
			assert.strictEqual(del.result.deleted, true);
		});

		test('stranger gets 404 on get / update / delete of a private cell', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_priv'});
			const stranger = await app.create_account({username: 'stranger'});
			const {id} = await create_cell(app, {
				data: {kind: 'note'},
				headers: owner.create_session_headers(),
			});

			const got = await call(app, cell_get_action_spec, {id}, stranger.create_session_headers());
			assert.ok(!got.ok);
			assert.strictEqual(got.status, 404);
			assert.strictEqual(error_reason(got), ERROR_CELL_NOT_FOUND);

			const upd = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {kind: 'note', label: 'x'}},
				stranger.create_session_headers(),
			);
			assert.ok(!upd.ok);
			assert.strictEqual(upd.status, 404);
			assert.strictEqual(error_reason(upd), ERROR_CELL_NOT_FOUND);

			const del = await call(
				app,
				cell_delete_action_spec,
				{cell_id: id},
				stranger.create_session_headers(),
			);
			assert.ok(!del.ok);
			assert.strictEqual(del.status, 404);
		});

		test('admin can get / update / delete a cell owned by another actor', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_for_admin'});
			const admin = await app.create_account({username: 'admin_acct', roles: [ROLE_ADMIN]});
			const {id} = await create_cell(app, {
				data: {kind: 'note'},
				headers: owner.create_session_headers(),
			});

			const got = await call(app, cell_get_action_spec, {id}, admin.create_session_headers());
			assert.ok(got.ok, JSON.stringify(got));
			assert.strictEqual(got.result.can_edit, true);
			assert.strictEqual(got.result.can_grant, true);

			const upd = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {kind: 'note', label: 'admin-edit'}},
				admin.create_session_headers(),
			);
			assert.ok(upd.ok, JSON.stringify(upd));

			const del = await call(
				app,
				cell_delete_action_spec,
				{cell_id: id},
				admin.create_session_headers(),
			);
			assert.ok(del.ok, JSON.stringify(del));
		});
	});

	describe('public visibility + anonymous reads', () => {
		test('anonymous can get a public cell but 404s on a private cell', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_pub'});
			const {id: pub_id} = await create_cell(app, {
				data: {kind: 'note', label: 'public'},
				visibility: 'public',
				headers: owner.create_session_headers(),
			});
			const {id: priv_id} = await create_cell(app, {
				data: {kind: 'note'},
				headers: owner.create_session_headers(),
			});

			// No headers = unauthenticated.
			const pub = await call(app, cell_get_action_spec, {id: pub_id});
			assert.ok(pub.ok, JSON.stringify(pub));
			assert.strictEqual(pub.result.can_edit, false);
			assert.strictEqual(pub.result.can_grant, false);

			const priv = await call(app, cell_get_action_spec, {id: priv_id});
			assert.ok(!priv.ok);
			assert.strictEqual(priv.status, 404);
		});
	});

	describe('grant tiers', () => {
		test('viewer-grant can get but not update', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_v'});
			const viewer = await app.create_account({username: 'viewer'});
			const {id} = await create_cell(app, {
				data: {kind: 'note'},
				headers: owner.create_session_headers(),
			});
			const g = await grant_actor(app, owner, id, 'viewer', viewer.actor.id);
			assert.ok(g.ok, JSON.stringify(g));

			const got = await call(app, cell_get_action_spec, {id}, viewer.create_session_headers());
			assert.ok(got.ok, JSON.stringify(got));
			assert.strictEqual(got.result.can_edit, false);
			// can_grant tracks manage tier — a viewer is not a manager.
			assert.strictEqual(got.result.can_grant, false);

			const upd = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {kind: 'note', label: 'nope'}},
				viewer.create_session_headers(),
			);
			assert.ok(!upd.ok);
			assert.strictEqual(upd.status, 404);
		});

		test('editor-grant can get, update, and delete', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_e'});
			const editor = await app.create_account({username: 'editor'});
			const {id} = await create_cell(app, {
				data: {kind: 'note'},
				headers: owner.create_session_headers(),
			});
			const g = await grant_actor(app, owner, id, 'editor', editor.actor.id);
			assert.ok(g.ok, JSON.stringify(g));

			const got = await call(app, cell_get_action_spec, {id}, editor.create_session_headers());
			assert.ok(got.ok, JSON.stringify(got));
			assert.strictEqual(got.result.can_edit, true);
			// Editor is not a manager — can_grant stays false.
			assert.strictEqual(got.result.can_grant, false);

			const upd = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {kind: 'note', label: 'editor-edit'}},
				editor.create_session_headers(),
			);
			assert.ok(upd.ok, JSON.stringify(upd));

			const del = await call(
				app,
				cell_delete_action_spec,
				{cell_id: id},
				editor.create_session_headers(),
			);
			assert.ok(del.ok, JSON.stringify(del));
		});
	});

	describe('D7 — visibility is manage-tier only', () => {
		test('editor-grant holder cannot flip visibility', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_vis'});
			const editor = await app.create_account({username: 'editor_vis'});
			const {id} = await create_cell(app, {
				data: {kind: 'note'},
				headers: owner.create_session_headers(),
			});
			const g = await grant_actor(app, owner, id, 'editor', editor.actor.id);
			assert.ok(g.ok, JSON.stringify(g));

			// Flipping visibility as a delegated editor is rejected.
			const flip = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, visibility: 'public'},
				editor.create_session_headers(),
			);
			assert.ok(!flip.ok);
			assert.strictEqual(flip.status, 403);
			assert.strictEqual(flip.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(error_reason(flip), ERROR_CELL_VISIBILITY_MANAGE_ONLY);

			// Round-tripping the unchanged value alongside a data edit is OK.
			const same = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, visibility: 'private', data: {kind: 'note', label: 'edit-no-flip'}},
				editor.create_session_headers(),
			);
			assert.ok(same.ok, JSON.stringify(same));
			assert.strictEqual(same.result.cell.data.label, 'edit-no-flip');
		});

		test('owner can flip visibility', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_flip'});
			const {id} = await create_cell(app, {
				data: {kind: 'note'},
				headers: owner.create_session_headers(),
			});
			const flip = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, visibility: 'public'},
				owner.create_session_headers(),
			);
			assert.ok(flip.ok, JSON.stringify(flip));
			assert.strictEqual(flip.result.cell.visibility, 'public');
		});
	});

	describe('D9 — path is admin-only', () => {
		test('non-admin create with path is rejected', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_path'});
			// `create_cell` helper asserts ok; this is a denial path, so call directly.
			const res = await call(
				app,
				cell_create_action_spec,
				{data: {kind: 'note'}, path: '/well-known/x' as CellPath},
				owner.create_session_headers(),
			);
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(error_reason(res), ERROR_CELL_PATH_ADMIN_ONLY);
		});

		test('non-admin update with path is rejected even with no other change', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_path_upd'});
			const {id} = await create_cell(app, {
				data: {kind: 'note'},
				headers: owner.create_session_headers(),
			});
			const res = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, path: '/well-known/y' as CellPath},
				owner.create_session_headers(),
			);
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(error_reason(res), ERROR_CELL_PATH_ADMIN_ONLY);
		});

		test('admin can write path on create and update', async () => {
			const app = await create_cell_test_app(get_db);
			const admin = await app.create_account({username: 'admin_path', roles: [ROLE_ADMIN]});
			const {id} = await create_cell(app, {
				data: {kind: 'note'},
				path: '/well-known/admin' as CellPath,
				headers: admin.create_session_headers(),
			});
			const got = await call(app, cell_get_action_spec, {id}, admin.create_session_headers());
			assert.ok(got.ok, JSON.stringify(got));
			assert.strictEqual(got.result.cell.path, '/well-known/admin');

			const upd = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, path: '/well-known/admin2' as CellPath},
				admin.create_session_headers(),
			);
			assert.ok(upd.ok, JSON.stringify(upd));
			assert.strictEqual(upd.result.cell.path, '/well-known/admin2');
		});
	});
});
