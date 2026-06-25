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

import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.ts';
import {
	cell_create_action_spec,
	cell_get_action_spec,
	cell_update_action_spec,
	cell_delete_action_spec,
	ERROR_CELL_NOT_FOUND,
	ERROR_CELL_PATH_ADMIN_ONLY,
	ERROR_CELL_VISIBILITY_MANAGE_ONLY,
	type CellPath,
} from '$lib/auth/cell_action_specs.ts';
import {cell_grant_create_action_spec} from '$lib/auth/cell_grant_action_specs.ts';
import {ROLE_ADMIN} from '$lib/auth/role_schema.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';
import type {TestApp, TestAccount} from '$lib/testing/app_server.ts';
import {
	describe_db,
	create_cell_test_app,
	create_cell,
	call,
	error_reason,
} from './cell_test_helpers.ts';

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
				kind: 'note',
				data: {label: 'mine'},
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
				{cell_id: id, data: {label: 'edited'}},
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
				kind: 'note',
				data: {},
				headers: owner.create_session_headers(),
			});

			const got = await call(app, cell_get_action_spec, {id}, stranger.create_session_headers());
			assert.ok(!got.ok);
			assert.strictEqual(got.status, 404);
			assert.strictEqual(error_reason(got), ERROR_CELL_NOT_FOUND);

			const upd = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {label: 'x'}},
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
				kind: 'note',
				data: {},
				headers: owner.create_session_headers(),
			});

			const got = await call(app, cell_get_action_spec, {id}, admin.create_session_headers());
			assert.ok(got.ok, JSON.stringify(got));
			assert.strictEqual(got.result.can_edit, true);
			assert.strictEqual(got.result.can_grant, true);

			const upd = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {label: 'admin-edit'}},
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
				kind: 'note',
				data: {label: 'public'},
				visibility: 'public',
				headers: owner.create_session_headers(),
			});
			const {id: priv_id} = await create_cell(app, {
				kind: 'note',
				data: {},
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
				kind: 'note',
				data: {},
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
				{cell_id: id, data: {label: 'nope'}},
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
				kind: 'note',
				data: {},
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
				{cell_id: id, data: {label: 'editor-edit'}},
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
				kind: 'note',
				data: {},
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
				{cell_id: id, visibility: 'private', data: {label: 'edit-no-flip'}},
				editor.create_session_headers(),
			);
			assert.ok(same.ok, JSON.stringify(same));
			assert.strictEqual(same.result.cell.data.label, 'edit-no-flip');
		});

		test('owner can flip visibility', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_flip'});
			const {id} = await create_cell(app, {
				kind: 'note',
				data: {},
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
				{kind: 'note', data: {}, path: '/well-known/x' as CellPath},
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
				kind: 'note',
				data: {},
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
				kind: 'note',
				data: {},
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

	describe('404-over-403 mask is byte-identical to a genuine miss', () => {
		// The core "cannot be probed" property for the cell surface: a private
		// cell the caller cannot view, a cell they can view but not edit, and a
		// genuinely nonexistent id must all return the SAME 404 — not merely the
		// same status + reason (which the blocks above pin), but a byte-identical
		// error envelope `{status, error: {code, message, data}}`. Any
		// distinguishing field (an id echo, a divergent message, an extra
		// `data` key on one path) would let a prober confirm a private cell
		// exists by id — exactly the leak the mask exists to close.
		// security.md §Authorization "404-over-403 is the general mask".
		const NONEXISTENT_ID = '00000000-0000-0000-0000-000000000000' as Uuid;
		const mask = (r: Awaited<ReturnType<typeof call>>): {status: number; error: unknown} => {
			assert.ok(!r.ok, `expected a denial response, got ${JSON.stringify(r)}`);
			return {status: r.status, error: r.error};
		};

		test('cell_get: unviewable private cell ≡ nonexistent id', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_mask_get'});
			const stranger = await app.create_account({username: 'stranger_mask_get'});
			const {id} = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers(),
			});
			// Same caller for both probes, so the only variable is the cell's
			// existence/viewability — the response must not reflect it.
			const unviewable = await call(
				app,
				cell_get_action_spec,
				{id},
				stranger.create_session_headers(),
			);
			const missing = await call(
				app,
				cell_get_action_spec,
				{id: NONEXISTENT_ID},
				stranger.create_session_headers(),
			);
			assert.strictEqual(unviewable.status, 404);
			assert.deepStrictEqual(mask(unviewable), mask(missing));
		});

		test('cell_update: unviewable ≡ view-but-not-edit ≡ nonexistent id', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_mask_upd'});
			const stranger = await app.create_account({username: 'stranger_mask_upd'});
			const viewer = await app.create_account({username: 'viewer_mask_upd'});
			const {id} = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers(),
			});
			const g = await grant_actor(app, owner, id, 'viewer', viewer.actor.id);
			assert.ok(g.ok, JSON.stringify(g));

			const unviewable = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {label: 'x'}},
				stranger.create_session_headers(),
			);
			// A viewer can SEE the cell but not edit it — the edit-deny path must
			// also collapse to the not-found mask, or "I can see it but can't edit"
			// becomes an existence oracle distinct from "no such cell".
			const view_not_edit = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {label: 'x'}},
				viewer.create_session_headers(),
			);
			const missing = await call(
				app,
				cell_update_action_spec,
				{cell_id: NONEXISTENT_ID, data: {label: 'x'}},
				stranger.create_session_headers(),
			);
			assert.strictEqual(unviewable.status, 404);
			assert.deepStrictEqual(mask(unviewable), mask(view_not_edit));
			assert.deepStrictEqual(mask(unviewable), mask(missing));
		});

		test('cell_delete: unviewable private cell ≡ nonexistent id', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'owner_mask_del'});
			const stranger = await app.create_account({username: 'stranger_mask_del'});
			const {id} = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers(),
			});
			const unviewable = await call(
				app,
				cell_delete_action_spec,
				{cell_id: id},
				stranger.create_session_headers(),
			);
			const missing = await call(
				app,
				cell_delete_action_spec,
				{cell_id: NONEXISTENT_ID},
				stranger.create_session_headers(),
			);
			assert.strictEqual(unviewable.status, 404);
			assert.deepStrictEqual(mask(unviewable), mask(missing));
		});
	});
});
