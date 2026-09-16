/**
 * Cell audit coverage — the second-pass gap left by the focused checklist.
 *
 * - emission: each mutation verb writes its registered audit event with the
 *   expected envelope shape.
 * - completeness: the set of event types actually emitted equals the
 *   `cell_audit_events` registry keys (no unknown-event drift, no dead
 *   registry entries).
 * - idempotent no-op deletes (`cell_field_delete` / `cell_item_delete` with
 *   no matching row) emit nothing.
 * - `cell_audit_list` REGRESSION: manage-tier gate (admin / owner only) —
 *   viewers, editors, and any authed caller on a public cell get the
 *   IDOR-mask 404; the wire shape carries no `ip`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	cell_create_action_spec,
	cell_update_action_spec,
	cell_delete_action_spec,
	cell_clone_action_spec,
	cell_moderate_action_spec,
	ERROR_CELL_NOT_FOUND
} from '$lib/auth/cell_action_specs.ts';
import {
	cell_grant_create_action_spec,
	cell_grant_revoke_action_spec
} from '$lib/auth/cell_grant_action_specs.ts';
import {
	cell_field_set_action_spec,
	cell_field_delete_action_spec,
	type CellFieldName
} from '$lib/auth/cell_field_action_specs.ts';
import {
	cell_item_insert_action_spec,
	cell_item_move_action_spec,
	cell_item_delete_action_spec,
	type CellItemPosition
} from '$lib/auth/cell_item_action_specs.ts';
import {
	cell_audit_list_action_spec,
	CellAuditEventJson
} from '$lib/auth/cell_audit_action_specs.ts';
import { cell_audit_events } from '$lib/auth/cell_audit_events.ts';
import { query_audit_log_list } from '$lib/auth/audit_log_queries.ts';
import { fractional_index_between } from '@fuzdev/fuz_util/fractional_index.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import {
	describe_db,
	create_cell_test_app,
	create_cell,
	call,
	error_reason
} from './cell_test_helpers.ts';

describe_db('cell audit', (get_db) => {
	describe('emission + completeness', () => {
		test('every mutation verb emits exactly its registered event type', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'au_owner' });
			const other = await app.create_account({ username: 'au_other' });
			const h = owner.create_session_headers();

			// cell_create ×3
			const { id: parent } = await create_cell(app, { kind: 'collection', data: {}, headers: h });
			const { id: child_a } = await create_cell(app, { kind: 'note', data: {}, headers: h });
			const { id: child_b } = await create_cell(app, { kind: 'note', data: {}, headers: h });

			// cell_update
			assert.ok(
				(await call(app, cell_update_action_spec, { cell_id: parent, data: { label: 'x' } }, h)).ok
			);

			// cell_grant_create + cell_grant_revoke
			const granted = await call(
				app,
				cell_grant_create_action_spec,
				{
					cell_id: parent,
					level: 'viewer',
					principal: { kind: 'actor', actor_id: other.actor.id }
				},
				h
			);
			assert.ok(granted.ok, JSON.stringify(granted));
			assert.ok(
				(await call(app, cell_grant_revoke_action_spec, { grant_id: granted.result.grant.id }, h))
					.ok
			);

			// cell_field_set + cell_field_delete
			assert.ok(
				(
					await call(
						app,
						cell_field_set_action_spec,
						{ source_id: parent, name: 'link' as CellFieldName, target_id: child_a },
						h
					)
				).ok
			);
			assert.ok(
				(
					await call(
						app,
						cell_field_delete_action_spec,
						{ source_id: parent, name: 'link' as CellFieldName },
						h
					)
				).ok
			);

			// cell_item_insert + cell_item_move + cell_item_delete
			const pos1 = fractional_index_between(null, null) as CellItemPosition;
			assert.ok(
				(
					await call(
						app,
						cell_item_insert_action_spec,
						{ parent_id: parent, child_id: child_a, position: pos1 },
						h
					)
				).ok
			);
			const pos2 = fractional_index_between(pos1, null) as CellItemPosition;
			assert.ok(
				(
					await call(
						app,
						cell_item_move_action_spec,
						{ parent_id: parent, position: pos1, new_position: pos2 },
						h
					)
				).ok
			);
			assert.ok(
				(await call(app, cell_item_delete_action_spec, { parent_id: parent, position: pos2 }, h)).ok
			);

			// cell_clone
			assert.ok((await call(app, cell_clone_action_spec, { source_id: parent }, h)).ok);

			// cell_moderate — create a contribution under `parent` (the owner owns
			// `parent`, so it manages the governing root), then moderate it. No
			// authorizer is mounted in-process, so the contribution is born
			// unmoderated; the verb still flips the marker + emits its event, which
			// is what the completeness check counts.
			const contribution = await call(
				app,
				cell_create_action_spec,
				{ kind: 'post', data: {}, parent_id: parent },
				h
			);
			assert.ok(contribution.ok, JSON.stringify(contribution));
			assert.ok(
				(
					await call(
						app,
						cell_moderate_action_spec,
						{ cell_id: contribution.result.cell.id, moderation: 'approved' },
						h
					)
				).ok
			);

			// cell_delete
			assert.ok((await call(app, cell_delete_action_spec, { cell_id: child_b }, h)).ok);

			const rows = await query_audit_log_list({ db: get_db() }, { limit: 200 });
			const emitted = new Set(rows.map((r) => r.event_type));
			const registered = new Set(Object.keys(cell_audit_events));

			// No unknown-event drift, and no dead registry entry: the emitted
			// set equals the registry exactly.
			assert.deepStrictEqual(emitted, registered);
			// This single test drives every cell mutation verb sequentially (~20
			// awaited RPCs). Over the native pglet leg each is a TCP round-trip +
			// transaction, so the default 5s is tight (the in-process pglite / wasm
			// legs make it comfortably). Give it headroom so it's not transport-flaky.
		}, 30_000);

		test('a no-op field/item delete emits no audit event', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'au_noop' });
			const h = owner.create_session_headers();
			const { id } = await create_cell(app, { kind: 'note', data: {}, headers: h });

			// Delete a field / item slot that was never set — idempotent ok,
			// `deleted: false`, and crucially no audit row.
			const fd = await call(
				app,
				cell_field_delete_action_spec,
				{ source_id: id, name: 'absent' as CellFieldName },
				h
			);
			assert.ok(fd.ok && !fd.result.deleted, JSON.stringify(fd));
			const id_pos = fractional_index_between(null, null) as CellItemPosition;
			const itd = await call(
				app,
				cell_item_delete_action_spec,
				{ parent_id: id, position: id_pos },
				h
			);
			assert.ok(itd.ok && !itd.result.deleted, JSON.stringify(itd));

			const rows = await query_audit_log_list({ db: get_db() }, { limit: 50 });
			const types = rows.map((r) => r.event_type);
			assert.ok(!types.includes('cell_field_delete'), 'no field-delete event');
			assert.ok(!types.includes('cell_item_delete'), 'no item-delete event');
		});
	});

	describe('cell_audit_list manage-tier gate (regression)', () => {
		test('owner + admin read the timeline; viewer / editor / public-stranger 404', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'al_owner' });
			const viewer = await app.create_account({ username: 'al_viewer' });
			const editor = await app.create_account({ username: 'al_editor' });
			const admin = await app.create_account({ username: 'al_admin', roles: [ROLE_ADMIN] });
			const { id } = await create_cell(app, {
				kind: 'note',
				data: {},
				headers: owner.create_session_headers()
			});

			for (const [acct, level] of [
				[viewer, 'viewer'],
				[editor, 'editor']
			] as const) {
				const g = await call(
					app,
					cell_grant_create_action_spec,
					{ cell_id: id, level, principal: { kind: 'actor', actor_id: acct.actor.id } },
					owner.create_session_headers()
				);
				assert.ok(g.ok, JSON.stringify(g));
			}

			// Owner: allowed, timeline populated (the create + the two grants).
			const as_owner = await call(
				app,
				cell_audit_list_action_spec,
				{ cell_id: id },
				owner.create_session_headers()
			);
			assert.ok(as_owner.ok, JSON.stringify(as_owner));
			assert.ok(as_owner.result.events.length > 0);
			// Wire shape carries no `ip` (PII dropped) — strict parse + key check.
			for (const ev of as_owner.result.events) {
				assert.doesNotThrow(() => CellAuditEventJson.parse(ev));
				assert.ok(!('ip' in ev), 'no ip on the wire');
			}

			// Admin: allowed.
			assert.ok(
				(
					await call(
						app,
						cell_audit_list_action_spec,
						{ cell_id: id },
						admin.create_session_headers()
					)
				).ok
			);

			// Viewer + editor: IDOR-mask 404 (manage tier only).
			for (const acct of [viewer, editor]) {
				const res = await call(
					app,
					cell_audit_list_action_spec,
					{ cell_id: id },
					acct.create_session_headers()
				);
				assert.ok(!res.ok);
				assert.strictEqual(res.status, 404);
				assert.strictEqual(error_reason(res), ERROR_CELL_NOT_FOUND);
			}
		});

		test('a public cell does not expose its timeline to a non-owner authed caller', async () => {
			const app = await create_cell_test_app(get_db);
			const owner = await app.create_account({ username: 'al_pub_owner' });
			const stranger = await app.create_account({ username: 'al_pub_stranger' });
			const { id } = await create_cell(app, {
				kind: 'note',
				data: {},
				visibility: 'public',
				headers: owner.create_session_headers()
			});
			// Stranger can VIEW the public cell, but the audit timeline is
			// manage-tier — they must not read who-touched-it.
			const res = await call(
				app,
				cell_audit_list_action_spec,
				{ cell_id: id },
				stranger.create_session_headers()
			);
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
		});
	});
});
