/**
 * Cell ref admission on a database without the fact chain — a consumer that
 * mounts the cell verbs but no fact store. No `fact_holder` table means nobody
 * holds anything, so every new ref a non-admin writes is refused as unheld (a
 * 403, never a failed query), and a write with no refs is untouched. Twin of
 * the Rust `a_new_ref_is_refused_without_the_fact_chain`.
 *
 * @module
 */

import { test, assert } from 'vitest';

import { cell_create_action_spec, ERROR_CELL_REF_NOT_HELD } from '#lib/auth/cell_action_specs.ts';
import { auth_migration_ns } from '#lib/auth/migrations.ts';
import { CELL_MIGRATION_NS, CELL_DROP_TABLES } from '#lib/db/cell_ddl.ts';
import { run_migrations } from '#lib/db/migrate.ts';
import {
	auth_integration_truncate_tables,
	create_default_db_factory,
	create_describe_db
} from '#lib/testing/db.ts';
import { call, create_cell_test_app } from './cell_test_helpers.ts';
import { error_reason } from './rpc_test_helpers.ts';

const factory = create_default_db_factory(async (db) => {
	await run_migrations(db, [auth_migration_ns, CELL_MIGRATION_NS]);
});
const describe_db = create_describe_db(
	[factory],
	[...CELL_DROP_TABLES, ...auth_integration_truncate_tables]
);

describe_db('cell ref admission without the fact chain', (get_db) => {
	test('a new ref is refused; a write with no refs is untouched', async () => {
		const app = await create_cell_test_app(get_db);
		const bob = await app.create_account({ username: 'fact_less_bob' });
		const headers = bob.create_session_headers();
		const refused = await call(
			app,
			cell_create_action_spec,
			{ data: { cover: `blake3:${'e'.repeat(64)}` } },
			headers
		);
		assert.strictEqual(error_reason(refused), ERROR_CELL_REF_NOT_HELD);
		assert.ok(!refused.ok && refused.status === 403);
		const plain = await call(app, cell_create_action_spec, { data: { n: 1 } }, headers);
		assert.ok(plain.ok, JSON.stringify(plain));
	});
});
