/**
 * Tests for bootstrap_account — full bootstrap flow with TOCTOU prevention.
 *
 * @module
 */

import { assert, test, beforeEach } from 'vitest';

import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import { query_role_grant_find_active_for_actor } from '#lib/auth/role_grant_queries.ts';
import {
	bootstrap_account,
	type BootstrapAccountDeps,
	type BootstrapAccountInput,
	type BootstrapAccountResult
} from '#lib/auth/bootstrap_account.ts';
import type { BootstrapTokenStore } from '#lib/auth/bootstrap_token_store.ts';
import type { BurnOutcome } from '#lib/runtime/secure_file.ts';
import { stub_password_deps, TEST_COOKIE_SECRET } from '#lib/testing/app_server.ts';
import { argon2_password_deps } from '#lib/auth/password_argon2.ts';
import { create_keyring } from '#lib/auth/keyring.ts';
import { Db } from '#lib/db/db.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import {
	ERROR_INVALID_TOKEN,
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_TOKEN_FILE_MISSING,
	ERROR_TOKEN_FILE_UNDELETABLE
} from '#lib/http/error_schemas.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { describe_db } from '../db_fixture.ts';
import { create_gated_db } from '../gated_db.ts';
import { query_role_grant_has_role } from './auth_test_queries.ts';

const log = new Logger('test', { level: 'off' });
const TEST_TOKEN = 'bootstrap_secret_token_abc123_xyz789';
const session_cookie_name = 'test_session';
const keyring_result = create_keyring(TEST_COOKIE_SECRET);
if (!keyring_result.ok) throw new Error('the test cookie secret builds a keyring');
const keyring = keyring_result.keyring;

/** An in-memory token store that models the burn: a burned token reads as missing. */
interface MockTokenStore extends BootstrapTokenStore {
	/** The file's content, `undefined` once burned or when never written. */
	content: string | undefined;
	/** What each burn saw, in order. */
	burns: Array<BurnOutcome>;
}

/** `content: null` is a store with no file. */
const create_mock_store = (
	content: string | null = TEST_TOKEN,
	options: { burn?: () => Promise<void> } = {}
): MockTokenStore => {
	const store: MockTokenStore = {
		path: '/token',
		content: content ?? undefined,
		burns: [],
		read_token: async () => {
			if (store.content === undefined) throw new Error('ENOENT: no such file: /token');
			return new TextEncoder().encode(store.content);
		},
		burn_token: async () => {
			await options.burn?.();
			const outcome: BurnOutcome = store.content === undefined ? 'already_gone' : 'burned';
			store.content = undefined;
			store.burns.push(outcome);
			return outcome;
		}
	};
	return store;
};

/**
 * `db` with every pool-level statement touching `auth_session` refused at
 * once. The bootstrap mints its session inside its transaction, so none is
 * legitimate; one written on the pool instead would wait on the
 * transaction's connection (the in-memory drivers have one) until the test
 * timed out, and stall every test after it.
 */
const refuse_pool_sessions = (db: Db): Db =>
	new Db({
		client: {
			query: async <T>(text: string, values?: Array<unknown>) => {
				if (text.includes('auth_session')) {
					throw new Error('a pool-level statement touched auth_session');
				}
				return db.client.query<T>(text, values);
			}
		},
		transaction: (fn) => db.transaction(fn)
	});

/** The deps, plus the pool `db` `run` builds the request context on. */
interface TestBootstrapDeps extends BootstrapAccountDeps {
	db: Db;
}

const create_deps = (
	db: Db,
	overrides: {
		store?: BootstrapTokenStore;
		password?: BootstrapAccountDeps['password'];
		log?: Logger;
	} = {}
): TestBootstrapDeps => ({
	log: overrides.log ?? log,
	db: refuse_pool_sessions(db),
	token_store: overrides.store ?? create_mock_store(),
	password: overrides.password ?? stub_password_deps,
	keyring,
	audit: create_audit_emitter({ db, log })
});

const INPUT: BootstrapAccountInput = { username: 'keeper', password: 'password_12_chars' };

/** `bootstrap_account` with the shared session cookie name. */
const run = (
	deps: TestBootstrapDeps,
	token: string,
	input: BootstrapAccountInput = INPUT,
	options: { session_cookie_name: string } = { session_cookie_name }
): Promise<BootstrapAccountResult> =>
	bootstrap_account(
		deps,
		{ db: deps.db, pending_effects: [], post_commit_effects: [], client_ip: '127.0.0.1' },
		token,
		input,
		options
	);

const count = async (db: Db, table: 'account' | 'auth_session'): Promise<number> => {
	const row = await db.query_one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
	return row?.n ?? 0;
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
		const result = await run(create_deps(db), TEST_TOKEN, {
			username: 'keeper',
			password: 'secure_password_12'
		});

		assert.strictEqual(result.ok, true);
		if (!result.ok) return;

		assert.strictEqual(result.account.username, 'keeper');
		assert.strictEqual(result.actor.account_id, result.account.id);
		assert.strictEqual(result.actor.name, 'keeper');

		const grants = await query_role_grant_find_active_for_actor({ db }, result.actor.id);
		assert.deepStrictEqual(grants.map((g) => g.role).sort(), [ROLE_ADMIN, ROLE_KEEPER].sort());
		for (const grant of grants) {
			assert.strictEqual(grant.actor_id, result.actor.id);
			assert.strictEqual(grant.scope_id, null);
			assert.strictEqual(grant.granted_by, null);
			assert.strictEqual(grant.expires_at, null);
		}
	});

	test('sets bootstrap_lock to true on success', async () => {
		const db = get_db();
		assert.strictEqual(await get_lock_state(db), false);

		await run(create_deps(db), TEST_TOKEN, {
			username: 'keeper',
			password: 'secure_password_12'
		});

		assert.strictEqual(await get_lock_state(db), true);
	});

	test('password is hashed (not stored in plaintext)', async () => {
		const db = get_db();
		const result = await run(create_deps(db), TEST_TOKEN, {
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
		const result = await run(create_deps(db, { password: argon2_password_deps }), TEST_TOKEN, {
			username: 'keeper',
			password: 'my_password_1234'
		});

		assert.strictEqual(result.ok, true);
		if (!result.ok) return;

		assert.ok(result.account.password_hash.startsWith('$argon2id$'));
	});

	test('burns the token file on success', async () => {
		const db = get_db();
		const store = create_mock_store();
		await run(create_deps(db, { store }), TEST_TOKEN, {
			username: 'keeper',
			password: 'password_12_chars'
		});

		assert.deepEqual(store.burns, ['burned']);
		assert.isUndefined(store.content);
	});

	test('does not burn the token file on a wrong token', async () => {
		const db = get_db();
		const store = create_mock_store();
		await run(create_deps(db, { store }), 'wrong_token', {
			username: 'keeper',
			password: 'password_12_chars'
		});

		assert.deepEqual(store.burns, []);
		assert.strictEqual(store.content, TEST_TOKEN);
	});

	test('fails when already bootstrapped (bootstrap_lock)', async () => {
		const db = get_db();
		// first bootstrap
		const first = await run(create_deps(db), TEST_TOKEN, {
			username: 'first_keeper',
			password: 'password_12_chars'
		});
		assert.strictEqual(first.ok, true);

		// second attempt with new token file
		const new_token = 'new_bootstrap_token_for_the_second_try';
		const store2 = create_mock_store(new_token);
		const result = await run(create_deps(db, { store: store2 }), new_token, {
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
		const result = await run(create_deps(db), 'wrong_token', {
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

	test('accepts a token file with one trailing LF', async () => {
		const db = get_db();
		const store = create_mock_store(`${TEST_TOKEN}\n`);
		const result = await run(create_deps(db, { store }), TEST_TOKEN, {
			username: 'keeper',
			password: 'password_12_chars'
		});
		assert.strictEqual(result.ok, true);
	});

	// the Rust twin's rule: the file's raw bytes less one optional trailing LF,
	// nothing else trimmed
	const REFUSED_TOKEN_FILES: Array<[string, string]> = [
		['CRLF', `${TEST_TOKEN}\r\n`],
		['two trailing LFs', `${TEST_TOKEN}\n\n`],
		['trailing spaces', `${TEST_TOKEN}  \n`],
		['trailing tab', `${TEST_TOKEN}\t`],
		['leading LF', `\n${TEST_TOKEN}`],
		['leading space', ` ${TEST_TOKEN}`]
	];

	test.each(REFUSED_TOKEN_FILES)('refuses a token file with %s', async (_label, content) => {
		const db = get_db();
		const store = create_mock_store(content);
		const result = await run(create_deps(db, { store }), TEST_TOKEN, {
			username: 'keeper',
			password: 'password_12_chars'
		});
		assert.strictEqual(result.ok, false);
		if (!result.ok) assert.strictEqual(result.error, ERROR_INVALID_TOKEN);
		assert.strictEqual(await get_lock_state(db), false);
		// the token file stays for a corrected attempt
		assert.deepEqual(store.burns, []);
	});

	test('refuses a provided token that carries the trailing LF the file lost', async () => {
		const db = get_db();
		const store = create_mock_store(`${TEST_TOKEN}\n`);
		const result = await run(create_deps(db, { store }), `${TEST_TOKEN}\n`, {
			username: 'keeper',
			password: 'password_12_chars'
		});
		assert.strictEqual(result.ok, false);
		if (!result.ok) assert.strictEqual(result.error, ERROR_INVALID_TOKEN);
	});

	// the minimum is 32 bytes, written out rather than derived from
	// `BOOTSTRAP_TOKEN_MIN_BYTES`, so changing the constant fails here
	const TOKEN_31_BYTES = 'k'.repeat(31);
	const TOKEN_32_BYTES = 'k'.repeat(32);

	// an empty or lone-newline file can never match, and a short one is
	// guessable — each reads as unreadable, however exactly the caller matches it
	const SHORT_TOKEN_FILES: Array<[string, string, string]> = [
		['an empty file', '', ''],
		['a lone LF', '\n', ''],
		['one byte under the minimum', TOKEN_31_BYTES, TOKEN_31_BYTES],
		['one byte under the minimum plus its LF', `${TOKEN_31_BYTES}\n`, TOKEN_31_BYTES]
	];

	test.each(SHORT_TOKEN_FILES)(
		'refuses %s as a missing token file',
		async (_label, content, provided) => {
			const db = get_db();
			const store = create_mock_store(content);
			const result = await run(create_deps(db, { store }), provided, {
				username: 'keeper',
				password: 'password_12_chars'
			});
			assert.strictEqual(result.ok, false);
			if (!result.ok) {
				assert.strictEqual(result.error, ERROR_TOKEN_FILE_MISSING);
				assert.strictEqual(result.status, 404);
			}
			assert.strictEqual(await get_lock_state(db), false);
		}
	);

	test('accepts a token at exactly the minimum length', async () => {
		const db = get_db();
		const token = TOKEN_32_BYTES;
		const store = create_mock_store(`${token}\n`);
		const result = await run(create_deps(db, { store }), token, {
			username: 'keeper',
			password: 'password_12_chars'
		});
		assert.strictEqual(result.ok, true);
	});

	test('fails when token file is missing', async () => {
		const db = get_db();
		const store = create_mock_store(null);
		const result = await run(create_deps(db, { store }), TEST_TOKEN, {
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
		const result = await run(create_deps(db), TEST_TOKEN, {
			username: 'keeper',
			password: 'password_12_chars'
		});

		assert.strictEqual(result.ok, true);
		if (!result.ok) return;

		assert.strictEqual(await query_role_grant_has_role(deps, result.actor.id, ROLE_KEEPER), true);
		assert.strictEqual(await query_role_grant_has_role(deps, result.actor.id, ROLE_ADMIN), true);
	});

	test('mints the session inside the transaction and returns its cookie line', async () => {
		const db = get_db();
		// `create_deps` refuses a pool-level session write, so a session minted
		// outside the transaction fails here at once
		const result = await run(create_deps(db), TEST_TOKEN);
		assert.ok(result.ok);
		assert.ok(result.set_cookie.startsWith('test_session='), result.set_cookie);
		const rows = await db.query<{ account_id: string }>('SELECT account_id FROM auth_session');
		assert.deepEqual(
			rows.map((r) => r.account_id),
			[result.account.id]
		);
	});

	test('a cookie line the formatter refuses rolls the bootstrap back with the token unburned', async () => {
		const db = get_db();
		const store = create_mock_store();
		// a cookie name outside RFC 6265: the session mints, its line can't be signed
		await assert_rejects(
			() =>
				run(create_deps(db, { store }), TEST_TOKEN, INPUT, {
					session_cookie_name: 'bad name'
				}),
			/cookie/i
		);
		assert.strictEqual(await get_lock_state(db), false, 'the lock rolled back');
		assert.strictEqual(await count(db, 'account'), 0, 'the account rolled back');
		assert.strictEqual(await count(db, 'auth_session'), 0, 'the session rolled back');
		assert.deepStrictEqual(store.burns, [], 'the burn never ran');
		assert.strictEqual(store.content, TEST_TOKEN, 'the token is still there');
		const rows = await db.query("SELECT id FROM audit_log WHERE event_type = 'bootstrap'");
		assert.strictEqual(rows.length, 0, 'no success row');
	});

	test('burns the token inside the transaction, after its writes', async () => {
		const gated = create_gated_db(get_db());
		let open_at_burn: number | null = null;
		const store = create_mock_store(TEST_TOKEN, {
			burn: async () => {
				open_at_burn = gated.open_transactions();
			}
		});
		const result = await run(create_deps(gated.db, { store }), TEST_TOKEN);
		assert.ok(result.ok);
		assert.strictEqual(open_at_burn, 1, 'the burn ran while the bootstrap transaction was open');
		assert.strictEqual(gated.open_transactions(), 0);
	});

	test('a failed burn rolls the bootstrap back and leaves the token valid', async () => {
		const db = get_db();
		const store = create_mock_store(TEST_TOKEN, {
			burn: async () => {
				throw new Error('EACCES: permission denied, unlink /token');
			}
		});
		const errors: Array<string> = [];
		const loud_log = new Logger('test', { level: 'off' });
		loud_log.error = (...args: Array<unknown>) => void errors.push(args.join(' '));

		const result = await run(create_deps(db, { store, log: loud_log }), TEST_TOKEN);

		assert.deepEqual(result, { ok: false, error: ERROR_TOKEN_FILE_UNDELETABLE, status: 500 });
		assert.strictEqual(await get_lock_state(db), false, 'the lock rolled back');
		assert.strictEqual(await count(db, 'account'), 0, 'the account rolled back');
		assert.strictEqual(await count(db, 'auth_session'), 0, 'the session rolled back');
		assert.strictEqual(store.content, TEST_TOKEN, 'the token is still there');
		assert.strictEqual(errors.length, 1);
		assert.include(errors[0], 'nothing was created');

		// the operator fixes the directory and retries the same token
		const retry_store = create_mock_store();
		const retry = await run(create_deps(db, { store: retry_store }), TEST_TOKEN);
		assert.ok(retry.ok, 'the retry bootstraps');
		assert.deepEqual(retry_store.burns, ['burned']);
	});

	test('a token already gone at the burn counts as burned', async () => {
		const db = get_db();
		const store = create_mock_store();
		// the file goes between the read and the burn
		const original_read = store.read_token;
		store.read_token = async () => {
			const bytes = await original_read();
			store.content = undefined;
			return bytes;
		};
		const result = await run(create_deps(db, { store }), TEST_TOKEN);
		assert.ok(result.ok);
		assert.deepEqual(store.burns, ['already_gone']);
		assert.strictEqual(await get_lock_state(db), true);
	});

	test('a failed insert burns nothing: the burn follows the inserts', async () => {
		const db = get_db();
		// the bootstrap username taken while the lock is still unflipped
		await db.query("INSERT INTO account (username, password_hash) VALUES ('keeper', 'hash')");
		const store = create_mock_store();
		await assert_rejects(() => run(create_deps(db, { store }), TEST_TOKEN));
		assert.deepEqual(store.burns, [], 'nothing was burned');
		assert.strictEqual(store.content, TEST_TOKEN, 'the token is intact');
		assert.strictEqual(await get_lock_state(db), false, 'the lock rolled back');
	});

	test('the lock-race loser burns nothing', async () => {
		const db = get_db();
		// the window open in memory, the lock already flipped in the database
		await db.query('UPDATE bootstrap_lock SET bootstrapped = true WHERE id = 1');
		const store = create_mock_store();
		const result = await run(create_deps(db, { store }), TEST_TOKEN);
		assert.deepEqual(result, { ok: false, error: ERROR_ALREADY_BOOTSTRAPPED, status: 403 });
		assert.deepEqual(store.burns, [], 'only the lock winner burns');
		assert.strictEqual(store.content, TEST_TOKEN);
		assert.strictEqual(await count(db, 'account'), 0);
	});

	test('a commit that fails after the burn throws and logs that the token is gone', async () => {
		const gated = create_gated_db(get_db());
		const store = create_mock_store();
		const errors: Array<string> = [];
		const loud_log = new Logger('test', { level: 'off' });
		loud_log.error = (...args: Array<unknown>) => void errors.push(args.join(' '));

		const hold = gated.hold_commit();
		const pending = run(create_deps(gated.db, { store, log: loud_log }), TEST_TOKEN);
		// a bootstrap that fails before its commit settles first: fail then, not at the timeout
		const reached = await Promise.race([
			hold.reached.then(() => 'held'),
			pending.then(
				() => 'settled',
				() => 'settled'
			)
		]);
		assert.strictEqual(reached, 'held', 'the bootstrap reached its commit');
		hold.fail(new Error('synthetic commit failure'));
		await assert_rejects(() => pending, /synthetic commit failure/);

		assert.deepEqual(store.burns, ['burned']);
		assert.strictEqual(await get_lock_state(get_db()), false, 'nothing committed');
		assert.strictEqual(errors.length, 1);
		assert.include(errors[0], 'write a new token');
	});

	// The belt-and-suspenders `query_account_has_any` check that previously
	// fired on the "lock reset but accounts exist" scenario was removed.
	// `bootstrap_lock` is the single signal now — both production
	// (`bootstrap_account`) and test (`bootstrap_test_keeper`) writers flip
	// it, so the divergent test/prod state that check guarded against is
	// no longer reachable from normal code paths. DB tampering is out of
	// scope for the production write contract.

	// NOTE: a concurrent bootstrap test requires multiple DB connections (real Postgres).
	// The in-memory drivers (pglet, PGlite) have one connection and run one transaction at a
	// time, so two bootstraps cannot overlap there. The sequential "fails when already
	// bootstrapped" test validates the lock works. The atomic UPDATE guarantees correctness
	// under true concurrency.
});
