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

import {describe, test, assert} from 'vitest';

import {
	cell_create_action_spec,
	cell_update_action_spec,
	cell_get_action_spec,
	cell_list_action_spec,
	ERROR_CELL_NOT_FOUND,
	ERROR_CELL_KIND_IN_DATA,
	ERROR_CELL_KIND_EMPTY,
	ERROR_CELL_PATH_ADMIN_ONLY,
	type CellPath,
	type CellUpdateInput,
} from '$lib/auth/cell_action_specs.ts';
import type {CellCreateAuthorize} from '$lib/auth/cell_actions.ts';
import {install_audit_drift_guard} from '$lib/testing/audit_drift_guard.ts';
import {
	describe_db,
	create_cell_test_app,
	create_cell,
	call,
	error_reason,
} from './cell_test_helpers.ts';

// Authorizer doubles — pure functions of the input (no role logic; role- and
// admin-bypass gating is the cross suite's `test_cell_gated_create_authorize`).
const deny_all: CellCreateAuthorize = () => false;
const allow_all: CellCreateAuthorize = () => true;
const deny_gated: CellCreateAuthorize = (_auth, input) => input.kind !== 'gated';

describe_db('cell create authorizer + kind invariants', (get_db) => {
	install_audit_drift_guard();

	describe('authorize_create gate', () => {
		test('deny-all → cell_create is the cell_not_found 404 IDOR mask', async () => {
			const app = await create_cell_test_app(get_db, [], deny_all);
			const actor = await app.create_account({username: 'authz_deny'});
			const res = await call(
				app,
				cell_create_action_spec,
				{kind: 'note', data: {}},
				actor.create_session_headers(),
			);
			assert.ok(!res.ok, 'deny-all must block create');
			assert.strictEqual(error_reason(res), ERROR_CELL_NOT_FOUND);
		});

		test('allow-all → create succeeds and stamps the kind column', async () => {
			const app = await create_cell_test_app(get_db, [], allow_all);
			const actor = await app.create_account({username: 'authz_allow'});
			const res = await call(
				app,
				cell_create_action_spec,
				{kind: 'note', data: {label: 'x'}},
				actor.create_session_headers(),
			);
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.cell.kind, 'note');
		});

		test('gate-by-kind → gated denied, ungated open, typeless open', async () => {
			const app = await create_cell_test_app(get_db, [], deny_gated);
			const actor = await app.create_account({username: 'authz_gate'});
			const h = actor.create_session_headers();
			const gated = await call(app, cell_create_action_spec, {kind: 'gated', data: {}}, h);
			assert.ok(!gated.ok, 'the gated kind is denied');
			assert.strictEqual(error_reason(gated), ERROR_CELL_NOT_FOUND);
			const ungated = await call(app, cell_create_action_spec, {kind: 'note', data: {}}, h);
			assert.ok(ungated.ok, JSON.stringify(ungated));
			const typeless = await call(app, cell_create_action_spec, {data: {}}, h);
			assert.ok(typeless.ok, 'a typeless cell (kind=null) is not the gated kind');
			assert.strictEqual(typeless.result.cell.kind, null);
		});

		test('no authorizer mounted → create is open for any kind', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({username: 'authz_open'});
			const res = await call(
				app,
				cell_create_action_spec,
				{kind: 'gated', data: {}},
				actor.create_session_headers(),
			);
			assert.ok(res.ok, 'no authorizer → open create');
		});

		test('an async authorizer is awaited', async () => {
			const async_deny: CellCreateAuthorize = () => Promise.resolve(false);
			const app = await create_cell_test_app(get_db, [], async_deny);
			const actor = await app.create_account({username: 'authz_async'});
			const res = await call(
				app,
				cell_create_action_spec,
				{kind: 'note', data: {}},
				actor.create_session_headers(),
			);
			assert.ok(!res.ok, 'an async deny is awaited and blocks');
			assert.strictEqual(error_reason(res), ERROR_CELL_NOT_FOUND);
		});
	});

	describe('authz runs before the input-shape checks', () => {
		test('a non-editor update with kind-in-data gets the 404 IDOR mask, not the kind error', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({username: 'order_owner'});
			const stranger = await app.create_account({username: 'order_stranger'});
			const {id} = await create_cell(app, {
				kind: 'note',
				data: {label: 'a'},
				headers: owner.create_session_headers(),
			});
			// `can_edit` (404 IDOR mask) must fire before `reject_kind_in_data`,
			// so a caller who can't edit can't tell a malformed payload from a
			// missing cell. (The cross suite pins the same shape on the Rust spine.)
			const res = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {kind: 'post'}},
				stranger.create_session_headers(),
			);
			assert.ok(!res.ok, 'a non-editor must not reach the kind check');
			assert.strictEqual(error_reason(res), ERROR_CELL_NOT_FOUND);
		});

		test('a non-admin create with a path + kind-in-data gets path_admin_only, not the kind error', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({username: 'order_path'});
			// The path-admin gate (403) fires before `reject_kind_in_data`.
			const res = await call(
				app,
				cell_create_action_spec,
				{data: {kind: 'note'}, path: '/order/x' as CellPath},
				actor.create_session_headers(),
			);
			assert.ok(!res.ok, 'a non-admin path write must be refused first');
			assert.strictEqual(error_reason(res), ERROR_CELL_PATH_ADMIN_ONLY);
		});
	});

	describe('kind is a top-level column, fixed at birth', () => {
		test('a kind key inside data is rejected fail-loud on create', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({username: 'kind_in_data'});
			const res = await call(
				app,
				cell_create_action_spec,
				{data: {kind: 'note'}},
				actor.create_session_headers(),
			);
			assert.ok(!res.ok, 'kind belongs at the top level, not inside data');
			assert.strictEqual(error_reason(res), ERROR_CELL_KIND_IN_DATA);
		});

		test('a kind key inside data is rejected on update too', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({username: 'kind_in_data_update'});
			const h = actor.create_session_headers();
			const {id} = await create_cell(app, {kind: 'note', data: {label: 'a'}, headers: h});
			const res = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {kind: 'post', label: 'b'}},
				h,
			);
			assert.ok(!res.ok, 'update may not smuggle a kind change through data');
			assert.strictEqual(error_reason(res), ERROR_CELL_KIND_IN_DATA);
		});

		test('a top-level kind on cell_update is rejected by the wire schema', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({username: 'kind_top_level_update'});
			const h = actor.create_session_headers();
			const {id} = await create_cell(app, {kind: 'note', data: {label: 'a'}, headers: h});
			// `kind` is not a field on `CellUpdateInput` (z.strictObject), so a
			// top-level `kind` has no wire path in — kind is structurally immutable.
			const res = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, kind: 'post'} as unknown as CellUpdateInput,
				h,
			);
			assert.ok(!res.ok, 'a top-level kind on update must be rejected');
			// The rejected update never touched the column.
			const got = await call(app, cell_get_action_spec, {id}, h);
			assert.ok(got.ok);
			assert.strictEqual(got.result.cell.kind, 'note');
		});

		test('kind survives a data update (write-once column)', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({username: 'kind_persist'});
			const h = actor.create_session_headers();
			const {id} = await create_cell(app, {kind: 'note', data: {label: 'a'}, headers: h});
			const updated = await call(
				app,
				cell_update_action_spec,
				{cell_id: id, data: {label: 'b'}},
				h,
			);
			assert.ok(updated.ok, JSON.stringify(updated));
			assert.strictEqual(updated.result.cell.kind, 'note', 'kind unchanged by a data-only update');
			const got = await call(app, cell_get_action_spec, {id}, h);
			assert.ok(got.ok);
			assert.strictEqual(got.result.cell.kind, 'note');
		});
	});

	describe('empty kind is not a valid tag', () => {
		test('an empty-string kind is rejected on create (fail-loud)', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({username: 'kind_empty'});
			const res = await call(
				app,
				cell_create_action_spec,
				{kind: '', data: {}},
				actor.create_session_headers(),
			);
			assert.ok(!res.ok, 'an empty kind is a tag that tags nothing');
			assert.strictEqual(error_reason(res), ERROR_CELL_KIND_EMPTY);
		});

		test('an empty-kind list filter matches nothing (not an error)', async () => {
			const app = await create_cell_test_app(get_db);
			const actor = await app.create_account({username: 'kind_empty_list'});
			const h = actor.create_session_headers();
			await create_cell(app, {kind: 'note', data: {}, headers: h});
			await create_cell(app, {data: {}, headers: h}); // typeless (kind = null)
			// The filter accepts '' (no min-length) and matches nothing, so TS and
			// Rust agree — Rust never imposed the min-length the TS filter used to.
			const res = await call(app, cell_list_action_spec, {kind: ''}, h);
			assert.ok(res.ok, JSON.stringify(res));
			assert.strictEqual(res.result.cells.length, 0, 'empty kind matches no cells');
		});
	});
});
