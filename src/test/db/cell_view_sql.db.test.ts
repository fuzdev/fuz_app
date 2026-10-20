/**
 * `can_view_cell_sql` admits exactly what `can_view_cell` admits.
 *
 * The relation lists and `query_cell_list` filter in SQL, before their limit;
 * the verb gates and the `cell_get` bundle run `can_view_cell` in memory. This
 * seeds a matrix — every moderation marker (unset, approved, pending,
 * rejected, an unknown one) × visibility × grant (none, actor-shaped,
 * role-shaped) × owner (an actor, system) — links each cell into all four
 * relation lists, and checks, for every caller kind, that each list and
 * `query_cell_list` return exactly the cells `can_view_cell` admits over the
 * full row and its grants. A tombstoned cell rides along to pin the liveness
 * clause. Twin of the Rust `fuz_cell` `cell_view_sql` suite.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	query_cell_create,
	query_cell_delete,
	query_cell_list,
	query_cell_load_many
} from '#lib/db/cell_queries.ts';
import {
	query_cell_grant_create,
	query_cell_grant_list_for_cells,
	type CellGrantPrincipalQueryInput,
	type CellGrantRow
} from '#lib/db/cell_grant_queries.ts';
import {
	query_cell_field_list_for_source,
	query_cell_field_list_for_target,
	query_cell_field_set
} from '#lib/db/cell_field_queries.ts';
import {
	query_cell_item_insert,
	query_cell_item_list_for_child,
	query_cell_item_list_for_parent
} from '#lib/db/cell_item_queries.ts';
import { CELL_VIEWER_ANONYMOUS } from '#lib/db/cell_view_sql.ts';
import { query_create_account_with_actor } from '#lib/auth/account_queries.ts';
import { can_view_cell, cell_viewer_from_auth } from '#lib/auth/cell_authorize.ts';
import { create_test_context } from '#lib/testing/entities.ts';
import type { RequestContext } from '#lib/auth/request_context.ts';
import type { CellVisibility } from '#lib/auth/cell_action_specs.ts';
import type { QueryDeps } from '#lib/db/query_deps.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { describe_db } from '../cell_db_fixture.ts';

/** The role a role-shaped grant in the matrix names. */
const MEMBER_ROLE = 'member';

const MODERATIONS: Array<string | null> = [null, 'approved', 'pending', 'rejected', 'Approved'];
const VISIBILITIES: Array<CellVisibility> = ['public', 'private'];
const GRANTS = ['none', 'actor', 'role'] as const;

const seed_actor = async (deps: QueryDeps, username: string): Promise<Uuid> =>
	(await query_create_account_with_actor(deps, { username, password_hash: 'x' })).actor.id;

/** A request context for `actor_id` holding `roles` (global, active unless `expired`). */
const ctx = (
	actor_id: Uuid,
	roles: Array<string> = [],
	options?: { expired?: boolean }
): RequestContext => {
	const base = create_test_context(
		roles.map((role) => ({
			role,
			actor_id,
			expires_at: options?.expired ? '2000-01-01T00:00:00Z' : null
		}))
	);
	return { ...base, actor: { ...base.actor, id: actor_id } };
};

describe_db('can_view_cell_sql', (get_db) => {
	test('the SQL view filter admits exactly what can_view_cell admits', async () => {
		const deps = { db: get_db() };
		const owner = await seed_actor(deps, 'view_sql_owner');
		const grantee = await seed_actor(deps, 'view_sql_grantee');
		const member = await seed_actor(deps, 'view_sql_member');
		const stranger = await seed_actor(deps, 'view_sql_stranger');
		const admin = await seed_actor(deps, 'view_sql_admin');

		// The hubs every matrix cell links to and from — public, unmoderated,
		// ownerless, so each caller passes the gate the verbs put on them.
		const hub = async () =>
			(await query_cell_create(deps, { data: {}, visibility: 'public', created_by: null })).id;
		const source = await hub();
		const target = await hub();
		const parent = await hub();
		const child = await hub();

		const matrix: Array<Uuid> = [];
		for (const moderation of MODERATIONS) {
			for (const visibility of VISIBILITIES) {
				for (const grant of GRANTS) {
					for (const created_by of [owner, null]) {
						const { id } = await query_cell_create(deps, {
							data: {},
							visibility,
							moderation,
							created_by
						});
						const principal: CellGrantPrincipalQueryInput | null =
							grant === 'actor'
								? { kind: 'actor', actor_id: grantee }
								: grant === 'role'
									? { kind: 'role', role: MEMBER_ROLE, scope_id: null }
									: null;
						if (principal) {
							await query_cell_grant_create(deps, {
								cell_id: id,
								level: 'viewer',
								principal,
								granted_by: owner
							});
						}
						matrix.push(id);
					}
				}
			}
		}
		// A tombstoned public cell: live for nobody.
		const tombstoned = (
			await query_cell_create(deps, { data: {}, visibility: 'public', created_by: owner })
		).id;
		matrix.push(tombstoned);

		for (const [i, cell] of matrix.entries()) {
			const key = String(i).padStart(3, '0');
			await query_cell_field_set(deps, { source_id: source, name: `f${key}`, target_id: cell });
			await query_cell_field_set(deps, { source_id: cell, name: 'link', target_id: target });
			await query_cell_item_insert(deps, {
				parent_id: parent,
				position: `p${key}`,
				child_id: cell
			});
			await query_cell_item_insert(deps, { parent_id: cell, position: 'a0', child_id: child });
		}
		await query_cell_delete(deps, tombstoned);

		// What `can_view_cell` admits, over the rows and grants the verbs load.
		const rows = await query_cell_load_many(deps, matrix);
		const grants_by_cell = new Map<Uuid, Array<CellGrantRow>>();
		for (const g of await query_cell_grant_list_for_cells(deps, matrix)) {
			const list = grants_by_cell.get(g.cell_id) ?? [];
			list.push(g);
			grants_by_cell.set(g.cell_id, list);
		}

		const account_grain: RequestContext = { ...ctx(stranger), actor: null };
		const callers: Array<readonly [string, RequestContext | null]> = [
			['anonymous', null],
			['owner', ctx(owner)],
			['actor grant holder', ctx(grantee)],
			['role grant holder', ctx(member, [MEMBER_ROLE])],
			['expired role grant holder', ctx(member, [MEMBER_ROLE], { expired: true })],
			['stranger', ctx(stranger)],
			['account grain', account_grain],
			['admin', ctx(admin, ['admin'])]
		];
		const sorted = (ids: Iterable<Uuid>): Array<Uuid> => [...ids].sort();
		for (const [label, auth] of callers) {
			const expected = sorted(
				rows
					.filter((row) => can_view_cell(auth, row, grants_by_cell.get(row.id) ?? []))
					.map((row) => row.id)
			);
			assert.ok(expected.length > 0, `${label}: the matrix admits something`);
			assert.ok(!expected.includes(tombstoned), `${label}: a tombstone is never admitted`);
			if (label !== 'admin') {
				assert.ok(expected.length < rows.length, `${label}: the matrix refuses something`);
			}

			const viewer = cell_viewer_from_auth(auth);
			const forward_fields = await query_cell_field_list_for_source(deps, viewer, source);
			assert.deepEqual(
				sorted(forward_fields.map((f) => f.target_id)),
				expected,
				`${label}: forward fields`
			);
			const reverse_fields = await query_cell_field_list_for_target(deps, viewer, target);
			assert.deepEqual(
				sorted(reverse_fields.map((f) => f.source_id)),
				expected,
				`${label}: reverse fields`
			);
			const forward_items = await query_cell_item_list_for_parent(deps, viewer, parent);
			assert.deepEqual(
				sorted(forward_items.map((i) => i.child_id)),
				expected,
				`${label}: forward items`
			);
			const reverse_items = await query_cell_item_list_for_child(deps, viewer, child);
			assert.deepEqual(
				sorted(reverse_items.map((i) => i.parent_id)),
				expected,
				`${label}: reverse items`
			);

			// `query_cell_list` embeds the same predicate; with no governing roots
			// in the matrix its steward arm admits nothing more.
			const listed = await query_cell_list(deps, {
				ids: matrix,
				viewer_actor_id: viewer.actor_id,
				viewer_is_admin: viewer.is_admin,
				caller_actor_id: viewer.actor_id,
				caller_role_grant_roles: viewer.role_grant_roles,
				caller_role_grant_scope_ids: viewer.role_grant_scope_ids,
				limit: 1000
			});
			assert.deepEqual(sorted(listed.map((c) => c.id)), expected, `${label}: query_cell_list`);
		}
	});

	test('the view filter runs before the limit', async () => {
		// Hidden sources older than a visible one never crowd it out of a page.
		const deps = { db: get_db() };
		const owner = await seed_actor(deps, 'view_sql_limit_owner');
		const create = async (visibility: CellVisibility) =>
			(await query_cell_create(deps, { data: {}, visibility, created_by: owner })).id;
		const target = await create('public');
		const child = await create('public');
		for (let i = 0; i < 5; i++) {
			const hidden = await create('private');
			await query_cell_field_set(deps, { source_id: hidden, name: 'link', target_id: target });
			await query_cell_item_insert(deps, { parent_id: hidden, position: 'a0', child_id: child });
		}
		const visible = await create('public');
		await query_cell_field_set(deps, { source_id: visible, name: 'link', target_id: target });
		await query_cell_item_insert(deps, { parent_id: visible, position: 'a0', child_id: child });

		const fields = await query_cell_field_list_for_target(deps, CELL_VIEWER_ANONYMOUS, target, {
			limit: 1
		});
		assert.deepEqual(
			fields.map((f) => f.source_id),
			[visible]
		);
		const items = await query_cell_item_list_for_child(deps, CELL_VIEWER_ANONYMOUS, child, {
			limit: 1
		});
		assert.deepEqual(
			items.map((i) => i.parent_id),
			[visible]
		);
	});

	test('scoped principals admit the same cells in SQL and in memory', async () => {
		// Scoped role grants on both sides, a scoped (non-global) admin grant, an
		// editor-level grant, a multi-role caller, and an empty-string marker.
		const deps = { db: get_db() };
		const owner = await seed_actor(deps, 'view_sql_scoped_owner');
		const grantee = await seed_actor(deps, 'view_sql_scoped_grantee');
		const caller = await seed_actor(deps, 'view_sql_scoped_caller');
		const scope_a = '00000000-0000-4000-8000-00000000000a' as Uuid;
		const scope_b = '00000000-0000-4000-8000-00000000000b' as Uuid;
		const scoped = (
			grants: Array<[string, Uuid | null]>,
			actor_id: Uuid = caller
		): RequestContext => {
			const base = create_test_context(
				grants.map(([role, scope_id]) => ({ role, scope_id, actor_id, expires_at: null }))
			);
			return { ...base, actor: { ...base.actor, id: actor_id } };
		};
		const create = async (moderation: string | null) =>
			(
				await query_cell_create(deps, {
					data: {},
					visibility: 'private',
					moderation,
					created_by: owner
				})
			).id;
		const hub = async () =>
			(await query_cell_create(deps, { data: {}, visibility: 'public', created_by: null })).id;
		const source = await hub();
		const target = await hub();
		const parent = await hub();
		const child = await hub();
		const principals: Array<['viewer' | 'editor', CellGrantPrincipalQueryInput]> = [
			['viewer', { kind: 'role', role: MEMBER_ROLE, scope_id: null }],
			['viewer', { kind: 'role', role: MEMBER_ROLE, scope_id: scope_a }],
			['viewer', { kind: 'role', role: MEMBER_ROLE, scope_id: scope_b }],
			['viewer', { kind: 'role', role: 'other', scope_id: scope_a }],
			['editor', { kind: 'actor', actor_id: grantee }]
		];
		const matrix: Array<Uuid> = [];
		for (const moderation of [null, 'approved', '']) {
			matrix.push(await create(moderation));
			for (const [level, principal] of principals) {
				const id = await create(moderation);
				await query_cell_grant_create(deps, { cell_id: id, level, principal, granted_by: owner });
				matrix.push(id);
			}
		}
		for (const [i, cell] of matrix.entries()) {
			const key = String(i).padStart(3, '0');
			await query_cell_field_set(deps, { source_id: source, name: `f${key}`, target_id: cell });
			await query_cell_field_set(deps, { source_id: cell, name: 'link', target_id: target });
			await query_cell_item_insert(deps, {
				parent_id: parent,
				position: `p${key}`,
				child_id: cell
			});
			await query_cell_item_insert(deps, { parent_id: cell, position: 'a0', child_id: child });
		}
		const rows = await query_cell_load_many(deps, matrix);
		const grants_by_cell = new Map<Uuid, Array<CellGrantRow>>();
		for (const g of await query_cell_grant_list_for_cells(deps, matrix)) {
			const list = grants_by_cell.get(g.cell_id) ?? [];
			list.push(g);
			grants_by_cell.set(g.cell_id, list);
		}
		const callers: Array<readonly [string, RequestContext]> = [
			['scoped admin', scoped([['admin', scope_a]])],
			['member global', scoped([[MEMBER_ROLE, null]])],
			['member @a', scoped([[MEMBER_ROLE, scope_a]])],
			['member @b', scoped([[MEMBER_ROLE, scope_b]])],
			[
				'multi-role',
				scoped([
					['other', scope_b],
					[MEMBER_ROLE, scope_a],
					['third', null]
				])
			],
			['editor grantee', scoped([], grantee)]
		];
		const sorted = (ids: Iterable<Uuid>): Array<Uuid> => [...ids].sort();
		for (const [label, auth] of callers) {
			const expected = sorted(
				rows
					.filter((row) => can_view_cell(auth, row, grants_by_cell.get(row.id) ?? []))
					.map((row) => row.id)
			);
			// a scoped admin grant is no admin: every matrix cell is private
			assert.strictEqual(expected.length === 0, label === 'scoped admin', `${label}: admits`);
			assert.ok(expected.length < rows.length, `${label}: refuses something`);
			const viewer = cell_viewer_from_auth(auth);
			const lists: Array<[string, Array<Uuid>]> = [
				[
					'forward fields',
					(await query_cell_field_list_for_source(deps, viewer, source)).map((f) => f.target_id)
				],
				[
					'reverse fields',
					(await query_cell_field_list_for_target(deps, viewer, target)).map((f) => f.source_id)
				],
				[
					'forward items',
					(await query_cell_item_list_for_parent(deps, viewer, parent)).map((i) => i.child_id)
				],
				[
					'reverse items',
					(await query_cell_item_list_for_child(deps, viewer, child)).map((i) => i.parent_id)
				]
			];
			for (const [list, ids] of lists) {
				assert.deepEqual(sorted(ids), expected, `${label}: ${list}`);
			}
		}
	});
});
