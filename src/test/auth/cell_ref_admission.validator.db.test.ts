/**
 * Cell ref admission reads the `data` the write stores — the `validate_data`
 * output, not the wire input. A transforming validator that adds a ref (a
 * default, a normalization) is admitted on what it adds; one that strips a ref
 * from the input leaves nothing to admit. Admitting on the raw input instead
 * would let a validator-introduced ref into `cell.refs` unchecked.
 *
 * @module
 */

import { test, assert } from 'vitest';

import {
	cell_clone_action_spec,
	cell_create_action_spec,
	cell_update_action_spec,
	ERROR_CELL_REF_NOT_HELD
} from '#lib/auth/cell_action_specs.ts';
import type { CellData } from '#lib/auth/cell_data_schema.ts';
import { PgFactStore } from '#lib/db/fact_store.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { call, create_cell_test_app } from './cell_test_helpers.ts';
import { error_reason } from './rpc_test_helpers.ts';
import { describe_db } from '../cell_db_fixture.ts';

/** A well-formed hash no fact is stored under — the validator's injected default. */
const INJECTED_HASH = `blake3:${'d'.repeat(64)}`;

/**
 * Drops `strip`, and fills a missing `cover` with `INJECTED_HASH` when the
 * input asks for the default (`use_default: true`).
 */
const transforming_validator = (data: CellData): CellData => {
	const { strip: _strip, use_default, ...rest } = data;
	return use_default === true ? { cover: INJECTED_HASH, ...rest } : rest;
};

describe_db('cell ref admission on the validator output', (get_db) => {
	install_audit_drift_guard();

	const put = (bytes: string, holder: Uuid | null): Promise<string> =>
		new PgFactStore({ deps: { db: get_db() } }).put(new TextEncoder().encode(bytes), { holder });

	test('a validator-injected ref is admitted on what it injects', async () => {
		const app = await create_cell_test_app(get_db, [], { validate_data: transforming_validator });
		const bob = await app.create_account({ username: 'val_inject_bob' });
		const headers = bob.create_session_headers();
		const created = await call(
			app,
			cell_create_action_spec,
			{ data: { use_default: true } },
			headers
		);
		assert.strictEqual(error_reason(created), ERROR_CELL_REF_NOT_HELD, 'create');

		const plain = await call(app, cell_create_action_spec, { data: { n: 1 } }, headers);
		assert.ok(plain.ok, JSON.stringify(plain));
		const updated = await call(
			app,
			cell_update_action_spec,
			{ cell_id: plain.result.cell.id, data: { use_default: true } },
			headers
		);
		assert.strictEqual(error_reason(updated), ERROR_CELL_REF_NOT_HELD, 'update');
		const cloned = await call(
			app,
			cell_clone_action_spec,
			{ source_id: plain.result.cell.id, with_data_patch: { use_default: true } },
			headers
		);
		assert.strictEqual(error_reason(cloned), ERROR_CELL_REF_NOT_HELD, 'clone');
	});

	test('a ref the validator strips needs no holding and is not stored', async () => {
		const app = await create_cell_test_app(get_db, [], { validate_data: transforming_validator });
		const alice = await app.create_account({ username: 'val_strip_alice' });
		const bob = await app.create_account({ username: 'val_strip_bob' });
		const alices = await put('alice stripped bytes', alice.actor.id);
		const created = await call(
			app,
			cell_create_action_spec,
			{ data: { strip: alices, label: 'x' } },
			bob.create_session_headers()
		);
		assert.ok(created.ok, JSON.stringify(created));
		assert.strictEqual(created.result.cell.refs, null);
	});
});
