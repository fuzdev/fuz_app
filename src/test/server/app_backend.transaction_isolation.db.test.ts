/**
 * The READ COMMITTED boot guard over each driver: `ensure_read_committed`
 * passes the default and refuses a session set to any other level on pglet and
 * PGlite, and `create_app_backend` over a Postgres database whose default is
 * REPEATABLE READ is refused before any migration runs. The Postgres half runs
 * only with `FUZ_TEST_POSTGRES_URL` (and `CREATEDB`), on a throwaway database it
 * creates and drops, so the database-level setting never reaches another
 * database on the server. Twin of the Rust spine's
 * `refuses_a_database_not_at_read_committed_before_migrating`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	create_app_backend,
	default_audit_factory,
	ensure_read_committed,
	TransactionIsolationError
} from '#lib/server/app_backend.ts';
import { create_db } from '#lib/db/create_db.ts';
import { with_database_name } from '#lib/db/postgres_url.ts';
import { create_pglite_db } from '#lib/db/db_pglite.ts';
import type { Db } from '#lib/db/db.ts';
import { stub_password_deps } from '#lib/testing/app_server.ts';
import {
	create_test_postgres_database,
	drop_test_postgres_database,
	FUZ_TEST_POSTGRES_URL_ENV,
	TEST_DATABASE_PREFIX
} from '#lib/testing/db.ts';
import { create_test_keyring } from '../auth/session_test_helpers.ts';

const REFUSED_LEVELS = ['repeatable read', 'serializable', 'read uncommitted'];

const assert_guard_on_session = async (db: Db): Promise<void> => {
	await ensure_read_committed(db);
	for (const level of REFUSED_LEVELS) {
		await db.query(`SET default_transaction_isolation = '${level}'`);
		const err = await assert_rejects(() => ensure_read_committed(db));
		assert.ok(err instanceof TransactionIsolationError, level);
		assert.strictEqual(err.found, level);
	}
	await db.query(`SET default_transaction_isolation = 'read committed'`);
	await ensure_read_committed(db);
};

describe('ensure_read_committed', () => {
	test('pglet answers the setting and the guard refuses every other level', async () => {
		const { db, close } = await create_db('memory://');
		try {
			await assert_guard_on_session(db);
		} finally {
			await close();
		}
	});

	test('PGlite answers the setting and the guard refuses every other level', async () => {
		const { PGlite } = await import('@electric-sql/pglite');
		const { db, close } = create_pglite_db(new PGlite());
		try {
			await assert_guard_on_session(db);
		} finally {
			await close();
		}
	});
});

const postgres_url = process.env[FUZ_TEST_POSTGRES_URL_ENV];

describe.skipIf(!postgres_url)('create_app_backend over Postgres', () => {
	test('a database not at read committed is refused before any migration runs', async () => {
		const scratch_name = `${TEST_DATABASE_PREFIX}isolation_guard_${process.pid}`;
		const scratch_url = with_database_name(postgres_url!, scratch_name);

		const admin = await create_db(postgres_url!);
		try {
			await create_test_postgres_database(postgres_url!, scratch_name);
			try {
				// the Postgres default passes
				{
					const probe = await create_db(scratch_url);
					try {
						await ensure_read_committed(probe.db);
					} finally {
						await probe.close();
					}
				}
				// new connections see the database-level setting
				await admin.db.query(
					`ALTER DATABASE ${scratch_name} SET default_transaction_isolation = 'repeatable read'`
				);

				const err = await assert_rejects(async () => {
					const backend = await create_app_backend({
						database_url: scratch_url,
						keyring: create_test_keyring('test-key-that-is-at-least-32-chars-long!!'),
						password: stub_password_deps,
						log: new Logger('test', { level: 'off' }),
						audit_factory: default_audit_factory
					});
					// a boot that wrongly succeeds releases its pool before the drop
					await backend.close();
				});
				assert.ok(err instanceof TransactionIsolationError, String(err));
				assert.strictEqual(err.found, 'repeatable read');

				const probe = await create_db(scratch_url);
				try {
					const [row] = await probe.db.query<{ found: string | null }>(
						`SELECT to_regclass('public.schema_version')::text AS found`
					);
					assert.strictEqual(row?.found, null, 'refused before the chain ran');
				} finally {
					await probe.close();
				}
			} finally {
				await drop_test_postgres_database(postgres_url!, scratch_name);
			}
		} finally {
			await admin.close();
		}
		// creating and dropping a database is slow beside a loaded cluster
	}, 60_000);
});
