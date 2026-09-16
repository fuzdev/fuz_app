/**
 * Focused authz coverage for the `cell_grant_*` verbs.
 *
 * Grant management is manage-tier only (admin / owner). Editor-grant
 * holders may edit a cell's content + relations but cannot create, list,
 * or revoke its grants — they get the IDOR-mask 404, same as a plain
 * viewer. Covers:
 *
 * - editor-grant holders denied on grant create / list / revoke.
 * - owner / admin can create (viewer + editor), list, and revoke.
 * - self-revoke ("leave shared cell") works for one's own actor-grant and
 *   reports `still_admitted: false` when no other path remains.
 * - owner-as-principal and unknown-role are rejected.
 * - a role-shaped grant admits a holder of that role.
 *
 * Part of the focused first-pass checklist suite.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { cell_get_action_spec, ERROR_CELL_NOT_FOUND } from '$lib/auth/cell_action_specs.ts';
import {
	cell_grant_create_action_spec,
	cell_grant_revoke_action_spec,
	cell_grant_list_action_spec,
	ERROR_CELL_GRANT_PRINCIPAL_IS_OWNER,
	ERROR_CELL_GRANT_UNKNOWN_ROLE
} from '$lib/auth/cell_grant_action_specs.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import type { TestApp, TestAccount } from '$lib/testing/app_server.ts';
import {
	describe_db,
	create_cell_test_app,
	create_cell,
	call,
	error_reason,
	ROLE_MEMBER
} from './cell_test_helpers.ts';

const grant_actor = (
	app: TestApp,
	granter: TestAccount,
	cell_id: Uuid,
	level: 'viewer' | 'editor',
	actor_id: Uuid
) =>
	call(
		app,
		cell_grant_create_action_spec,
		{ cell_id, level, principal: { kind: 'actor', actor_id } },
		granter.create_session_headers()
	);

describe_db('cell_grant_actions authz', (get_db) => {
	describe('grant management is manage-tier only', () => {
		test('editor-grant holder cannot create, list, or revoke grants', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'g_owner' });
			const editor = await app.create_account({ username: 'g_editor' });
			const target = await app.create_account({ username: 'g_target' });
			const { id } = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers()
			});

			const e = await grant_actor(app, owner, id, 'editor', editor.actor.id);
			assert.ok(e.ok, JSON.stringify(e));
			const v = await grant_actor(app, owner, id, 'viewer', target.actor.id);
			assert.ok(v.ok, JSON.stringify(v));

			// Editor tries to mint a viewer grant → IDOR-mask 404.
			const mint = await grant_actor(app, editor, id, 'viewer', target.actor.id);
			assert.ok(!mint.ok);
			assert.strictEqual(mint.status, 404);
			assert.strictEqual(error_reason(mint), ERROR_CELL_NOT_FOUND);

			// Editor tries to list grants → 404.
			const list = await call(
				app,
				cell_grant_list_action_spec,
				{ cell_id: id },
				editor.create_session_headers()
			);
			assert.ok(!list.ok);
			assert.strictEqual(list.status, 404);

			// Editor tries to revoke the viewer grant → 404.
			const revoke = await call(
				app,
				cell_grant_revoke_action_spec,
				{ grant_id: v.result.grant.id },
				editor.create_session_headers()
			);
			assert.ok(!revoke.ok);
			assert.strictEqual(revoke.status, 404);
		});

		test('owner can create (viewer + editor), list, and revoke', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'o_owner' });
			const v_target = await app.create_account({ username: 'o_viewer' });
			const e_target = await app.create_account({ username: 'o_editor' });
			const { id } = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers()
			});

			const v = await grant_actor(app, owner, id, 'viewer', v_target.actor.id);
			assert.ok(v.ok, JSON.stringify(v));
			const e = await grant_actor(app, owner, id, 'editor', e_target.actor.id);
			assert.ok(e.ok, JSON.stringify(e));
			assert.strictEqual(e.result.grant.level, 'editor');

			const list = await call(
				app,
				cell_grant_list_action_spec,
				{ cell_id: id },
				owner.create_session_headers()
			);
			assert.ok(list.ok, JSON.stringify(list));
			assert.strictEqual(list.result.grants.length, 2);

			const revoke = await call(
				app,
				cell_grant_revoke_action_spec,
				{ grant_id: e.result.grant.id },
				owner.create_session_headers()
			);
			assert.ok(revoke.ok, JSON.stringify(revoke));
		});

		test('admin can manage grants on another actor’s cell', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'a_owner' });
			const admin = await app.create_account({ username: 'a_admin', roles: [ROLE_ADMIN] });
			const target = await app.create_account({ username: 'a_target' });
			const { id } = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers()
			});

			const g = await grant_actor(app, admin, id, 'viewer', target.actor.id);
			assert.ok(g.ok, JSON.stringify(g));
			const list = await call(
				app,
				cell_grant_list_action_spec,
				{ cell_id: id },
				admin.create_session_headers()
			);
			assert.ok(list.ok, JSON.stringify(list));
			assert.strictEqual(list.result.grants.length, 1);
		});
	});

	describe('self-revoke', () => {
		test('grantee can revoke their own actor grant and loses access', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 's_owner' });
			const viewer = await app.create_account({ username: 's_viewer' });
			const { id } = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers()
			});
			const v = await grant_actor(app, owner, id, 'viewer', viewer.actor.id);
			assert.ok(v.ok, JSON.stringify(v));

			// Viewer can see the cell before revoking.
			const before = await call(app, cell_get_action_spec, { id }, viewer.create_session_headers());
			assert.ok(before.ok, JSON.stringify(before));

			const self_revoke = await call(
				app,
				cell_grant_revoke_action_spec,
				{ grant_id: v.result.grant.id },
				viewer.create_session_headers()
			);
			assert.ok(self_revoke.ok, JSON.stringify(self_revoke));
			assert.strictEqual(self_revoke.result.still_admitted, false);

			// And loses access afterward.
			const after = await call(app, cell_get_action_spec, { id }, viewer.create_session_headers());
			assert.ok(!after.ok);
			assert.strictEqual(after.status, 404);
		});
	});

	describe('principal validity', () => {
		test('owner-as-principal is rejected', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'p_owner' });
			const { id } = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers()
			});
			const res = await grant_actor(app, owner, id, 'viewer', owner.actor.id);
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(error_reason(res), ERROR_CELL_GRANT_PRINCIPAL_IS_OWNER);
		});

		test('unknown role is rejected', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'u_owner' });
			const { id } = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers()
			});
			const res = await call(
				app,
				cell_grant_create_action_spec,
				{ cell_id: id, level: 'viewer', principal: { kind: 'role', role: 'no_such_role' } },
				owner.create_session_headers()
			);
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(error_reason(res), ERROR_CELL_GRANT_UNKNOWN_ROLE);
		});
	});

	describe('role-shaped grant', () => {
		test('a role grant admits a holder of that role', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'role_owner' });
			const member = await app.create_account({ username: 'role_member', roles: [ROLE_MEMBER] });
			const { id } = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers()
			});

			const g = await call(
				app,
				cell_grant_create_action_spec,
				{ cell_id: id, level: 'viewer', principal: { kind: 'role', role: ROLE_MEMBER } },
				owner.create_session_headers()
			);
			assert.ok(g.ok, JSON.stringify(g));

			const got = await call(app, cell_get_action_spec, { id }, member.create_session_headers());
			assert.ok(got.ok, JSON.stringify(got));
			assert.strictEqual(got.result.cell.id, id);
		});
	});
});
