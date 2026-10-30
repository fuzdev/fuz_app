/**
 * `create_app_backend` over Postgres hands its audit factory the pool with the
 * audit checkout bound — a `Db` of its own over the same pool — skipped unless
 * `TEST_DATABASE_URL` is set. The bound itself is pinned in
 * `src/test/db/db_pg.db.test.ts`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_app_backend } from '#lib/server/app_backend.ts';
import { stub_password_deps } from '#lib/testing/app_server.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import type { Db } from '#lib/db/db.ts';
import { create_test_keyring } from '../auth/session_test_helpers.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('create_app_backend over Postgres', () => {
	test('the audit factory gets the pool with the audit checkout bound', async () => {
		let audit_db = null as Db | null;
		const backend = await create_app_backend({
			database_url: url!,
			keyring: create_test_keyring('test-key-that-is-at-least-32-chars-long!!'),
			password: stub_password_deps,
			read_secure_file: async (path) => {
				throw new Error(`ENOENT: ${path}`);
			},
			delete_file: async () => {},
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
