/**
 * How `cell.moderation` gates the `query_cell_list` read arms — the SQL twin
 * of `can_view_cell`'s moderation rule.
 *
 * A cell's effective audience is its visibility or grants **and** its
 * moderation admission (unmoderated or `'approved'`): the public and grant
 * arms of the general predicate and the `shared_with` semi-join require it,
 * the owner and admin arms don't. The general predicate's steward arm (the
 * SQL twin of `can_steward_cell`) admits the owner of a live governing root to
 * the pending and rejected contributions under it — the moderation queue — and
 * the `shared_with` semi-join has no steward arm. Twin of the Rust
 * `fuz_cell/tests/cell_moderation_reads.rs`.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	query_cell_create,
	query_cell_delete,
	query_cell_list,
	type CellListParams
} from '#lib/db/cell_queries.ts';
import { query_cell_grant_create } from '#lib/db/cell_grant_queries.ts';
import {
	cell_moderation_admits_audience,
	cell_moderation_is_stewardable
} from '#lib/db/cell_moderation.ts';
import { query_create_account_with_actor } from '#lib/auth/account_queries.ts';
import type { CellVisibility } from '#lib/auth/cell_action_specs.ts';
import type { QueryDeps } from '#lib/db/query_deps.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { describe_db } from '../cell_db_fixture.ts';

/** Unmoderated, the three literals, and a marker no rule names. */
const MODERATIONS: Array<string | null> = [null, 'approved', 'pending', 'rejected', 'unknown'];

const ROLE = 'member';

const seed_actor = async (deps: QueryDeps, username: string): Promise<Uuid> =>
	(
		await query_create_account_with_actor(deps, {
			username,
			password_hash: 'x'
		})
	).actor.id;

const list_ids = async (deps: QueryDeps, params: CellListParams): Promise<Set<Uuid>> =>
	new Set((await query_cell_list(deps, { limit: 500, ...params })).map((c) => c.id));

interface ModerationCells {
	moderation: string | null;
	public_id: Uuid;
	actor_granted_id: Uuid;
	role_granted_id: Uuid;
}

const seed_cells = async (
	deps: QueryDeps,
	owner: Uuid,
	holder: Uuid,
	moderation: string | null
): Promise<ModerationCells> => {
	const create = async (visibility: CellVisibility) =>
		(
			await query_cell_create(deps, {
				data: {},
				kind: 'post',
				visibility,
				moderation,
				created_by: owner
			})
		).id;
	const public_id = await create('public');
	const actor_granted_id = await create('private');
	const role_granted_id = await create('private');
	await query_cell_grant_create(deps, {
		cell_id: actor_granted_id,
		level: 'viewer',
		principal: { kind: 'actor', actor_id: holder },
		granted_by: owner
	});
	await query_cell_grant_create(deps, {
		cell_id: role_granted_id,
		level: 'viewer',
		principal: { kind: 'role', role: ROLE, scope_id: null },
		granted_by: owner
	});
	return { moderation, public_id, actor_granted_id, role_granted_id };
};

describe_db('query_cell_list moderation gating', (get_db) => {
	test('the public and grant arms require moderation admission; owner and admin do not', async () => {
		const deps = { db: get_db() };
		const owner = await seed_actor(deps, 'mod_owner');
		const stranger = await seed_actor(deps, 'mod_stranger');
		const holder = await seed_actor(deps, 'mod_holder');
		const role_holder = await seed_actor(deps, 'mod_role_holder');
		const all: Array<ModerationCells> = [];
		for (const moderation of MODERATIONS) {
			all.push(await seed_cells(deps, owner, holder, moderation));
		}

		const viewer = (actor: Uuid | null): CellListParams => ({
			viewer_actor_id: actor,
			viewer_is_admin: false,
			caller_actor_id: actor
		});
		const as_role_holder: CellListParams = {
			...viewer(role_holder),
			caller_role_grant_roles: [ROLE],
			caller_role_grant_scope_ids: [null]
		};
		const anon = await list_ids(deps, viewer(null));
		const strangers = await list_ids(deps, viewer(stranger));
		const holders = await list_ids(deps, viewer(holder));
		const role_holders = await list_ids(deps, as_role_holder);
		const owners = await list_ids(deps, viewer(owner));
		const admins = await list_ids(deps, { ...viewer(null), viewer_is_admin: true });
		const shared_with_holder = await list_ids(deps, {
			...viewer(holder),
			shared_with_caller_only: true
		});
		const shared_with_role_holder = await list_ids(deps, {
			...as_role_holder,
			shared_with_caller_only: true
		});

		for (const cells of all) {
			const admitted = cell_moderation_admits_audience(cells.moderation);
			const m = String(cells.moderation);
			assert.strictEqual(anon.has(cells.public_id), admitted, `anon public ${m}`);
			assert.strictEqual(strangers.has(cells.public_id), admitted, `stranger public ${m}`);
			assert.isFalse(strangers.has(cells.actor_granted_id), `stranger granted ${m}`);
			assert.strictEqual(holders.has(cells.actor_granted_id), admitted, `actor grant ${m}`);
			assert.strictEqual(role_holders.has(cells.role_granted_id), admitted, `role grant ${m}`);
			assert.strictEqual(
				shared_with_holder.has(cells.actor_granted_id),
				admitted,
				`shared_with actor grant ${m}`
			);
			assert.strictEqual(
				shared_with_role_holder.has(cells.role_granted_id),
				admitted,
				`shared_with role grant ${m}`
			);
			for (const id of [cells.public_id, cells.actor_granted_id, cells.role_granted_id]) {
				assert.isTrue(owners.has(id), `owner reads own ${m}`);
				assert.isTrue(admins.has(id), `admin reads ${m}`);
			}
		}
	});

	test('the steward arm admits the root owner to pending and rejected contributions', async () => {
		const deps = { db: get_db() };
		const root_owner = await seed_actor(deps, 'st_root_owner');
		const other_root_owner = await seed_actor(deps, 'st_other_root_owner');
		const author = await seed_actor(deps, 'st_author');
		const commenter = await seed_actor(deps, 'st_commenter');
		const stranger = await seed_actor(deps, 'st_stranger');
		const create = async (
			owner: Uuid,
			kind: string,
			tree: { parent_id: Uuid; root_id: Uuid } | null,
			moderation: string | null
		) =>
			(
				await query_cell_create(deps, {
					data: {},
					kind,
					visibility: 'private',
					parent_id: tree?.parent_id ?? null,
					root_id: tree?.root_id ?? null,
					moderation,
					created_by: owner
				})
			).id;

		const root = await create(root_owner, 'forum', null, null);
		await create(other_root_owner, 'forum', null, null);
		const posts: Array<{ moderation: string | null; id: Uuid }> = [];
		for (const moderation of MODERATIONS) {
			posts.push({
				moderation,
				id: await create(author, 'post', { parent_id: root, root_id: root }, moderation)
			});
		}
		const pending_post = posts.find((p) => p.moderation === 'pending')!.id;
		// nested: another author's pending comment under the pending post — its
		// governing root is the forum, so the forum's owner stewards it and the
		// post's author does not
		const comment = await create(
			commenter,
			'comment',
			{ parent_id: pending_post, root_id: root },
			'pending'
		);

		const viewer = (actor: Uuid): CellListParams => ({
			viewer_actor_id: actor,
			viewer_is_admin: false,
			caller_actor_id: actor,
			root_id: root
		});
		const root_owners = await list_ids(deps, viewer(root_owner));
		for (const { moderation, id } of posts) {
			// an approved or unmoderated contribution narrowed to private is not
			// stewarded — it reads like any cell its author narrowed
			assert.strictEqual(
				root_owners.has(id),
				cell_moderation_is_stewardable(moderation),
				`root owner ${String(moderation)}`
			);
		}
		assert.isTrue(root_owners.has(comment), 'root owner reads a nested pending comment');
		assert.strictEqual((await list_ids(deps, viewer(other_root_owner))).size, 0, 'other root');
		assert.strictEqual((await list_ids(deps, viewer(stranger))).size, 0, 'stranger');
		const authors = await list_ids(deps, viewer(author));
		assert.isFalse(
			authors.has(comment),
			"a post's author is not the steward of a comment under it"
		);
		assert.strictEqual(authors.size, posts.length, 'the author reads their own posts');

		const queue = await list_ids(deps, { ...viewer(root_owner), moderation: 'pending' });
		assert.deepStrictEqual(queue, new Set([pending_post, comment]), 'the moderation queue');
		const shared = await list_ids(deps, { ...viewer(root_owner), shared_with_caller_only: true });
		assert.strictEqual(shared.size, 0, 'shared_with has no steward arm');

		// a tombstoned root stewards nothing; its contributions stay live
		assert.isTrue(await query_cell_delete(deps, root, { deleted_by: root_owner }));
		assert.strictEqual(
			(await list_ids(deps, viewer(root_owner))).size,
			0,
			'no steward arm under a deleted root'
		);
		assert.strictEqual((await list_ids(deps, viewer(author))).size, posts.length);
	});
});
