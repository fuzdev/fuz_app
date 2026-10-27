/**
 * In-process coverage of a root's contribution `policy` — the manage-tier
 * column the create authorizer reads.
 *
 * - **A policy write needs an authorizer that accepts it.** A non-null policy
 *   at a root's `cell_create` or through `cell_policy_set` is
 *   `cell_policy_unsupported` with no `authorize_create` mounted or one
 *   without `validate_policy`, and the validator's own refusal otherwise;
 *   clearing needs no authorizer.
 * - **The policy is the manager's.** `cell_policy_set` 404-masks a caller who
 *   can't view the cell, answers an editor-grant holder `403
 *   cell_policy_manage_only`, and refuses a contribution
 *   `cell_policy_root_only` (as `cell_create` refuses a policy beside a
 *   `parent_id`).
 * - **The authorizer reads the column.** An editor rewriting the root's
 *   `data.policy` leaves the column and moderation as they were; each set is
 *   audited with the new and the previous policy; a clone is born without one.
 *
 * The cross-backend `cell_gated_create` suite runs the same rules on both
 * spines with the shared test authorizer mounted; the no-authorizer refusal
 * runs only here and in the Rust `cell_authz` suite.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	cell_clone_action_spec,
	cell_create_action_spec,
	cell_get_action_spec,
	cell_policy_set_action_spec,
	cell_update_action_spec,
	ERROR_CELL_NOT_FOUND,
	ERROR_CELL_POLICY_INVALID,
	ERROR_CELL_POLICY_MANAGE_ONLY,
	ERROR_CELL_POLICY_ROOT_ONLY,
	ERROR_CELL_POLICY_UNSUPPORTED,
	type CellPolicy
} from '#lib/auth/cell_action_specs.ts';
import type { CellCreateAuthorize } from '#lib/auth/cell_actions.ts';
import { cell_grant_create_action_spec } from '#lib/auth/cell_grant_action_specs.ts';
import { jsonrpc_errors } from '#lib/http/jsonrpc_errors.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { create_cell_test_app, create_cell, call } from './cell_test_helpers.ts';
import { error_reason } from './rpc_test_helpers.ts';
import { describe_db } from '../cell_db_fixture.ts';

/**
 * Reads the root's `policy` column: a contribution is admitted when
 * `root_policy[kind]` exists, born pending when its `moderation_required` is
 * true. Accepts a policy whose entries are all objects.
 */
const reads_root_policy: CellCreateAuthorize = {
	authorize: (_auth, input) => {
		if (input.root_id === null) return { allow: true, moderation_required: false };
		const rule = input.root_policy?.[input.kind ?? ''];
		if (rule === null || typeof rule !== 'object') return { allow: false };
		return {
			allow: true,
			moderation_required: (rule as { moderation_required?: boolean }).moderation_required === true
		};
	},
	validate_policy: (policy) => {
		if (!Object.values(policy).every((v) => v !== null && typeof v === 'object')) {
			throw jsonrpc_errors.invalid_params('invalid policy', { reason: ERROR_CELL_POLICY_INVALID });
		}
	}
};

/** An authorizer that reads no policy, so keeps no `validate_policy`. */
const no_policy_reader: CellCreateAuthorize = {
	authorize: () => ({ allow: true, moderation_required: false })
};

const MODERATED: CellPolicy = { post: { moderation_required: true } };
const OPEN: CellPolicy = { post: { moderation_required: false } };

describe_db('cell root policy', (get_db) => {
	install_audit_drift_guard();

	describe('a policy write needs an authorizer that accepts it', () => {
		for (const [label, authorize_create] of [
			['no authorizer', undefined],
			['no validate_policy', no_policy_reader]
		] as const) {
			test(`${label} → cell_policy_unsupported, and clearing still works`, async () => {
				const app = await create_cell_test_app(get_db, [], { authorize_create });
				const owner = await app.create_account({ username: 'p_owner' });
				const h = owner.create_session_headers();
				const created = await call(
					app,
					cell_create_action_spec,
					{ kind: 'forum', data: {}, policy: MODERATED },
					h
				);
				assert.ok(!created.ok);
				assert.strictEqual(error_reason(created), ERROR_CELL_POLICY_UNSUPPORTED);
				const { id } = await create_cell(app, { kind: 'forum', data: {}, headers: h });
				const set = await call(app, cell_policy_set_action_spec, { cell_id: id, policy: OPEN }, h);
				assert.ok(!set.ok);
				assert.strictEqual(error_reason(set), ERROR_CELL_POLICY_UNSUPPORTED);
				const cleared = await call(
					app,
					cell_policy_set_action_spec,
					{ cell_id: id, policy: null },
					h
				);
				assert.ok(cleared.ok, JSON.stringify(cleared));
				assert.strictEqual(cleared.result.cell.policy, null);
				const null_create = await call(
					app,
					cell_create_action_spec,
					{ kind: 'forum', data: {}, policy: null },
					h
				);
				assert.ok(null_create.ok, 'an explicit null is no policy');
			});
		}

		test("the validator's refusal answers, and an accepted policy is stored", async () => {
			const app = await create_cell_test_app(get_db, [], { authorize_create: reads_root_policy });
			const owner = await app.create_account({ username: 'p_validated' });
			const h = owner.create_session_headers();
			const refused = await call(
				app,
				cell_create_action_spec,
				{ kind: 'forum', data: {}, policy: { post: true } },
				h
			);
			assert.ok(!refused.ok);
			assert.strictEqual(error_reason(refused), ERROR_CELL_POLICY_INVALID);
			const created = await call(
				app,
				cell_create_action_spec,
				{ kind: 'forum', data: {}, policy: MODERATED },
				h
			);
			assert.ok(created.ok, JSON.stringify(created));
			assert.deepStrictEqual(created.result.cell.policy, MODERATED);
		});
	});

	describe('the policy is the manager’s', () => {
		test('manage-tier, root-only, and read from the column', async () => {
			const app = await create_cell_test_app(get_db, [], { authorize_create: reads_root_policy });
			const owner = await app.create_account({ username: 'p_mgr_owner' });
			const editor = await app.create_account({ username: 'p_mgr_editor' });
			const stranger = await app.create_account({ username: 'p_mgr_stranger' });
			const author = await app.create_account({ username: 'p_mgr_author' });
			const owner_h = owner.create_session_headers();
			const editor_h = editor.create_session_headers();
			const created = await call(
				app,
				cell_create_action_spec,
				{ kind: 'forum', data: {}, visibility: 'public', policy: MODERATED },
				owner_h
			);
			assert.ok(created.ok, JSON.stringify(created));
			const root_id = created.result.cell.id;
			const granted = await call(
				app,
				cell_grant_create_action_spec,
				{
					cell_id: root_id,
					level: 'editor',
					principal: { kind: 'actor', actor_id: editor.actor.id }
				},
				owner_h
			);
			assert.ok(granted.ok, JSON.stringify(granted));

			const refused = await call(
				app,
				cell_policy_set_action_spec,
				{ cell_id: root_id, policy: OPEN },
				editor_h
			);
			assert.ok(!refused.ok);
			assert.strictEqual(error_reason(refused), ERROR_CELL_POLICY_MANAGE_ONLY);
			const edited = await call(
				app,
				cell_update_action_spec,
				{ cell_id: root_id, data: { policy: OPEN } },
				editor_h
			);
			assert.ok(edited.ok, JSON.stringify(edited));
			assert.deepStrictEqual(
				edited.result.cell.policy,
				MODERATED,
				'a data write leaves the policy'
			);
			const post = await call(
				app,
				cell_create_action_spec,
				{ kind: 'post', data: {}, parent_id: root_id },
				author.create_session_headers()
			);
			assert.ok(post.ok, JSON.stringify(post));
			assert.strictEqual(
				post.result.cell.moderation,
				'pending',
				'the authorizer reads the column, not `data.policy`'
			);

			const hidden = await create_cell(app, { kind: 'forum', data: {}, headers: owner_h });
			const masked = await call(
				app,
				cell_policy_set_action_spec,
				{ cell_id: hidden.id, policy: OPEN },
				stranger.create_session_headers()
			);
			assert.strictEqual(error_reason(masked), ERROR_CELL_NOT_FOUND);

			const on_contribution = await call(
				app,
				cell_policy_set_action_spec,
				{ cell_id: post.result.cell.id, policy: OPEN },
				author.create_session_headers()
			);
			assert.strictEqual(error_reason(on_contribution), ERROR_CELL_POLICY_ROOT_ONLY);
			const beside_parent = await call(
				app,
				cell_create_action_spec,
				{ kind: 'post', data: {}, parent_id: root_id, policy: OPEN },
				author.create_session_headers()
			);
			assert.strictEqual(error_reason(beside_parent), ERROR_CELL_POLICY_ROOT_ONLY);

			// The owner sets it, then clears it; both audited old and new.
			const set = await call(
				app,
				cell_policy_set_action_spec,
				{ cell_id: root_id, policy: OPEN },
				owner_h
			);
			assert.ok(set.ok, JSON.stringify(set));
			assert.deepStrictEqual(set.result.cell.policy, OPEN);
			const live = await call(
				app,
				cell_create_action_spec,
				{ kind: 'post', data: {}, parent_id: root_id },
				author.create_session_headers()
			);
			assert.ok(live.ok, JSON.stringify(live));
			assert.strictEqual(live.result.cell.moderation, 'approved', 'the new policy governs');
			const cleared = await call(
				app,
				cell_policy_set_action_spec,
				{ cell_id: root_id, policy: null },
				owner_h
			);
			assert.ok(cleared.ok, JSON.stringify(cleared));
			const rows = await get_db().query<{ metadata: unknown }>(
				`SELECT metadata FROM audit_log WHERE event_type = 'cell_policy_set' ORDER BY seq`
			);
			assert.deepStrictEqual(
				rows.map((r) => r.metadata),
				[
					{ cell_id: root_id, policy: OPEN, previous_policy: MODERATED },
					{ cell_id: root_id, policy: null, previous_policy: OPEN }
				]
			);

			// Readable by a viewer; a clone is born without it.
			await call(
				app,
				cell_policy_set_action_spec,
				{ cell_id: root_id, policy: MODERATED },
				owner_h
			);
			const read = await call(
				app,
				cell_get_action_spec,
				{ id: root_id },
				stranger.create_session_headers()
			);
			assert.ok(read.ok, JSON.stringify(read));
			assert.deepStrictEqual(read.result.cell.policy, MODERATED);
			const clone = await call(
				app,
				cell_clone_action_spec,
				{ source_id: root_id },
				stranger.create_session_headers()
			);
			assert.ok(clone.ok, JSON.stringify(clone));
			assert.strictEqual(clone.result.cell.policy, null, 'a clone has no policy');
		});
	});
});
