/**
 * How `cell.moderation` gates `can_view_cell`'s read arms.
 *
 * A cell's effective audience is its visibility or grants **and** its
 * moderation admission (`cell_moderation_admits_audience`: unmoderated or
 * `'approved'`, an allowlist — the column has no CHECK). The public and grant
 * arms require it; the owner and global-admin arms don't. Beside it,
 * `can_steward_cell` admits the governing root's manager to a pending or
 * rejected contribution, and nobody else. Twin of the Rust
 * `fuz_cell::cell_authz` moderation tables.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { can_edit_cell, can_steward_cell, can_view_cell } from '#lib/auth/cell_authorize.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import type { CellRow } from '#lib/db/cell_queries.ts';
import type { CellGrantRow } from '#lib/db/cell_grant_queries.ts';
import type { CellVisibility } from '#lib/auth/cell_action_specs.ts';
import {
	cell_moderation_admits_audience,
	cell_moderation_is_stewardable
} from '#lib/db/cell_moderation.ts';
import type { RequestActorContext } from '#lib/auth/request_context.ts';
import { create_test_context } from '#lib/testing/entities.ts';

const OWNER = '11111111-1111-4111-8111-111111111111' as Uuid;
const STRANGER = '22222222-2222-4222-8222-222222222222' as Uuid;
const HOLDER = '33333333-3333-4333-8333-333333333333' as Uuid;
const ROLE_HOLDER = '44444444-4444-4444-8444-444444444444' as Uuid;
const ADMIN = '55555555-5555-4555-8555-555555555555' as Uuid;
const CELL_ID = '66666666-6666-4666-8666-666666666666' as Uuid;
const ROOT_OWNER = '88888888-8888-4888-8888-888888888888' as Uuid;
const ROOT_ID = '99999999-9999-4999-8999-999999999999' as Uuid;

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
	test('stewardship is exactly pending or rejected', () => {
		assert.isTrue(cell_moderation_is_stewardable('pending'));
		assert.isTrue(cell_moderation_is_stewardable('rejected'));
		assert.isFalse(cell_moderation_is_stewardable(null));
		assert.isFalse(cell_moderation_is_stewardable('approved'));
		assert.isFalse(cell_moderation_is_stewardable('Pending'));
	});

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

describe('can_steward_cell', () => {
	const root = cell('public', null, { id: ROOT_ID, created_by: ROOT_OWNER });
	const contribution = (moderation: string | null, overrides: Partial<CellRow> = {}): CellRow =>
		cell('private', moderation, { parent_id: ROOT_ID, root_id: ROOT_ID, ...overrides });

	for (const moderation of MODERATIONS) {
		const stewardable = moderation === 'pending' || moderation === 'rejected';
		const admitted = moderation === null || moderation === 'approved';
		test(`${moderation ?? 'unmoderated'}: the root manager alone stewards`, () => {
			const c = contribution(moderation);
			assert.isFalse(can_steward_cell(null, c, root), 'anon');
			assert.strictEqual(can_steward_cell(ctx(ROOT_OWNER), c, root), stewardable, 'root owner');
			assert.isFalse(can_view_cell(ctx(ROOT_OWNER), c, []), 'the root owner gains no view arm');
			assert.strictEqual(can_steward_cell(ctx(ADMIN, [ROLE_ADMIN]), c, root), stewardable, 'admin');
			// the author reads through the owner arm, never the steward arm
			assert.isFalse(can_steward_cell(ctx(OWNER), c, root), 'author');
			assert.isTrue(can_view_cell(ctx(OWNER), c, []), 'author views');
			assert.isFalse(can_steward_cell(ctx(STRANGER), c, root), 'stranger');
			assert.isFalse(can_steward_cell(ctx(HOLDER), c, root), 'grant holder');
			assert.strictEqual(can_view_cell(ctx(HOLDER), c, GRANTS), admitted, 'grant holder views');
		});
	}

	test('needs the live governing root', () => {
		const c = contribution('pending');
		const owner = ctx(ROOT_OWNER);
		assert.isTrue(can_steward_cell(owner, c, root), 'control');
		assert.isFalse(
			can_steward_cell(owner, c, { ...root, deleted_at: '2026-01-02T00:00:00Z' }),
			'a tombstoned root'
		);
		assert.isFalse(
			can_steward_cell(owner, c, { ...root, id: CELL_ID }),
			'a root the cell does not belong to'
		);
		assert.isFalse(can_steward_cell(owner, { ...c, root_id: null }, root), 'a root itself');
	});
});
