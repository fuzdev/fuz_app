/**
 * `cell_moderate` transitions carry their from-state.
 *
 * Approval moves only a pending contribution, so a root owner a private
 * contribution was shared with can't publish it by "approving" it when it was
 * never pending; rejection moves a pending or approved one (the takedown,
 * visibility untouched). Any other transition — approving an approved,
 * rejected, or unmarked contribution, rejecting a rejected or unmarked one —
 * answers 400 `cell_not_pending` and leaves the cell as it was.
 * No create authorizer is mounted in-process, so contributions are born
 * unmoderated and each case writes its marker directly. Twin of the Rust
 * `cell_moderate_transitions_carry_their_from_state` (`fuz_cell_actions`).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	cell_create_action_spec,
	cell_get_action_spec,
	cell_moderate_action_spec,
	ERROR_CELL_NOT_PENDING,
	type CellModerationDecision
} from '#lib/auth/cell_action_specs.ts';
import { cell_grant_create_action_spec } from '#lib/auth/cell_grant_action_specs.ts';
import { query_cell_set_moderation } from '#lib/db/cell_queries.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import type { TestApp, TestAccount } from '#lib/testing/app_server.ts';
import { create_cell_test_app, create_cell, call } from './cell_test_helpers.ts';
import { error_reason } from './rpc_test_helpers.ts';
import { describe_db } from '../cell_db_fixture.ts';

describe_db('cell_moderate from-state', (get_db) => {
	const setup = async () => {
		const app = await create_cell_test_app(get_db);
		const root_owner = await app.create_account({ username: 'mod_root_owner' });
		const author = await app.create_account({ username: 'mod_author' });
		const root = await create_cell(app, {
			kind: 'forum',
			data: {},
			visibility: 'public',
			headers: root_owner.create_session_headers()
		});
		return { app, root_owner, author, root };
	};

	/** A contribution under `root` by `author`, with its marker written directly. */
	const contribution = async (
		app: TestApp,
		author: TestAccount,
		root: Uuid,
		visibility: 'public' | 'private',
		moderation: string | null
	): Promise<Uuid> => {
		const res = await call(
			app,
			cell_create_action_spec,
			{ kind: 'post', data: {}, parent_id: root, visibility },
			author.create_session_headers()
		);
		assert.ok(res.ok, JSON.stringify(res));
		await get_db().query('UPDATE cell SET moderation = $2 WHERE id = $1', [
			res.result.cell.id,
			moderation
		]);
		return res.result.cell.id;
	};

	const moderate = (
		app: TestApp,
		who: TestAccount,
		cell_id: Uuid,
		moderation: CellModerationDecision
	) => call(app, cell_moderate_action_spec, { cell_id, moderation }, who.create_session_headers());

	const read = async (app: TestApp, who: TestAccount, id: Uuid) => {
		const res = await call(app, cell_get_action_spec, { id }, who.create_session_headers());
		assert.ok(res.ok, JSON.stringify(res));
		return res.result.cell;
	};

	const assert_not_pending = (res: Awaited<ReturnType<typeof moderate>>, label: string) => {
		assert.ok(!res.ok, `${label}: moderated`);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params, label);
		assert.strictEqual(error_reason(res), ERROR_CELL_NOT_PENDING, label);
	};

	describe('refuses a transition the from-state does not allow', () => {
		test('a private approved contribution shared with the root owner is not published', async () => {
			const { app, root_owner, author, root } = await setup();
			const shared = await contribution(app, author, root.id, 'private', 'approved');
			const granted = await call(
				app,
				cell_grant_create_action_spec,
				{
					cell_id: shared,
					level: 'viewer',
					principal: { kind: 'actor', actor_id: root_owner.actor.id }
				},
				author.create_session_headers()
			);
			assert.ok(granted.ok, JSON.stringify(granted));

			assert_not_pending(await moderate(app, root_owner, shared, 'approved'), 'approve');
			const after = await read(app, author, shared);
			assert.strictEqual(after.visibility, 'private', 'the refusal publishes nothing');
			assert.strictEqual(after.moderation, 'approved');
		});

		test('an unmarked contribution, either way', async () => {
			const { app, root_owner, author, root } = await setup();
			const unmarked = await contribution(app, author, root.id, 'public', null);
			for (const decision of ['approved', 'rejected'] as const) {
				assert_not_pending(await moderate(app, root_owner, unmarked, decision), decision);
			}
			const after = await read(app, author, unmarked);
			assert.strictEqual(after.moderation, null);
			assert.strictEqual(after.visibility, 'public');
		});

		test('an approved contribution is not approved again, but is taken down', async () => {
			const { app, root_owner, author, root } = await setup();
			const pending = await contribution(app, author, root.id, 'private', 'pending');
			const approved = await moderate(app, root_owner, pending, 'approved');
			assert.ok(approved.ok, JSON.stringify(approved));
			assert_not_pending(await moderate(app, root_owner, pending, 'approved'), 'approve twice');
			const taken_down = await moderate(app, root_owner, pending, 'rejected');
			assert.ok(taken_down.ok, JSON.stringify(taken_down));
			assert.strictEqual(taken_down.result.cell.moderation, 'rejected');
			assert.strictEqual(taken_down.result.cell.visibility, 'public', 'visibility untouched');
		});

		test('a rejected contribution is final, either way', async () => {
			const { app, root_owner, author, root } = await setup();
			const pending = await contribution(app, author, root.id, 'private', 'pending');
			const rejected = await moderate(app, root_owner, pending, 'rejected');
			assert.ok(rejected.ok, JSON.stringify(rejected));
			for (const decision of ['approved', 'rejected'] as const) {
				assert_not_pending(await moderate(app, root_owner, pending, decision), decision);
			}
			const after = await read(app, author, pending);
			assert.strictEqual(after.moderation, 'rejected');
			assert.strictEqual(after.visibility, 'private');
		});
	});

	test('query_cell_set_moderation moves only an allowed from-state', async () => {
		const { app, author, root } = await setup();
		const db = get_db();
		for (const marker of ['approved', 'rejected', null]) {
			const id = await contribution(app, author, root.id, 'private', marker);
			const row = await query_cell_set_moderation({ db }, id, 'approved', {
				set_visibility_public: true
			});
			assert.strictEqual(row, null, String(marker));
			const after = await read(app, author, id);
			assert.strictEqual(after.visibility, 'private', String(marker));
			assert.strictEqual(after.moderation, marker, String(marker));
		}
		for (const marker of ['rejected', null]) {
			const id = await contribution(app, author, root.id, 'private', marker);
			const row = await query_cell_set_moderation({ db }, id, 'rejected', {
				set_visibility_public: false
			});
			assert.strictEqual(row, null, `reject ${String(marker)}`);
			assert.strictEqual((await read(app, author, id)).moderation, marker);
		}
		const pending = await contribution(app, author, root.id, 'private', 'pending');
		const row = await query_cell_set_moderation({ db }, pending, 'approved', {
			set_visibility_public: true
		});
		assert.ok(row);
		assert.strictEqual(row.moderation, 'approved');
		assert.strictEqual(row.visibility, 'public');
		const taken_down = await query_cell_set_moderation({ db }, pending, 'rejected', {
			set_visibility_public: false
		});
		assert.ok(taken_down);
		assert.strictEqual(taken_down.moderation, 'rejected');
		assert.strictEqual(taken_down.visibility, 'public');
	});
});
