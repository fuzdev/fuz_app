/**
 * Tests for api_token_queries.ts - API token CRUD and validation.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {
	query_create_api_token,
	query_validate_api_token,
	query_revoke_all_api_tokens_for_account,
	query_revoke_api_token_for_account,
	query_api_token_list_for_account,
	query_api_token_enforce_limit,
} from '$lib/auth/api_token_queries.js';
import {generate_api_token} from '$lib/auth/api_token.js';
import {query_create_account, query_create_actor} from '$lib/auth/account_queries.js';

import {describe_db} from '../db_fixture.js';

const log = new Logger('test', {level: 'off'});

/** Create a test account and return its id. */
const setup_account = async (get_db: () => import('$lib/db/db.js').Db): Promise<string> => {
	const db = get_db();
	const deps = {db};
	const account = await query_create_account(deps, {username: 'token_user', password_hash: 'hash'});
	await query_create_actor(deps, account.id, 'token_user');
	return account.id;
};

describe_db('ApiTokenQueries', (get_db) => {
	describe('create', () => {
		test('stores a token and returns the record', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token_hash} = generate_api_token();

			const token = await query_create_api_token(deps, id, account_id, 'my-token', token_hash);

			assert.strictEqual(token.id, id);
			assert.strictEqual(token.account_id, account_id);
			assert.strictEqual(token.name, 'my-token');
			assert.strictEqual(token.token_hash, token_hash);
			assert.strictEqual(token.expires_at, null);
			assert.ok(token.created_at);
		});

		test('stores a token with expiration', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token_hash} = generate_api_token();
			const expires = new Date('2099-01-01T00:00:00Z');

			const token = await query_create_api_token(
				deps,
				id,
				account_id,
				'expiring',
				token_hash,
				expires,
			);

			assert.ok(token.expires_at);
		});
	});

	describe('validate', () => {
		test('returns the token for a valid raw token', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token, token_hash} = generate_api_token();
			await query_create_api_token(deps, id, account_id, 'valid', token_hash);

			const result = await query_validate_api_token({db, log}, token, '127.0.0.1', undefined);

			assert.ok(result);
			assert.strictEqual(result.id, id);
			assert.strictEqual(result.account_id, account_id);
		});

		test('returns undefined for unknown token', async () => {
			const db = get_db();

			const result = await query_validate_api_token(
				{db, log},
				'secret_fuz_token_unknown',
				'127.0.0.1',
				undefined,
			);

			assert.strictEqual(result, undefined);
		});

		test('returns undefined for expired token', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token, token_hash} = generate_api_token();
			const past = new Date('2000-01-01T00:00:00Z');
			await query_create_api_token(deps, id, account_id, 'expired', token_hash, past);

			const result = await query_validate_api_token({db, log}, token, '127.0.0.1', undefined);

			assert.strictEqual(result, undefined);
		});

		test('tracks usage in pending_effects', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token, token_hash} = generate_api_token();
			await query_create_api_token(deps, id, account_id, 'tracked', token_hash);

			const effects: Array<Promise<void>> = [];
			await query_validate_api_token({db, log}, token, '10.0.0.1', effects);

			assert.strictEqual(effects.length, 1);
			await Promise.all(effects);

			// Verify last_used_ip was updated
			const rows = await db.query<{last_used_ip: string | null}>(
				`SELECT last_used_ip FROM api_token WHERE id = $1`,
				[id],
			);
			assert.strictEqual(rows[0]?.last_used_ip, '10.0.0.1');
		});

		test('updates last_used_at on validate', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token, token_hash} = generate_api_token();
			await query_create_api_token(deps, id, account_id, 'usage', token_hash);

			const effects: Array<Promise<void>> = [];
			await query_validate_api_token({db, log}, token, undefined, effects);
			await Promise.all(effects);

			const rows = await db.query<{last_used_at: string | null}>(
				`SELECT last_used_at FROM api_token WHERE id = $1`,
				[id],
			);
			assert.ok(rows[0]?.last_used_at);
		});
	});

	describe('revoke', () => {
		test('deletes an existing token', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token_hash} = generate_api_token();
			await query_create_api_token(deps, id, account_id, 'doomed', token_hash);

			const result = await query_revoke_api_token_for_account(deps, id, account_id);

			assert.strictEqual(result, true);
		});

		test('returns false for non-existent token', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};

			const result = await query_revoke_api_token_for_account(deps, 'tok_nonexistent', account_id);

			assert.strictEqual(result, false);
		});

		test('revoked token cannot be validated', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token, token_hash} = generate_api_token();
			await query_create_api_token(deps, id, account_id, 'revoke-me', token_hash);
			await query_revoke_api_token_for_account(deps, id, account_id);

			const result = await query_validate_api_token({db, log}, token, '127.0.0.1', undefined);

			assert.strictEqual(result, undefined);
		});
	});

	describe('revoke_all_for_account', () => {
		test('revokes all tokens for the account', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			for (let i = 0; i < 3; i++) {
				const {id, token_hash} = generate_api_token();
				await query_create_api_token(deps, id, account_id, `token-${i}`, token_hash);
			}

			const count = await query_revoke_all_api_tokens_for_account(deps, account_id);

			assert.strictEqual(count, 3);
		});

		test('returns 0 for account with no tokens', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};

			const count = await query_revoke_all_api_tokens_for_account(deps, account_id);

			assert.strictEqual(count, 0);
		});
	});

	describe('revoke_for_account', () => {
		test('revokes token belonging to the account', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token_hash} = generate_api_token();
			await query_create_api_token(deps, id, account_id, 'mine', token_hash);

			const result = await query_revoke_api_token_for_account(deps, id, account_id);

			assert.strictEqual(result, true);
		});

		test('rejects revocation for wrong account (IDOR guard)', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token_hash} = generate_api_token();
			await query_create_api_token(deps, id, account_id, 'protected', token_hash);

			const result = await query_revoke_api_token_for_account(
				deps,
				id,
				'00000000-0000-0000-0000-000000000099',
			);

			assert.strictEqual(result, false);

			// Token should still be valid
			const listed = await query_api_token_list_for_account(deps, account_id);
			assert.strictEqual(listed.length, 1);
		});
	});

	describe('list_for_account', () => {
		test('lists tokens without token_hash', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token_hash} = generate_api_token();
			await query_create_api_token(deps, id, account_id, 'listed', token_hash);

			const tokens = await query_api_token_list_for_account(deps, account_id);

			assert.strictEqual(tokens.length, 1);
			assert.strictEqual(tokens[0]!.id, id);
			assert.strictEqual(tokens[0]!.name, 'listed');
			assert.strictEqual('token_hash' in tokens[0]!, false);
		});

		test('returns empty array for account with no tokens', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};

			const tokens = await query_api_token_list_for_account(deps, account_id);

			assert.strictEqual(tokens.length, 0);
		});

		test('returns multiple tokens', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			for (let i = 0; i < 3; i++) {
				const {id, token_hash} = generate_api_token();
				await query_create_api_token(deps, id, account_id, `token-${i}`, token_hash);
			}

			const tokens = await query_api_token_list_for_account(deps, account_id);

			assert.strictEqual(tokens.length, 3);
			const names = tokens.map((t) => t.name).sort();
			assert.deepStrictEqual(names, ['token-0', 'token-1', 'token-2']);
		});
	});

	describe('validate with ip and usage tracking', () => {
		test('sets last_used_ip and last_used_at after validation', async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};
			const {id, token, token_hash} = generate_api_token();
			await query_create_api_token(deps, id, account_id, 'ip-tracked', token_hash);

			// Verify initial state — no usage yet
			const before = await db.query<{last_used_ip: string | null; last_used_at: string | null}>(
				`SELECT last_used_ip, last_used_at FROM api_token WHERE id = $1`,
				[id],
			);
			assert.strictEqual(before[0]?.last_used_ip, null);
			assert.strictEqual(before[0]?.last_used_at, null);

			// Validate with a specific IP and flush the fire-and-forget effect
			const effects: Array<Promise<void>> = [];
			const result = await query_validate_api_token({db, log}, token, '203.0.113.42', effects);
			assert.ok(result);
			await Promise.all(effects);

			// Verify both last_used_ip and last_used_at are set
			const after = await db.query<{last_used_ip: string | null; last_used_at: string | null}>(
				`SELECT last_used_ip, last_used_at FROM api_token WHERE id = $1`,
				[id],
			);
			assert.strictEqual(after[0]?.last_used_ip, '203.0.113.42');
			assert.ok(after[0]?.last_used_at, 'last_used_at should be set after validation');
		});

		// Note: the api_token table has no user_agent / last_used_ua column.
		// Only last_used_ip and last_used_at are tracked by query_validate_api_token.
	});

	// Table-driven enforce_token_limit matrix
	const limit_cases = [
		{token_count: 0, limit: 5, expected_evictions: 0, name: 'no tokens, high limit'},
		{token_count: 1, limit: 10, expected_evictions: 0, name: 'one token under limit'},
		{token_count: 5, limit: 5, expected_evictions: 0, name: 'at exact limit'},
		{token_count: 5, limit: 2, expected_evictions: 3, name: 'evicts oldest beyond limit'},
		{token_count: 4, limit: 4, expected_evictions: 0, name: 'at exact limit (4)'},
		{token_count: 3, limit: 0, expected_evictions: 3, name: 'limit zero evicts all'},
		{token_count: 1, limit: 1, expected_evictions: 0, name: 'single token at limit one'},
	];

	for (const {token_count, limit, expected_evictions, name} of limit_cases) {
		test(`enforce_token_limit matrix: ${name}`, async () => {
			const account_id = await setup_account(get_db);
			const db = get_db();
			const deps = {db};

			for (let i = 0; i < token_count; i++) {
				const {id, token_hash} = generate_api_token();
				await query_create_api_token(deps, id, account_id, `token-${i}`, token_hash);
			}

			const evicted = await query_api_token_enforce_limit(deps, account_id, limit);
			assert.strictEqual(evicted, expected_evictions);

			const remaining = await query_api_token_list_for_account(deps, account_id);
			assert.strictEqual(remaining.length, token_count - expected_evictions);
		});
	}
});
