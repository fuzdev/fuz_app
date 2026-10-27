/**
 * `test_cell_gated_create_authorize` — the directory-model creation policy both
 * reference spines mount — reads the **global** grant for its admin bypass and
 * for a contribution's `min_role`: a scoped grant satisfies neither.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { create_test_context } from '#lib/testing/entities.ts';
import { test_cell_gated_create_authorize } from '#lib/testing/cross_backend/test_cell_gated_create_authorize.ts';

const CELL_ID = '33333333-3333-4333-8333-333333333333' as Uuid;

const scoped_admin = () =>
	create_test_context([{ role: ROLE_ADMIN, scope_kind: 'space', scope_id: CELL_ID }]);

describe('test_cell_gated_create_authorize reads the global grant', () => {
	const space_root = {
		kind: 'space',
		data: {},
		parent_id: null,
		root_id: null,
		root_policy: null,
		scope_id: null
	};

	test('a scoped admin may not create a space root', async () => {
		const auth = scoped_admin();
		assert.deepEqual(await test_cell_gated_create_authorize.authorize(auth, space_root), {
			allow: false
		});
	});

	test('a global admin may', async () => {
		const auth = create_test_context([{ role: ROLE_ADMIN }]);
		assert.deepEqual(await test_cell_gated_create_authorize.authorize(auth, space_root), {
			allow: true,
			moderation_required: false
		});
	});

	test('a min_role is satisfied only by the global grant', async () => {
		const contribution = {
			kind: 'post',
			data: {},
			parent_id: CELL_ID,
			root_id: CELL_ID,
			root_policy: { post: { min_role: 'participant' } },
			scope_id: null
		};
		const scoped = create_test_context([
			{ role: 'participant', scope_kind: 'space', scope_id: CELL_ID }
		]);
		assert.deepEqual(await test_cell_gated_create_authorize.authorize(scoped, contribution), {
			allow: false
		});
		const global = create_test_context([{ role: 'participant' }]);
		assert.deepEqual(await test_cell_gated_create_authorize.authorize(global, contribution), {
			allow: true,
			moderation_required: false
		});
	});

	test('validate_policy accepts the ladder shape and refuses anything else', () => {
		const { validate_policy } = test_cell_gated_create_authorize;
		assert.ok(validate_policy);
		validate_policy({});
		validate_policy({ post: { min_role: 'participant', moderation_required: true }, react: {} });
		for (const bad of [
			{ post: true },
			{ post: null },
			{ post: [] },
			{ post: { min_role: 1 } },
			{ post: { moderation_required: 'yes' } },
			{ post: { other: true } }
		]) {
			assert.throws(() => validate_policy(bad), /invalid space policy/, JSON.stringify(bad));
		}
	});
});
