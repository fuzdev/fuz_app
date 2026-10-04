/**
 * Tests for `revalidate_resolved_auth` — the credential re-read a long-lived
 * connection runs once it is registered.
 *
 * Each case resolves a credential the way the middleware does (a real session
 * or token row on a real account), applies one revocation shape to the
 * database, and asserts what the re-read answers. The control cases assert
 * the same credential re-validates when nothing touched it, so a refusal is
 * the revocation's doing.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	query_account_soft_delete,
	query_create_account_with_actor
} from '$lib/auth/account_queries.ts';
import { generate_api_token } from '$lib/auth/api_token.ts';
import {
	query_api_token_live_account,
	query_create_api_token,
	query_revoke_all_api_tokens_for_account,
	query_revoke_api_token_for_account
} from '$lib/auth/api_token_queries.ts';
import { revalidate_resolved_auth, type ResolvedAuth } from '$lib/auth/resolved_auth.ts';
import {
	generate_session_token,
	hash_session_token,
	query_create_session,
	query_session_revoke_all_for_account,
	query_session_revoke_for_account
} from '$lib/auth/session_queries.ts';
import { token_scope_full } from '$lib/auth/token_scope.ts';
import { Db } from '$lib/db/db.ts';

import { describe_db } from '../db_fixture.ts';

const HOUR_MS = 60 * 60 * 1000;

let account_counter = 0;

const create_account = async (db: Db): Promise<string> => {
	const { account } = await query_create_account_with_actor(
		{ db },
		{ username: `revalidate_${account_counter++}`, password_hash: 'hash' }
	);
	return account.id;
};

/** A live session row on `account_id`, as the session middleware resolves it. */
const resolve_session = async (
	db: Db,
	account_id: string,
	expires_at = new Date(Date.now() + HOUR_MS)
): Promise<ResolvedAuth & { token_hash: string }> => {
	const token_hash = hash_session_token(generate_session_token());
	await query_create_session({ db }, token_hash, account_id, expires_at);
	return { account_id, credential_type: 'session', token_hash, api_token_id: null };
};

/** A live API token row on `account_id`, as the bearer middleware resolves it. */
const resolve_api_token = async (
	db: Db,
	account_id: string,
	expires_at: Date | null = null
): Promise<ResolvedAuth & { api_token_id: string }> => {
	const { id, token_hash } = generate_api_token();
	await query_create_api_token(
		{ db },
		id,
		account_id,
		'revalidate',
		token_hash,
		token_scope_full(),
		expires_at
	);
	return { account_id, credential_type: 'api_token', token_hash: null, api_token_id: id };
};

const resolve_daemon_token = (account_id: string): ResolvedAuth => ({
	account_id,
	credential_type: 'daemon_token',
	token_hash: null,
	api_token_id: null
});

describe_db('revalidate_resolved_auth', (get_db) => {
	describe('session', () => {
		test('a live session revalidates', async () => {
			const db = get_db();
			const resolved = await resolve_session(db, await create_account(db));

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), true);
		});

		test('a revoked session does not revalidate', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const resolved = await resolve_session(db, account_id);

			assert.ok(await query_session_revoke_for_account({ db }, resolved.token_hash, account_id));

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), false);
		});

		test('an expired session does not revalidate', async () => {
			const db = get_db();
			const resolved = await resolve_session(db, await create_account(db));

			await db.query(`UPDATE auth_session SET expires_at = NOW() - INTERVAL '1 second'`);

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), false);
		});

		test('a session now owned by another account does not revalidate', async () => {
			const db = get_db();
			const resolved = await resolve_session(db, await create_account(db));
			const other_account_id = await create_account(db);

			await db.query(`UPDATE auth_session SET account_id = $1 WHERE id = $2`, [
				other_account_id,
				resolved.token_hash
			]);

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), false);
		});

		test('revoking another session leaves this one valid', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const resolved = await resolve_session(db, account_id);
			const other = await resolve_session(db, account_id);

			assert.ok(await query_session_revoke_for_account({ db }, other.token_hash, account_id));

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), true);
			assert.strictEqual(await revalidate_resolved_auth({ db }, other), false);
		});

		test('a session with no token hash is a shape that never revalidates', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			await resolve_session(db, account_id);

			assert.strictEqual(
				await revalidate_resolved_auth(
					{ db },
					{ account_id, credential_type: 'session', token_hash: null, api_token_id: null }
				),
				false
			);
		});
	});

	describe('api token', () => {
		test('a live api token revalidates', async () => {
			const db = get_db();
			const resolved = await resolve_api_token(db, await create_account(db));

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), true);
		});

		test('an unexpired ttl token revalidates', async () => {
			const db = get_db();
			const resolved = await resolve_api_token(
				db,
				await create_account(db),
				new Date(Date.now() + HOUR_MS)
			);

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), true);
		});

		test('a revoked api token does not revalidate', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const resolved = await resolve_api_token(db, account_id);
			const other = await resolve_api_token(db, account_id);

			assert.ok(
				await query_revoke_api_token_for_account({ db }, resolved.api_token_id, account_id)
			);

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), false);
			assert.strictEqual(
				await revalidate_resolved_auth({ db }, other),
				true,
				'revoking one token leaves the other valid'
			);
		});

		test('an expired api token does not revalidate', async () => {
			const db = get_db();
			const resolved = await resolve_api_token(db, await create_account(db));

			await db.query(`UPDATE api_token SET expires_at = NOW() - INTERVAL '1 second'`);

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), false);
			assert.strictEqual(
				await query_api_token_live_account({ db }, resolved.api_token_id),
				undefined,
				'the by-id read applies the same liveness predicate as the validate read'
			);
		});

		test('an api token now owned by another account does not revalidate', async () => {
			const db = get_db();
			const resolved = await resolve_api_token(db, await create_account(db));
			const other_account_id = await create_account(db);

			await db.query(`UPDATE api_token SET account_id = $1 WHERE id = $2`, [
				other_account_id,
				resolved.api_token_id
			]);

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), false);
			assert.strictEqual(
				await query_api_token_live_account({ db }, resolved.api_token_id),
				other_account_id
			);
		});

		test('an api token with no id is a shape that never revalidates', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			await resolve_api_token(db, account_id);

			assert.strictEqual(
				await revalidate_resolved_auth(
					{ db },
					{ account_id, credential_type: 'api_token', token_hash: null, api_token_id: null }
				),
				false
			);
		});
	});

	describe('account-wide revocations', () => {
		test('a password change invalidates sessions and tokens', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await resolve_session(db, account_id);
			const token = await resolve_api_token(db, account_id);

			// what the `/password` route does once the new hash is stored
			await query_session_revoke_all_for_account({ db }, account_id);
			await query_revoke_all_api_tokens_for_account({ db }, account_id);

			assert.strictEqual(await revalidate_resolved_auth({ db }, session), false);
			assert.strictEqual(await revalidate_resolved_auth({ db }, token), false);
		});

		test('a soft-deleted account invalidates every credential, rows intact', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await resolve_session(db, account_id);
			const token = await resolve_api_token(db, account_id);
			const daemon = resolve_daemon_token(account_id);
			for (const resolved of [session, token, daemon]) {
				assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), true);
			}

			// the tombstone alone — the session and token rows are still there
			assert.ok(await query_account_soft_delete({ db }, account_id, null));

			for (const resolved of [session, token, daemon]) {
				assert.strictEqual(
					await revalidate_resolved_auth({ db }, resolved),
					false,
					`${resolved.credential_type} on a soft-deleted account`
				);
			}
		});
	});

	describe('daemon token', () => {
		test('a daemon token revalidates on its keeper account alone', async () => {
			const db = get_db();
			const account_id = await create_account(db);

			assert.strictEqual(
				await revalidate_resolved_auth({ db }, resolve_daemon_token(account_id)),
				true
			);
		});

		test('a daemon token on an account that is gone does not revalidate', async () => {
			const db = get_db();

			assert.strictEqual(
				await revalidate_resolved_auth(
					{ db },
					resolve_daemon_token('00000000-0000-4000-8000-000000000000')
				),
				false
			);
		});
	});

	describe('no side effects', () => {
		test('the re-check does not touch the api token', async () => {
			const db = get_db();
			const resolved = await resolve_api_token(db, await create_account(db));

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), true);

			const row = await db.query_one<{ last_used_at: unknown; last_used_ip: unknown }>(
				`SELECT last_used_at, last_used_ip FROM api_token WHERE id = $1`,
				[resolved.api_token_id]
			);
			assert.deepStrictEqual(row, { last_used_at: null, last_used_ip: null });
		});

		test('the re-check leaves the session row unchanged', async () => {
			const db = get_db();
			const resolved = await resolve_session(db, await create_account(db));
			const read_row = (): Promise<unknown> =>
				db.query_one(
					`SELECT id, account_id, expires_at::text, created_at::text FROM auth_session WHERE id = $1`,
					[resolved.token_hash]
				);
			const before = await read_row();

			assert.strictEqual(await revalidate_resolved_auth({ db }, resolved), true);

			assert.deepStrictEqual(await read_row(), before);
		});

		test('the re-check writes nothing — every statement is a read', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await resolve_session(db, account_id);
			const token = await resolve_api_token(db, account_id);
			const statements: Array<string> = [];
			const recording = new Db({
				client: {
					query: (text, values) => {
						statements.push(text);
						return db.client.query(text, values);
					}
				},
				transaction: (fn) => db.transaction(fn)
			});

			for (const resolved of [session, token, resolve_daemon_token(account_id)]) {
				assert.strictEqual(await revalidate_resolved_auth({ db: recording }, resolved), true);
			}

			assert.ok(statements.length > 0);
			for (const statement of statements) {
				assert.match(statement.trim(), /^SELECT\b/, statement);
			}
		});
	});

	describe('failure', () => {
		test('a failing query propagates — the caller fails closed', async () => {
			const db = get_db();
			const resolved = await resolve_session(db, await create_account(db));
			const failing = new Db({
				client: {
					query: () => Promise.reject(new Error('connection lost'))
				},
				transaction: (fn) => db.transaction(fn)
			});

			const error = await assert_rejects(() => revalidate_resolved_auth({ db: failing }, resolved));
			assert.match(error.message, /connection lost/);
		});
	});
});
