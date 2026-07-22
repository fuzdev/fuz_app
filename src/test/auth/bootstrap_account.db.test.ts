/**
 * Tests for bootstrap_account — full bootstrap flow with TOCTOU prevention.
 *
 * @module
 */

import { assert, test, beforeEach } from 'vitest';

import { ROLE_ADMIN, ROLE_KEEPER } from '$lib/auth/role_schema.ts';
import { query_role_grant_has_role } from '$lib/auth/role_grant_queries.ts';
import { bootstrap_account, type BootstrapAccountDeps } from '$lib/auth/bootstrap_account.ts';
import { stub_password_deps } from '$lib/testing/app_server.ts';
import { argon2_password_deps } from '$lib/auth/password_argon2.ts';
import type { Db } from '$lib/db/db.ts';
import {
	ERROR_INVALID_TOKEN,
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_TOKEN_FILE_MISSING
} from '$lib/http/error_schemas.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { describe_db } from '../db_fixture.ts';

const log = new Logger('test', { level: 'off' });
const TEST_TOKEN = 'bootstrap_secret_token_abc123';

const create_mock_fs = (
	files: Record<string, string> = {}
): {
	read_text_file: (path: string) => Promise<string>;
	delete_file: (path: string) => Promise<void>;
	files: Record<string, string>;
} => {
	const store = { ...files };
	return {
		files: store,
		read_text_file: async (path: string): Promise<string> => {
			if (!(path in store)) throw new Error(`ENOENT: no such file: ${path}`);
			return store[path]!;
		},
		delete_file: async (path: string): Promise<void> => {
			if (!(path in store)) throw new Error(`ENOENT: no such file: ${path}`);
			delete store[path];
		}
	};
};

const create_deps = (
	db: Db,
	overrides: {
		fs?: ReturnType<typeof create_mock_fs>;
		password?: BootstrapAccountDeps['password'];
		token_path?: string;
	} = {}
): BootstrapAccountDeps => {
	const fs = overrides.fs ?? create_mock_fs({ '/token': TEST_TOKEN });
	return {
		log,
		db,
		token_path: overrides.token_path ?? '/token',
		read_text_file: fs.read_text_file,
		delete_file: fs.delete_file,
		password: overrides.password ?? stub_password_deps
	};
};

/** Check the bootstrap_lock state in the DB. */
const get_lock_state = async (db: Db): Promise<boolean> => {
	const row = await db.query_one<{ bootstrapped: boolean }>(
		'SELECT bootstrapped FROM bootstrap_lock WHERE id = 1'
	);
	return row?.bootstrapped ?? false;
};

describe_db('bootstrap_account', (get_db) => {
	// reset bootstrap_lock between tests (single-row latch, not truncated by generic fixture)
	beforeEach(async () => {
		await get_db().query('UPDATE bootstrap_lock SET bootstrapped = false WHERE id = 1');
	});

	test('creates account, actor, and keeper + admin role_grants', async () => {
		const db = get_db();
		const result = await bootstrap_account(create_deps(db), TEST_TOKEN, {
			username: 'keeper',
			password: 'secure_password_12'
		});

		assert.strictEqual(result.ok, true);
		if (!result.ok) return;

		assert.strictEqual(result.account.username, 'keeper');
		assert.strictEqual(result.actor.account_id, result.account.id);
		assert.strictEqual(result.actor.name, 'keeper');

		const { keeper, admin } = result.role_grants;
		assert.strictEqual(keeper.role, ROLE_KEEPER);
		assert.strictEqual(keeper.actor_id, result.actor.id);
		assert.strictEqual(keeper.granted_by, null);
		assert.strictEqual(keeper.expires_at, null);
		assert.strictEqual(admin.role, ROLE_ADMIN);
		assert.strictEqual(admin.actor_id, result.actor.id);
		assert.strictEqual(admin.granted_by, null);
		assert.strictEqual(admin.expires_at, null);
	});

	test('sets bootstrap_lock to true on success', async () => {
		const db = get_db();
		assert.strictEqual(await get_lock_state(db), false);

		await bootstrap_account(create_deps(db), TEST_TOKEN, {
			username: 'keeper',
			password: 'secure_password_12'
		});

		assert.strictEqual(await get_lock_state(db), true);
	});

	test('password is hashed (not stored in plaintext)', async () => {
		const db = get_db();
		const result = await bootstrap_account(create_deps(db), TEST_TOKEN, {
			username: 'keeper',
			password: 'my_password_1234'
		});

		assert.strictEqual(result.ok, true);
		if (!result.ok) return;

		assert.notStrictEqual(result.account.password_hash, 'my_password_1234');
		assert.ok(result.account.password_hash.startsWith('stub_hash_'));
	});

	test('password is hashed with argon2 when using argon2_password_deps', async () => {
		const db = get_db();
		const result = await bootstrap_account(
			create_deps(db, { password: argon2_password_deps }),
			TEST_TOKEN,
			{ username: 'keeper', password: 'my_password_1234' }
		);

		assert.strictEqual(result.ok, true);
		if (!result.ok) return;

		assert.ok(result.account.password_hash.startsWith('$argon2id$'));
	});

	test('deletes the token file on success', async () => {
		const db = get_db();
		const fs = create_mock_fs({ '/token': TEST_TOKEN });
		await bootstrap_account(create_deps(db, { fs }), TEST_TOKEN, {
			username: 'keeper',
			password: 'password_12_chars'
		});

		assert.strictEqual('/token' in fs.files, false);
	});

	test('does not delete the token file on failure', async () => {
		const db = get_db();
		const fs = create_mock_fs({ '/token': TEST_TOKEN });
		await bootstrap_account(create_deps(db, { fs }), 'wrong_token', {
			username: 'keeper',
			password: 'password_12_chars'
		});

		assert.strictEqual('/token' in fs.files, true);
	});

	test('fails when already bootstrapped (bootstrap_lock)', async () => {
		const db = get_db();
		// first bootstrap
		const first = await bootstrap_account(create_deps(db), TEST_TOKEN, {
			username: 'first_keeper',
			password: 'password_12_chars'
		});
		assert.strictEqual(first.ok, true);

		// second attempt with new token file
		const fs2 = create_mock_fs({ '/token': 'new_token' });
		const result = await bootstrap_account(create_deps(db, { fs: fs2 }), 'new_token', {
			username: 'second_keeper',
			password: 'password_12_chars'
		});

		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.error, ERROR_ALREADY_BOOTSTRAPPED);
			assert.strictEqual(result.status, 403);
		}
	});

	test('fails with invalid token', async () => {
		const db = get_db();
		const result = await bootstrap_account(create_deps(db), 'wrong_token', {
			username: 'keeper',
			password: 'password_12_chars'
		});

		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.error, ERROR_INVALID_TOKEN);
			assert.strictEqual(result.status, 401);
		}

		// lock should not have been acquired
		assert.strictEqual(await get_lock_state(db), false);
	});

	test('fails when token file is missing', async () => {
		const db = get_db();
		const fs = create_mock_fs({});
		const result = await bootstrap_account(create_deps(db, { fs }), TEST_TOKEN, {
			username: 'keeper',
			password: 'password_12_chars'
		});

		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.error, ERROR_TOKEN_FILE_MISSING);
			assert.strictEqual(result.status, 404);
		}

		// lock should not have been acquired
		assert.strictEqual(await get_lock_state(db), false);
	});

	test('both role_grants are verifiable via query_role_grant_has_role', async () => {
		const db = get_db();
		const deps = { db };
		const result = await bootstrap_account(create_deps(db), TEST_TOKEN, {
			username: 'keeper',
			password: 'password_12_chars'
		});

		assert.strictEqual(result.ok, true);
		if (!result.ok) return;

		assert.strictEqual(await query_role_grant_has_role(deps, result.actor.id, ROLE_KEEPER), true);
		assert.strictEqual(await query_role_grant_has_role(deps, result.actor.id, ROLE_ADMIN), true);
	});

	test('returns token_file_deleted: true on successful file deletion', async () => {
		const db = get_db();
		const result = await bootstrap_account(create_deps(db), TEST_TOKEN, {
			username: 'keeper',
			password: 'password_12_chars'
		});

		assert.strictEqual(result.ok, true);
		if (!result.ok) return;
		assert.strictEqual(result.token_file_deleted, true);
	});

	test('returns token_file_deleted: false when file deletion fails', async () => {
		const db = get_db();
		const fs = create_mock_fs({ '/token': TEST_TOKEN });
		const result = await bootstrap_account(
			{
				log,
				db,
				token_path: '/token',
				read_text_file: fs.read_text_file,
				delete_file: async () => {
					throw new Error('EPERM: permission denied');
				},
				password: stub_password_deps
			},
			TEST_TOKEN,
			{ username: 'keeper', password: 'password_12_chars' }
		);

		assert.strictEqual(result.ok, true);
		if (!result.ok) return;
		assert.strictEqual(result.token_file_deleted, false);
		// DB state is correct despite file deletion failure
		assert.strictEqual(await get_lock_state(db), true);
		assert.strictEqual(result.account.username, 'keeper');
	});

	// The belt-and-suspenders `query_account_has_any` check that previously
	// fired on the "lock reset but accounts exist" scenario was removed.
	// `bootstrap_lock` is the single signal now — both production
	// (`bootstrap_account`) and test (`bootstrap_test_keeper`) writers flip
	// it, so the divergent test/prod state that check guarded against is
	// no longer reachable from normal code paths. DB tampering is out of
	// scope for the production write contract.

	// NOTE: concurrent bootstrap test requires multiple DB connections (real Postgres).
	// PGlite is single-connection — concurrent transactions interleave on the same connection,
	// breaking transaction boundaries. The sequential "fails when already bootstrapped" test
	// validates the lock works. The atomic UPDATE guarantees correctness under true concurrency.
});
