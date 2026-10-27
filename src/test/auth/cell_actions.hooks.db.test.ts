/**
 * The kinds the cell hooks see, and what a write stores.
 *
 * `validate_data` gets the cell's `kind` with the `data`: the input's on
 * `cell_create`, the existing cell's on a `cell_update` carrying `data` (one
 * carrying none never reaches it), and the source's for every row a
 * `cell_clone` writes, on the merged data. It accepts or throws — the handler
 * stores the caller's `data` as sent, and admits refs on it. `authorize_create`
 * gets the parent's `kind` as `parent_kind`: `null` for a root, a typeless
 * parent, and every clone row.
 *
 * @module
 */

import { test, assert } from 'vitest';
import { z } from 'zod';

import {
	cell_clone_action_spec,
	cell_create_action_spec,
	cell_update_action_spec,
	ERROR_CELL_REF_NOT_HELD,
	type CellCreateInput
} from '#lib/auth/cell_action_specs.ts';
import type { CellActionDeps, CellCreateAuthorize } from '#lib/auth/cell_actions.ts';
import type { CellData } from '#lib/auth/cell_data_schema.ts';
import { PgFactStore } from '#lib/db/fact_store.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { call, create_cell, create_cell_test_app } from './cell_test_helpers.ts';
import { error_reason } from './rpc_test_helpers.ts';
import { describe_db } from '../cell_db_fixture.ts';

describe_db('cell hooks see the kinds', (get_db) => {
	install_audit_drift_guard();

	test('the validator gets the cell kind, the authorizer the parent kind', async () => {
		const validated: Array<[string | null, CellData]> = [];
		const authorized: Array<[string | null, string | null]> = [];
		const validate_data: CellActionDeps['validate_data'] = (kind, data) => {
			validated.push([kind, structuredClone(data)]);
		};
		const authorize_create: CellCreateAuthorize = {
			authorize: (_auth, input) => {
				authorized.push([input.kind, input.parent_kind]);
				return { allow: true, moderation_required: false };
			}
		};
		const app = await create_cell_test_app(get_db, [], { validate_data, authorize_create });
		const alice = await app.create_account({ username: 'hooks_kind_alice' });
		const headers = alice.create_session_headers();
		const create = async (params: CellCreateInput): Promise<Uuid> => {
			const res = await call(app, cell_create_action_spec, params, headers);
			assert.ok(res.ok, JSON.stringify(res));
			return res.result.cell.id;
		};

		// create: the input's kind to the validator, the parent's to the authorizer
		const space = await create({ kind: 'space', data: { label: 's' } });
		const post = await create({ kind: 'post', data: { label: 'p' }, parent_id: space });
		const note = await create({ data: {}, parent_id: post });
		await create({ kind: 'comment', data: {}, parent_id: note });
		assert.deepEqual(validated.splice(0), [
			['space', { label: 's' }],
			['post', { label: 'p' }],
			[null, {}],
			['comment', {}]
		]);
		assert.deepEqual(
			authorized.splice(0),
			[
				['space', null],
				['post', 'space'],
				[null, 'post'],
				['comment', null]
			],
			'a typeless parent hands over no kind'
		);

		// update: the existing cell's kind, and only when `data` is present
		const with_data = await call(
			app,
			cell_update_action_spec,
			{ cell_id: post, data: { label: 'p2' } },
			headers
		);
		assert.ok(with_data.ok, JSON.stringify(with_data));
		const without_data = await call(
			app,
			cell_update_action_spec,
			{ cell_id: post, visibility: 'public' },
			headers
		);
		assert.ok(without_data.ok, JSON.stringify(without_data));
		assert.deepEqual(validated.splice(0), [['post', { label: 'p2' }]]);

		// clone: the source's kind for every row, each asked as a parentless create
		const source = await create_cell(app, {
			kind: 'shelf',
			data: { label: 'sh' },
			items: [post],
			headers
		});
		validated.length = 0;
		authorized.length = 0;
		const cloned = await call(
			app,
			cell_clone_action_spec,
			{ source_id: source.id, deep: true, with_data_patch: { summary: 'x' } },
			headers
		);
		assert.ok(cloned.ok, JSON.stringify(cloned));
		assert.deepEqual(validated.splice(0), [
			['shelf', { label: 'sh', summary: 'x' }],
			['post', { label: 'p2' }]
		]);
		assert.deepEqual(authorized.splice(0), [
			['shelf', null],
			['post', null]
		]);
	});

	test('a write stores the caller data, not what the validator parses', async () => {
		// a stripping parse: a validator that called it and returned its output
		// would have stored `{label}` alone
		const Labeled = z.object({ label: z.string() });
		const validate_data: CellActionDeps['validate_data'] = (_kind, data) => {
			Labeled.parse(data);
		};
		const app = await create_cell_test_app(get_db, [], { validate_data });
		const alice = await app.create_account({ username: 'hooks_store_alice' });
		const bob = await app.create_account({ username: 'hooks_store_bob' });
		const headers = bob.create_session_headers();

		const created = await call(
			app,
			cell_create_action_spec,
			{ kind: 'note', data: { label: 'x', extra: 1 } },
			headers
		);
		assert.ok(created.ok, JSON.stringify(created));
		assert.deepEqual(created.result.cell.data, { label: 'x', extra: 1 });
		const updated = await call(
			app,
			cell_update_action_spec,
			{ cell_id: created.result.cell.id, data: { label: 'y', more: true } },
			headers
		);
		assert.ok(updated.ok, JSON.stringify(updated));
		assert.deepEqual(updated.result.cell.data, { label: 'y', more: true });
		const cloned = await call(
			app,
			cell_clone_action_spec,
			{ source_id: created.result.cell.id, with_data_patch: { label: 'z' } },
			headers
		);
		assert.ok(cloned.ok, JSON.stringify(cloned));
		assert.deepEqual(cloned.result.cell.data, { label: 'z', more: true });

		// refs are admitted on what is stored: a ref the parse would strip still
		// needs holding
		const alices = await new PgFactStore({ deps: { db: get_db() } }).put(
			new TextEncoder().encode('alice unstripped bytes'),
			{ holder: alice.actor.id }
		);
		const refused = await call(
			app,
			cell_create_action_spec,
			{ data: { label: 'x', cover: alices } },
			headers
		);
		assert.strictEqual(error_reason(refused), ERROR_CELL_REF_NOT_HELD);
	});
});
