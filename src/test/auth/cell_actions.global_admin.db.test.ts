/**
 * The cell verbs' admin authority is the **global** `admin` grant, and
 * `cell_clone` is no side door past the creation policy.
 *
 * - A scoped `admin` row (legacy data — no grant path mints one) gets no admin
 *   bypass: a private cell it doesn't own stays 404-masked on `cell_get`, out
 *   of its `cell_list`, and `path` writes stay `cell_path_admin_only`; the
 *   global admin is the positive control.
 * - `cell_clone` runs the mounted creation authorizer for every cell it
 *   writes, each as a parentless create: a caller denied a root `cell_create`
 *   of a kind can't clone a viewable cell of that kind, and a deep clone that
 *   hits a denied child writes nothing.
 *
 * Twin of the Rust `fuz_cell_actions` `cell_authz` suite; the policy is the
 * directory-model `test_cell_gated_create_authorize` both reference spines
 * mount (a `space` root is global-admin-only).
 *
 * @module
 */

import { test, assert } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';

import {
	cell_clone_action_spec,
	cell_create_action_spec,
	cell_get_action_spec,
	cell_list_action_spec,
	ERROR_CELL_CREATE_FORBIDDEN,
	ERROR_CELL_NOT_FOUND,
	ERROR_CELL_PATH_ADMIN_ONLY,
	type CellPath
} from '$lib/auth/cell_action_specs.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '$lib/auth/role_schema.ts';
import {
	SPACE_CELL_KIND,
	test_cell_gated_create_authorize
} from '$lib/testing/cross_backend/test_cell_gated_create_authorize.ts';
import { install_audit_drift_guard } from '$lib/testing/audit_drift_guard.ts';
import { create_test_role_grant_direct } from '$lib/testing/db_entities.ts';
import type { Db } from '$lib/db/db.ts';
import {
	create_cell,
	create_cell_admin_test_app,
	create_cell_test_app,
	call
} from './cell_test_helpers.ts';
import { error_reason } from './rpc_test_helpers.ts';
import { describe_db } from '../cell_db_fixture.ts';

const count_cells = async (db: Db): Promise<number> => {
	const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM cell`);
	return rows[0]!.n;
};

describe_db('cell actions global-admin authority', (get_db) => {
	install_audit_drift_guard();

	test('the cell admin bypass requires a global admin', async () => {
		const app = await create_cell_admin_test_app(get_db);
		const owner = await app.create_account({ username: 'bypass_owner' });
		const { id } = await create_cell(app, {
			kind: 'note',
			data: {},
			visibility: 'private',
			headers: owner.create_session_headers()
		});
		const scoped = await app.create_account({ username: 'bypass_scoped_admin' });
		await create_test_role_grant_direct(get_db(), {
			actor_id: scoped.actor.id,
			role: ROLE_ADMIN,
			scope_kind: 'space',
			scope_id: id,
			granted_by: null
		});
		const scoped_headers = scoped.create_session_headers();

		// cell_get: 404-masked for the scoped admin, served to the global one.
		const scoped_get = await call(app, cell_get_action_spec, { id }, scoped_headers);
		assert.strictEqual(error_reason(scoped_get), ERROR_CELL_NOT_FOUND);
		const global_get = await call(app, cell_get_action_spec, { id }, app.create_session_headers());
		assert.ok(global_get.ok, JSON.stringify(global_get));

		// cell_list: the admin visibility branch is global-only.
		const scoped_list = await call(app, cell_list_action_spec, {}, scoped_headers);
		assert.ok(scoped_list.ok);
		assert.isFalse(scoped_list.result.cells.some((c) => c.id === id));
		const global_list = await call(app, cell_list_action_spec, {}, app.create_session_headers());
		assert.ok(global_list.ok);
		assert.isTrue(global_list.result.cells.some((c) => c.id === id));

		// `path` writes are global-admin-only.
		const scoped_path = await call(
			app,
			cell_create_action_spec,
			{ kind: 'note', data: {}, path: '/scoped' as CellPath },
			scoped_headers
		);
		assert.strictEqual(error_reason(scoped_path), ERROR_CELL_PATH_ADMIN_ONLY);
		const global_path = await call(
			app,
			cell_create_action_spec,
			{ kind: 'note', data: {}, path: '/global' as CellPath },
			app.create_session_headers()
		);
		assert.ok(global_path.ok, JSON.stringify(global_path));
	});

	test('cell_clone runs the create authorizer for every cell it writes', async () => {
		const app = await create_cell_test_app(
			get_db,
			[ROLE_KEEPER, ROLE_ADMIN],
			test_cell_gated_create_authorize
		);
		const member = await app.create_account({ username: 'clone_member' });
		const member_headers = member.create_session_headers();

		// An admin-created public space, and a public note holding it as a child.
		const space = await create_cell(app, {
			kind: SPACE_CELL_KIND,
			data: {},
			visibility: 'public'
		});
		const note = await create_cell(app, {
			kind: 'note',
			data: {},
			visibility: 'public',
			items: [space.id]
		});
		const before = await count_cells(get_db());

		// The member may not create a `space` root, so it may not clone one.
		const denied = await call(app, cell_clone_action_spec, { source_id: space.id }, member_headers);
		assert.ok(!denied.ok);
		assert.strictEqual(denied.status, 403);
		assert.strictEqual(error_reason(denied), ERROR_CELL_CREATE_FORBIDDEN);

		// A deep clone gates every cell it writes: the `space` child is refused
		// and the transaction takes the already-written root with it.
		const deep = await call(
			app,
			cell_clone_action_spec,
			{ source_id: note.id, deep: true },
			member_headers
		);
		assert.strictEqual(deep.status, 403);
		assert.strictEqual(error_reason(deep), ERROR_CELL_CREATE_FORBIDDEN);
		assert.strictEqual(await count_cells(get_db()), before, 'nothing was written');

		// What the policy admits still clones: a shallow note clone (the child is
		// an edge, not a new cell), and the admin's space clone.
		const shallow = await call(app, cell_clone_action_spec, { source_id: note.id }, member_headers);
		assert.ok(shallow.ok, JSON.stringify(shallow));
		assert.notStrictEqual(shallow.result.cell.id, note.id);
		const admin_clone = await call(
			app,
			cell_clone_action_spec,
			{ source_id: space.id },
			app.create_session_headers()
		);
		assert.ok(admin_clone.ok, JSON.stringify(admin_clone));
	});

	test('a scoped admin gets no clone bypass of the creation policy', async () => {
		const app = await create_cell_test_app(
			get_db,
			[ROLE_KEEPER, ROLE_ADMIN],
			test_cell_gated_create_authorize
		);
		const space = await create_cell(app, { kind: SPACE_CELL_KIND, data: {}, visibility: 'public' });
		const scoped = await app.create_account({ username: 'clone_scoped_admin' });
		await create_test_role_grant_direct(get_db(), {
			actor_id: scoped.actor.id,
			role: ROLE_ADMIN,
			scope_kind: 'space',
			scope_id: create_uuid(),
			granted_by: null
		});
		const res = await call(
			app,
			cell_clone_action_spec,
			{ source_id: space.id },
			scoped.create_session_headers()
		);
		assert.strictEqual(error_reason(res), ERROR_CELL_CREATE_FORBIDDEN);
	});
});
