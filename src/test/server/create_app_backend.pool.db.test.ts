/**
 * `create_app_backend` over Postgres hands its audit factory the pool with the
 * audit checkout bound — a `Db` of its own over the same pool — skipped unless
 * `FUZ_TEST_POSTGRES_URL` is set, on a database of its own it creates and
 * drops. The bound itself is pinned in `src/test/db/db_pg.db.test.ts`.
 *
 * @module
 */

import { afterAll, beforeAll, describe, test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_app_backend } from '#lib/server/app_backend.ts';
import { stub_password_deps } from '#lib/testing/app_server.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import type { Db } from '#lib/db/db.ts';
import { with_database_name } from '#lib/db/postgres_url.ts';
import {
	create_test_postgres_database,
	drop_test_postgres_database,
	FUZ_TEST_POSTGRES_URL_ENV,
	TEST_DATABASE_PREFIX
} from '#lib/testing/db.ts';
import { create_test_keyring } from '../auth/session_test_helpers.ts';

const postgres_url = process.env[FUZ_TEST_POSTGRES_URL_ENV];

/** The database the backend migrates — its own, so the server's admin database stays untouched. */
const SCRATCH_DATABASE = `${TEST_DATABASE_PREFIX}app_backend_pool_${process.pid}`;

describe.skipIf(!postgres_url)('create_app_backend over Postgres', () => {
	beforeAll(async () => {
		await create_test_postgres_database(postgres_url!, SCRATCH_DATABASE);
	});

	afterAll(async () => {
		await drop_test_postgres_database(postgres_url!, SCRATCH_DATABASE);
	});

	test('the audit factory gets the pool with the audit checkout bound', async () => {
		let audit_db = null as Db | null;
		const backend = await create_app_backend({
			database_url: with_database_name(postgres_url!, SCRATCH_DATABASE),
			keyring: create_test_keyring('test-key-that-is-at-least-32-chars-long!!'),
			password: stub_password_deps,
			log: new Logger('test', { level: 'off' }),
			db_checkout_timeout_ms: 1_000,
			db_audit_checkout_timeout_ms: 5_000,
			audit_factory: ({ db, log }) => {
				audit_db = db;
				return create_audit_emitter({ db, log });
			}
		});
		try {
			assert.ok(audit_db, 'the factory ran');
			assert.notStrictEqual(audit_db, backend.deps.db, 'a Db of its own, with its own bound');
			// the same pool underneath
			const [row] = await audit_db.query<{ n: number }>('SELECT 1 AS n');
			assert.strictEqual(row?.n, 1);
		} finally {
			await backend.close();
		}
	});
});
