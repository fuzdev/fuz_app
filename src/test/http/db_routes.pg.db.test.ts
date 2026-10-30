/**
 * The `db_routes` row DELETE's refusals on real Postgres — skipped unless
 * `TEST_DATABASE_URL` is set.
 *
 * The 404 (an id the PK type cannot hold) and 409 (a referenced row) answer
 * from a failed `DELETE`. On Postgres the failure aborts the route's
 * transaction, and the pg driver throws when its `COMMIT` comes back as a
 * `ROLLBACK` (`db/db_pg.ts`), so each refusal must leave the transaction
 * alive or it answers 500. PGlite and pglet commit or roll back silently, so
 * `db_routes.db.test.ts` on the default driver cannot see this; these cases
 * run the refusals here, inside the route's transaction and with
 * `transaction: false`.
 *
 * @module
 */

import { assert, beforeEach, test } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_db_route_specs } from '#lib/http/db_routes.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import { create_recording_audit_emitter } from '#lib/testing/audit_drift_guard.ts';
import { create_describe_db } from '#lib/testing/db.ts';
import type { Db } from '#lib/db/db.ts';

import { pg_factory } from '../db_fixture.ts';
import { create_db_routes_test_app } from './db_routes_test_helpers.ts';

const log = new Logger('test', { level: 'off' });

const audit = create_recording_audit_emitter();

/** The route specs over the suite's scratch tables, the DELETE run with `transaction` as given. */
const create_specs = (transaction: boolean): Array<RouteSpec> =>
	create_db_route_specs(
		{ audit: audit.emitter },
		{
			db_type: 'postgres',
			db_name: 'test',
			browsable_tables: ['browse_test', 'int_pk_test', 'fk_test_parent', 'fk_test_child']
		}
	).map((spec) => (spec.method === 'DELETE' ? { ...spec, transaction } : spec));

const count_rows = async (db: Db, table: string): Promise<number> => {
	const rows = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
	return parseInt(rows[0]!.count, 10);
};

const describe_pg = create_describe_db(pg_factory, []);

describe_pg('db_routes row DELETE refusals on Postgres', (get_db) => {
	beforeEach(async () => {
		const db = get_db();
		await db.query('DROP TABLE IF EXISTS fk_test_child, fk_test_parent, int_pk_test, browse_test');
		await db.query(`CREATE TABLE browse_test (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			label TEXT NOT NULL
		)`);
		await db.query(`CREATE TABLE int_pk_test (id BIGINT PRIMARY KEY, label TEXT)`);
		await db.query(`INSERT INTO int_pk_test (id, label) VALUES (7, 'kept')`);
		audit.calls.length = 0;
	});

	for (const transaction of [true, false]) {
		test(`an id the PK type cannot hold is a 404 (transaction: ${transaction})`, async () => {
			const db = get_db();
			await db.query(`INSERT INTO browse_test (label) VALUES ('kept')`);
			const app = create_db_routes_test_app(create_specs(transaction), db, log);
			for (const path of [
				// 22P02 against a uuid PK, including an injection attempt
				'/tables/browse_test/rows/not-a-uuid',
				`/tables/browse_test/rows/${encodeURIComponent("'; DROP TABLE browse_test; --")}`,
				// 22P02 and 22003 against a bigint PK
				'/tables/int_pk_test/rows/not-a-number',
				'/tables/int_pk_test/rows/99999999999999999999',
				// 22021 — a NUL byte, whatever the PK type
				'/tables/browse_test/rows/%00abc'
			]) {
				const res = await app.request(path, { method: 'DELETE' });
				assert.strictEqual(res.status, 404, path);
				assert.strictEqual((await res.json()).error, 'row_not_found', path);
			}
			assert.strictEqual(await count_rows(db, 'browse_test'), 1);
			assert.strictEqual(await count_rows(db, 'int_pk_test'), 1);
			assert.strictEqual(audit.calls.length, 0, 'a refusal emits nothing');
		});

		for (const { action, on_delete } of [
			{ action: 'RESTRICT', on_delete: ' ON DELETE RESTRICT' },
			{ action: 'NO ACTION', on_delete: '' }
		]) {
			test(`a referenced row (${action}) is a 409 (transaction: ${transaction})`, async () => {
				const db = get_db();
				await db.query(`CREATE TABLE fk_test_parent (
					id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
					name TEXT NOT NULL
				)`);
				await db.query(`CREATE TABLE fk_test_child (
					id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
					parent_id TEXT NOT NULL REFERENCES fk_test_parent(id)${on_delete}
				)`);
				const parent = await db.query<{ id: string }>(
					`INSERT INTO fk_test_parent (name) VALUES ('parent') RETURNING id`
				);
				const parent_id = parent[0]!.id;
				await db.query(`INSERT INTO fk_test_child (parent_id) VALUES ($1)`, [parent_id]);
				const app = create_db_routes_test_app(create_specs(transaction), db, log);
				const res = await app.request(`/tables/fk_test_parent/rows/${parent_id}`, {
					method: 'DELETE'
				});
				assert.strictEqual(res.status, 409);
				assert.deepStrictEqual(await res.json(), { error: 'foreign_key_violation' });
				assert.strictEqual(await count_rows(db, 'fk_test_parent'), 1);
				assert.strictEqual(audit.calls.length, 0, 'a refusal emits nothing');
			});
		}

		test(`a delete commits and is audited (transaction: ${transaction})`, async () => {
			const db = get_db();
			const inserted = await db.query<{ id: string }>(
				`INSERT INTO browse_test (label) VALUES ('gone') RETURNING id`
			);
			const app = create_db_routes_test_app(create_specs(transaction), db, log);
			const res = await app.request(`/tables/browse_test/rows/${inserted[0]!.id}`, {
				method: 'DELETE'
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(await count_rows(db, 'browse_test'), 0);
			assert.strictEqual(audit.calls.length, 1);
		});
	}
});
