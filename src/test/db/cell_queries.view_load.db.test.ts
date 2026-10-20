/**
 * `query_cell_view_load_many` — the narrow `CELL_VIEW_COLUMNS` read behind
 * `filter_visible_target_ids`, the in-memory relation filter the `cell_get`
 * bundle and the clone walk run. It projects the view facts alone, drops
 * tombstones and unknown ids, and the filter over it admits exactly what
 * `can_view_cell` over the full row admits.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	CELL_VIEW_COLUMNS,
	query_cell_create,
	query_cell_delete,
	query_cell_get,
	query_cell_view_load_many
} from '#lib/db/cell_queries.ts';
import {
	query_cell_grant_create,
	query_cell_grant_list_for_cell
} from '#lib/db/cell_grant_queries.ts';
import { query_create_account_with_actor } from '#lib/auth/account_queries.ts';
import { can_view_cell } from '#lib/auth/cell_authorize.ts';
import { filter_visible_target_ids } from '#lib/auth/cell_relation_visibility.ts';
import { create_test_context } from '#lib/testing/entities.ts';
import type { RequestActorContext } from '#lib/auth/request_context.ts';
import type { CellVisibility } from '#lib/auth/cell_action_specs.ts';
import type { QueryDeps } from '#lib/db/query_deps.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { describe_db } from '../cell_db_fixture.ts';

const MODERATIONS: Array<string | null> = [null, 'approved', 'pending', 'rejected', 'unknown'];
const VISIBILITIES: Array<CellVisibility> = ['public', 'private'];

const seed_actor = async (deps: QueryDeps, username: string): Promise<Uuid> =>
	(await query_create_account_with_actor(deps, { username, password_hash: 'x' })).actor.id;

const ctx = (actor_id: Uuid): RequestActorContext => {
	const base = create_test_context([]);
	return { ...base, actor: { ...base.actor, id: actor_id } };
};

describe_db('query_cell_view_load_many', (get_db) => {
	test('projects the view facts alone, without tombstones or unknown ids', async () => {
		const deps = { db: get_db() };
		const owner = await seed_actor(deps, 'view_owner');
		const live = await query_cell_create(deps, {
			data: { secret: 'payload' },
			kind: 'post',
			visibility: 'private',
			moderation: 'pending',
			created_by: owner
		});
		const dead = await query_cell_create(deps, { data: {}, kind: 'post', created_by: owner });
		await query_cell_delete(deps, dead.id);
		const unknown = '00000000-0000-4000-8000-000000000000' as Uuid;
		assert.deepEqual(await query_cell_view_load_many(deps, []), []);
		const rows = await query_cell_view_load_many(deps, [live.id, live.id, dead.id, unknown]);
		assert.strictEqual(rows.length, 1);
		assert.deepEqual(Object.keys(rows[0]!).sort(), [...CELL_VIEW_COLUMNS].sort());
		assert.deepEqual(rows[0], {
			id: live.id,
			visibility: 'private',
			moderation: 'pending',
			created_by: owner
		});
	});

	test('the filter over the narrow read admits what can_view_cell over the full row does', async () => {
		const deps = { db: get_db() };
		const owner = await seed_actor(deps, 'view_parity_owner');
		const holder = await seed_actor(deps, 'view_parity_holder');
		const stranger = await seed_actor(deps, 'view_parity_stranger');
		const ids: Array<Uuid> = [];
		for (const moderation of MODERATIONS) {
			for (const visibility of VISIBILITIES) {
				for (const granted of [false, true]) {
					const { id } = await query_cell_create(deps, {
						data: {},
						kind: 'post',
						visibility,
						moderation,
						created_by: owner
					});
					if (granted) {
						await query_cell_grant_create(deps, {
							cell_id: id,
							level: 'viewer',
							principal: { kind: 'actor', actor_id: holder },
							granted_by: owner
						});
					}
					ids.push(id);
				}
			}
		}
		for (const [label, auth] of [
			['anon', null],
			['owner', ctx(owner)],
			['holder', ctx(holder)],
			['stranger', ctx(stranger)]
		] as const) {
			const visible = await filter_visible_target_ids(deps, auth, ids);
			for (const id of ids) {
				const row = (await query_cell_get(deps, id))!;
				const grants = auth ? await query_cell_grant_list_for_cell(deps, id) : null;
				assert.strictEqual(visible.has(id), can_view_cell(auth, row, grants), `${label} ${id}`);
			}
		}
	});
});
