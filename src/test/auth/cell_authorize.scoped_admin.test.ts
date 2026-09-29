/**
 * The cell authz admin bypass is the **global** `admin` grant: a scoped
 * `admin` row — legacy data, since no grant path mints one (builtin roles are
 * global-only) — views, edits, and manages nothing it couldn't without it.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import { can_edit_cell, can_manage_cell, can_view_cell } from '$lib/auth/cell_authorize.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import type { CellRow } from '$lib/db/cell_queries.ts';
import type { CellVisibility } from '$lib/auth/cell_action_specs.ts';
import { create_test_context } from '$lib/testing/entities.ts';

const OWNER = '22222222-2222-4222-8222-222222222222' as Uuid;
const CELL_ID = '33333333-3333-4333-8333-333333333333' as Uuid;

const cell = (visibility: CellVisibility, created_by: Uuid | null): CellRow => ({
	id: CELL_ID,
	data: {},
	kind: 'note',
	visibility,
	path: null,
	refs: null,
	parent_id: null,
	root_id: null,
	moderation: null,
	created_at: '2026-01-01T00:00:00Z',
	updated_at: null,
	deleted_at: null,
	created_by,
	updated_by: null,
	grant_count: 0
});

const scoped_admin = () =>
	create_test_context([{ role: ROLE_ADMIN, scope_kind: 'space', scope_id: CELL_ID }]);

describe('cell authz admin bypass is global-only', () => {
	test('a scoped admin gets no bypass on view / edit / manage', () => {
		const auth = scoped_admin();
		const private_cell = cell('private', OWNER);
		assert.isFalse(can_view_cell(auth, private_cell, []));
		assert.isFalse(can_edit_cell(auth, private_cell, []));
		assert.isFalse(can_manage_cell(auth, private_cell));
		// The system-origin guard holds too: a NULL `created_by` cell stays
		// global-admin-only for edit.
		assert.isFalse(can_edit_cell(auth, cell('public', null), []));
	});

	test('the global admin grant bypasses every tier', () => {
		const auth = create_test_context([{ role: ROLE_ADMIN }]);
		const private_cell = cell('private', OWNER);
		assert.isTrue(can_view_cell(auth, private_cell, []));
		assert.isTrue(can_edit_cell(auth, private_cell, []));
		assert.isTrue(can_manage_cell(auth, private_cell));
		assert.isTrue(can_edit_cell(auth, cell('public', null), []));
	});
});
