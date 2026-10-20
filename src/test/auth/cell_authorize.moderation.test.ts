/**
 * How `cell.moderation` gates `can_view_cell`'s read arms.
 *
 * A cell's effective audience is its visibility or grants **and** its
 * moderation admission (`cell_moderation_admits_audience`: unmoderated or
 * `'approved'`, an allowlist — the column has no CHECK). The public and grant
 * arms require it; the owner and global-admin arms don't. Twin of the Rust
 * `fuz_cell::cell_authz` moderation table.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { can_edit_cell, can_view_cell } from '#lib/auth/cell_authorize.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import type { CellRow } from '#lib/db/cell_queries.ts';
import type { CellGrantRow } from '#lib/db/cell_grant_queries.ts';
import type { CellVisibility } from '#lib/auth/cell_action_specs.ts';
import { cell_moderation_admits_audience } from '#lib/db/cell_moderation.ts';
import type { RequestActorContext } from '#lib/auth/request_context.ts';
import { create_test_context } from '#lib/testing/entities.ts';

const OWNER = '11111111-1111-4111-8111-111111111111' as Uuid;
const STRANGER = '22222222-2222-4222-8222-222222222222' as Uuid;
const HOLDER = '33333333-3333-4333-8333-333333333333' as Uuid;
const ROLE_HOLDER = '44444444-4444-4444-8444-444444444444' as Uuid;
const ADMIN = '55555555-5555-4555-8555-555555555555' as Uuid;
const CELL_ID = '66666666-6666-4666-8666-666666666666' as Uuid;

/** Unmoderated, the three literals, and a marker no rule names. */
const MODERATIONS: Array<string | null> = [null, 'approved', 'pending', 'rejected', 'unknown'];

const VISIBILITIES: Array<CellVisibility> = ['public', 'private'];

const ctx = (actor_id: Uuid, roles: Array<string> = []): RequestActorContext => {
	const base = create_test_context(roles.map((role) => ({ role, actor_id })));
	return { ...base, actor: { ...base.actor, id: actor_id } };
};

const cell = (
	visibility: CellVisibility,
	moderation: string | null,
	overrides: Partial<CellRow> = {}
): CellRow => ({
	id: CELL_ID,
	data: {},
	kind: 'post',
	visibility,
	path: null,
	refs: null,
	parent_id: null,
	root_id: null,
	moderation,
	created_at: '2026-01-01T00:00:00Z',
	updated_at: null,
	deleted_at: null,
	created_by: OWNER,
	updated_by: null,
	grant_count: 0,
	...overrides
});

const grant = (overrides: Partial<CellGrantRow>): CellGrantRow => ({
	id: '77777777-7777-4777-8777-777777777777' as Uuid,
	cell_id: CELL_ID,
	level: 'viewer',
	actor_id: null,
	role: null,
	scope_id: null,
	granted_by: OWNER,
	created_at: '2026-01-01T00:00:00Z',
	...overrides
});

const GRANTS: Array<CellGrantRow> = [grant({ actor_id: HOLDER }), grant({ role: 'member' })];
const EDITOR_GRANTS: Array<CellGrantRow> = [grant({ role: 'member', level: 'editor' })];

describe('cell_moderation_admits_audience', () => {
	test('is an allowlist over unmoderated and approved', () => {
		assert.isTrue(cell_moderation_admits_audience(null));
		assert.isTrue(cell_moderation_admits_audience('approved'));
		assert.isFalse(cell_moderation_admits_audience('pending'));
		assert.isFalse(cell_moderation_admits_audience('rejected'));
		assert.isFalse(cell_moderation_admits_audience('Approved'));
		assert.isFalse(cell_moderation_admits_audience(''));
	});
});

describe('can_view_cell moderation gating', () => {
	for (const moderation of MODERATIONS) {
		for (const visibility of VISIBILITIES) {
			const admitted = moderation === null || moderation === 'approved';
			const is_public = visibility === 'public';
			const c = cell(visibility, moderation);
			test(`${visibility} ${moderation ?? 'unmoderated'}`, () => {
				assert.strictEqual(can_view_cell(null, c, null), is_public && admitted, 'anon');
				assert.strictEqual(
					can_view_cell(ctx(STRANGER), c, GRANTS),
					is_public && admitted,
					'stranger'
				);
				assert.isTrue(can_view_cell(ctx(OWNER), c, []), 'owner');
				assert.isTrue(can_view_cell(ctx(ADMIN, [ROLE_ADMIN]), c, []), 'admin');
				assert.strictEqual(can_view_cell(ctx(HOLDER), c, GRANTS), admitted, 'actor grant');
				assert.strictEqual(
					can_view_cell(ctx(ROLE_HOLDER, ['member']), c, GRANTS),
					admitted,
					'role grant'
				);
				assert.strictEqual(
					can_edit_cell(ctx(ROLE_HOLDER, ['member']), c, EDITOR_GRANTS),
					admitted,
					'role editor grant edits'
				);
				assert.isTrue(can_edit_cell(ctx(OWNER), c, []), 'owner edits');
			});
		}
	}
});
