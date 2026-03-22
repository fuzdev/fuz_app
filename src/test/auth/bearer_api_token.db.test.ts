/**
 * Tests for backend_api_token.ts - Token generation, validation, and queries.
 *
 * @module
 */

import {describe, assert, test, vi, afterEach} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {wait} from '@fuzdev/fuz_util/async.js';

import {query_create_account, query_delete_account} from '$lib/auth/account_queries.js';
import {
	query_create_api_token,
	query_validate_api_token,
	query_revoke_api_token_for_account,
	query_api_token_list_for_account,
	query_api_token_enforce_limit,
} from '$lib/auth/api_token_queries.js';
import {generate_api_token, hash_api_token, API_TOKEN_PREFIX} from '$lib/auth/api_token.js';
import type {Db} from '$lib/db/db.js';

import {describe_db} from '../db_fixture.js';

const log = new Logger('test', {level: 'off'});

afterEach(() => {
	vi.restoreAllMocks();
});

const create_test_account = async (database: Db, username: string): Promise<string> => {
	const deps = {db: database};
	const account = await query_create_account(deps, {username, password_hash: 'hash'});
	return account.id;
};

describe('generate_api_token', () => {
	test('produces a token with the correct prefix', () => {
		const {token} = generate_api_token();
		assert.ok(token.startsWith(API_TOKEN_PREFIX));
	});

	test('produces a public id with tok_ prefix', () => {
		const {id} = generate_api_token();
		assert.ok(id.startsWith('tok_'));
	});

	test('produces a hex hash', () => {
		const {token_hash} = generate_api_token();
		assert.match(token_hash, /^[0-9a-f]{64}$/);
	});

	test('hash matches hash_api_token of the raw token', () => {
		const {token, token_hash} = generate_api_token();
		assert.strictEqual(hash_api_token(token), token_hash);
	});

	test('produces unique tokens', () => {
		const a = generate_api_token();
		const b = generate_api_token();
		assert.notStrictEqual(a.token, b.token);
		assert.notStrictEqual(a.token_hash, b.token_hash);
	});
});

describe('hash_api_token', () => {
	test('is deterministic', () => {
		const h1 = hash_api_token('same_token');
		const h2 = hash_api_token('same_token');
		assert.strictEqual(h1, h2);
	});

	test('different tokens produce different hashes', () => {
		const h1 = hash_api_token('token_a');
		const h2 = hash_api_token('token_b');
		assert.notStrictEqual(h1, h2);
	});
});

describe_db('ApiTokenQueries', (get_db) => {
	test('create stores a token record', async () => {
		const account_id = await create_test_account(get_db(), 'alice');
		const deps = {db: get_db()};
		const {id, token_hash} = generate_api_token();
		const record = await query_create_api_token(deps, id, account_id, 'CLI token', token_hash);
		assert.strictEqual(record.id, id);
		assert.strictEqual(record.account_id, account_id);
		assert.strictEqual(record.name, 'CLI token');
	});

	test('create with expiration', async () => {
		const account_id = await create_test_account(get_db(), 'bob');
		const deps = {db: get_db()};
		const {id, token_hash} = generate_api_token();
		const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
		const record = await query_create_api_token(
			deps,
			id,
			account_id,
			'CI token',
			token_hash,
			expires,
		);
		assert.ok(record.expires_at);
	});

	test('validate returns the token for a valid raw token', async () => {
		const account_id = await create_test_account(get_db(), 'charlie');
		const db = get_db();
		const deps = {db};
		const {token, id, token_hash} = generate_api_token();
		await query_create_api_token(deps, id, account_id, 'Test', token_hash);

		const found = await query_validate_api_token({db, log}, token, undefined, undefined);
		assert.ok(found);
		assert.strictEqual(found.id, id);
	});

	test('validate returns undefined for invalid token', async () => {
		const db = get_db();
		const found = await query_validate_api_token(
			{db, log},
			'secret_fuz_token_invalid',
			undefined,
			undefined,
		);
		assert.strictEqual(found, undefined);
	});

	test('validate returns undefined for expired token', async () => {
		const account_id = await create_test_account(get_db(), 'dave');
		const db = get_db();
		const deps = {db};
		const {token, id, token_hash} = generate_api_token();
		const past = new Date(Date.now() - 1000);
		await query_create_api_token(deps, id, account_id, 'Expired', token_hash, past);

		const found = await query_validate_api_token({db, log}, token, undefined, undefined);
		assert.strictEqual(found, undefined);
	});

	test('revoke deletes the token', async () => {
		const account_id = await create_test_account(get_db(), 'eve');
		const db = get_db();
		const deps = {db};
		const {token, id, token_hash} = generate_api_token();
		await query_create_api_token(deps, id, account_id, 'Revoke me', token_hash);

		assert.strictEqual(await query_revoke_api_token_for_account(deps, id, account_id), true);
		const found = await query_validate_api_token({db, log}, token, undefined, undefined);
		assert.strictEqual(found, undefined);
	});

	test('revoke returns false for missing token', async () => {
		const account_id = await create_test_account(get_db(), 'eve_missing');
		const deps = {db: get_db()};
		assert.strictEqual(
			await query_revoke_api_token_for_account(deps, 'tok_nonexistent', account_id),
			false,
		);
	});

	test('list_for_account returns tokens without hashes', async () => {
		const account_id = await create_test_account(get_db(), 'frank');
		const deps = {db: get_db()};
		const t1 = generate_api_token();
		const t2 = generate_api_token();
		await query_create_api_token(deps, t1.id, account_id, 'Token 1', t1.token_hash);
		await query_create_api_token(deps, t2.id, account_id, 'Token 2', t2.token_hash);

		const list = await query_api_token_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 2);
		for (const item of list) {
			assert.strictEqual('token_hash' in item, false);
		}
	});

	test('revoke_for_account succeeds for own token', async () => {
		const account_id = await create_test_account(get_db(), 'heidi');
		const db = get_db();
		const deps = {db};
		const {token, id, token_hash} = generate_api_token();
		await query_create_api_token(deps, id, account_id, 'Own token', token_hash);

		const revoked = await query_revoke_api_token_for_account(deps, id, account_id);
		assert.strictEqual(revoked, true);

		const found = await query_validate_api_token({db, log}, token, undefined, undefined);
		assert.strictEqual(found, undefined);
	});

	test('revoke_for_account fails for other account token', async () => {
		const alice_id = await create_test_account(get_db(), 'alice_rfa');
		const bob_id = await create_test_account(get_db(), 'bob_rfa');
		const db = get_db();
		const deps = {db};
		const {token, id, token_hash} = generate_api_token();
		await query_create_api_token(deps, id, alice_id, 'Alice token', token_hash);

		// Bob tries to revoke Alice's token
		const revoked = await query_revoke_api_token_for_account(deps, id, bob_id);
		assert.strictEqual(revoked, false);

		// Alice's token is still valid
		const found = await query_validate_api_token({db, log}, token, undefined, undefined);
		assert.ok(found);
	});

	test('tokens cascade delete with account', async () => {
		const account_id = await create_test_account(get_db(), 'grace');
		const db = get_db();
		const deps = {db};
		const {id, token_hash} = generate_api_token();
		await query_create_api_token(deps, id, account_id, 'Cascade', token_hash);

		await query_delete_account(deps, account_id);

		const list = await query_api_token_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 0);
	});

	test('enforce_token_limit returns 0 when under limit', async () => {
		const account_id = await create_test_account(get_db(), 'limit_under');
		const deps = {db: get_db()};
		const t1 = generate_api_token();
		const t2 = generate_api_token();
		await query_create_api_token(deps, t1.id, account_id, 'Token 1', t1.token_hash);
		await query_create_api_token(deps, t2.id, account_id, 'Token 2', t2.token_hash);

		const evicted = await query_api_token_enforce_limit(deps, account_id, 5);
		assert.strictEqual(evicted, 0);

		const list = await query_api_token_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 2);
	});

	test('enforce_token_limit evicts oldest when over limit', async () => {
		const account_id = await create_test_account(get_db(), 'limit_over');
		const db = get_db();
		const deps = {db};
		const base = Date.now();
		const tokens = [];
		for (const [label, offset] of [
			['oldest', 0],
			['old', 1000],
			['new', 2000],
			['newest', 3000],
		] as const) {
			const t = generate_api_token();
			tokens.push({...t, label});
			await db.query(
				`INSERT INTO api_token (id, account_id, name, token_hash, created_at) VALUES ($1, $2, $3, $4, $5)`,
				[t.id, account_id, label, t.token_hash, new Date(base + offset).toISOString()],
			);
		}

		const evicted = await query_api_token_enforce_limit(deps, account_id, 2);
		assert.strictEqual(evicted, 2);

		const list = await query_api_token_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 2);
		// newest tokens should be kept (list is newest-first)
		assert.strictEqual(list[0]!.name, 'newest');
		assert.strictEqual(list[1]!.name, 'new');
	});

	test('enforce_token_limit returns 0 at exact limit', async () => {
		const account_id = await create_test_account(get_db(), 'limit_exact');
		const deps = {db: get_db()};
		const t1 = generate_api_token();
		const t2 = generate_api_token();
		const t3 = generate_api_token();
		await query_create_api_token(deps, t1.id, account_id, 'Token 1', t1.token_hash);
		await query_create_api_token(deps, t2.id, account_id, 'Token 2', t2.token_hash);
		await query_create_api_token(deps, t3.id, account_id, 'Token 3', t3.token_hash);

		const evicted = await query_api_token_enforce_limit(deps, account_id, 3);
		assert.strictEqual(evicted, 0);

		const list = await query_api_token_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 3);
	});

	test('enforce_token_limit with max 1 keeps only newest', async () => {
		const account_id = await create_test_account(get_db(), 'limit_one');
		const db = get_db();
		const deps = {db};
		const base = Date.now();
		for (const [label, offset] of [
			['first', 0],
			['second', 1000],
			['third', 2000],
		] as const) {
			const t = generate_api_token();
			await db.query(
				`INSERT INTO api_token (id, account_id, name, token_hash, created_at) VALUES ($1, $2, $3, $4, $5)`,
				[t.id, account_id, label, t.token_hash, new Date(base + offset).toISOString()],
			);
		}

		const evicted = await query_api_token_enforce_limit(deps, account_id, 1);
		assert.strictEqual(evicted, 2);

		const list = await query_api_token_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 1);
		assert.strictEqual(list[0]!.name, 'third');
	});

	test('enforce_token_limit with max 0 evicts all tokens', async () => {
		const account_id = await create_test_account(get_db(), 'limit_zero');
		const deps = {db: get_db()};
		const t1 = generate_api_token();
		const t2 = generate_api_token();
		await query_create_api_token(deps, t1.id, account_id, 'Token 1', t1.token_hash);
		await query_create_api_token(deps, t2.id, account_id, 'Token 2', t2.token_hash);

		const evicted = await query_api_token_enforce_limit(deps, account_id, 0);
		assert.strictEqual(evicted, 2);

		const list = await query_api_token_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 0);
	});

	test('enforce_token_limit does not affect other accounts', async () => {
		const alice_id = await create_test_account(get_db(), 'limit_alice');
		const bob_id = await create_test_account(get_db(), 'limit_bob');
		const deps = {db: get_db()};
		const a1 = generate_api_token();
		const a2 = generate_api_token();
		const a3 = generate_api_token();
		const b1 = generate_api_token();
		await query_create_api_token(deps, a1.id, alice_id, 'Alice 1', a1.token_hash);
		await query_create_api_token(deps, a2.id, alice_id, 'Alice 2', a2.token_hash);
		await query_create_api_token(deps, a3.id, alice_id, 'Alice 3', a3.token_hash);
		await query_create_api_token(deps, b1.id, bob_id, 'Bob 1', b1.token_hash);

		await query_api_token_enforce_limit(deps, alice_id, 1);

		const alice_list = await query_api_token_list_for_account(deps, alice_id);
		assert.strictEqual(alice_list.length, 1);
		const bob_list = await query_api_token_list_for_account(deps, bob_id);
		assert.strictEqual(bob_list.length, 1);
	});

	test('validate logs error when usage tracking update fails', async () => {
		const account_id = await create_test_account(get_db(), 'ivan');
		const db = get_db();
		const deps = {db};
		const {token, id, token_hash} = generate_api_token();
		await query_create_api_token(deps, id, account_id, 'Test', token_hash);

		// make the fire-and-forget UPDATE fail while allowing the SELECT through
		const original_query = db.query.bind(db);
		vi.spyOn(db, 'query').mockImplementation(async (...args: Array<any>) => {
			if (typeof args[0] === 'string' && args[0].includes('UPDATE api_token')) {
				throw new Error('simulated DB failure');
			}
			return original_query(...(args as Parameters<typeof original_query>));
		});
		const spy_error = vi.spyOn(console, 'error').mockImplementation(() => {});

		const error_log = new Logger('api_token', {level: 'error'});
		const found = await query_validate_api_token({db, log: error_log}, token, undefined, undefined);
		assert.ok(found, 'validation should still succeed despite update failure');

		// wait for the fire-and-forget promise to settle
		await wait();

		assert.ok(spy_error.mock.calls.length > 0, 'console.error should have been called');
		const first_call = spy_error.mock.calls[0]!;
		assert.ok(String(first_call[0]).includes('[api_token]'), 'should log with [api_token] prefix');
	});
});
