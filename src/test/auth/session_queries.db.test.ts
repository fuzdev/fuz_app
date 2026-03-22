/**
 * Tests for backend_auth_session_queries.ts - Server-side session management.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {query_create_account, query_delete_account} from '$lib/auth/account_queries.js';
import {
	query_create_session,
	query_session_get_valid,
	query_session_touch,
	query_session_revoke_by_hash,
	query_session_revoke_for_account,
	query_session_revoke_all_for_account,
	query_session_list_for_account,
	query_session_list_all_active,
	query_session_enforce_limit,
	query_session_cleanup_expired,
	hash_session_token,
	generate_session_token,
	AUTH_SESSION_LIFETIME_MS,
} from '$lib/auth/session_queries.js';
import type {Db} from '$lib/db/db.js';

import {describe_db} from '../db_fixture.js';

/** Helper to create a test account and return its id. */
const create_test_account = async (database: Db, username: string): Promise<string> => {
	const deps = {db: database};
	const account = await query_create_account(deps, {username, password_hash: 'hash'});
	return account.id;
};

describe('hash_session_token', () => {
	test('produces a hex string', () => {
		const hash = hash_session_token('test_token');
		assert.match(hash, /^[0-9a-f]{64}$/);
	});

	test('is deterministic', () => {
		const hash1 = hash_session_token('same_token');
		const hash2 = hash_session_token('same_token');
		assert.strictEqual(hash1, hash2);
	});

	test('different tokens produce different hashes', () => {
		const hash1 = hash_session_token('token_a');
		const hash2 = hash_session_token('token_b');
		assert.notStrictEqual(hash1, hash2);
	});
});

describe('generate_session_token', () => {
	test('produces a non-empty string', () => {
		const token = generate_session_token();
		assert.ok(token.length > 0);
	});

	test('produces unique tokens', () => {
		const token1 = generate_session_token();
		const token2 = generate_session_token();
		assert.notStrictEqual(token1, token2);
	});

	test('uses base64url characters', () => {
		const token = generate_session_token();
		assert.match(token, /^[A-Za-z0-9_-]+$/);
	});

	test('has sufficient entropy (at least 32 bytes worth)', () => {
		const token = generate_session_token();
		// 32 random bytes = 43 base64url chars (without padding)
		assert.ok(token.length >= 43, `token too short: ${token.length} chars (need >= 43)`);
	});

	test('generates 100 unique tokens (PRNG sanity check)', () => {
		const tokens = new Set(Array.from({length: 100}, () => generate_session_token()));
		assert.strictEqual(tokens.size, 100, 'all 100 tokens should be unique');
	});
});

describe_db('AuthSessionQueries', (get_db) => {
	test('create and get_valid returns the session', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'alice');
		const token = generate_session_token();
		const token_hash = hash_session_token(token);
		const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		await query_create_session(deps, token_hash, account_id, expires);

		const session = await query_session_get_valid(deps, token_hash);
		assert.ok(session);
		assert.strictEqual(session.id, token_hash);
		assert.strictEqual(session.account_id, account_id);
	});

	test('get_valid returns undefined for expired session', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'bob');
		const token_hash = hash_session_token('expired_token');
		const past = new Date(Date.now() - 1000);
		await query_create_session(deps, token_hash, account_id, past);

		const session = await query_session_get_valid(deps, token_hash);
		assert.strictEqual(session, undefined);
	});

	test('get_valid returns undefined for missing session', async () => {
		const db = get_db();
		const deps = {db};
		const session = await query_session_get_valid(deps, 'nonexistent_hash');
		assert.strictEqual(session, undefined);
	});

	test('revoke deletes the session', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'charlie');
		const token_hash = hash_session_token('revoke_me');
		await query_create_session(
			deps,
			token_hash,
			account_id,
			new Date(Date.now() + AUTH_SESSION_LIFETIME_MS),
		);

		await query_session_revoke_by_hash(deps, token_hash);
		const session = await query_session_get_valid(deps, token_hash);
		assert.strictEqual(session, undefined);
	});

	test('revoke_all_for_account deletes all sessions', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'dave');
		const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		await query_create_session(deps, hash_session_token('session1'), account_id, expires);
		await query_create_session(deps, hash_session_token('session2'), account_id, expires);
		await query_create_session(deps, hash_session_token('session3'), account_id, expires);

		const count = await query_session_revoke_all_for_account(deps, account_id);
		assert.strictEqual(count, 3);

		const list = await query_session_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 0);
	});

	test('list_for_account returns sessions newest first', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'eve');
		const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		await query_create_session(deps, hash_session_token('first'), account_id, expires);
		await query_create_session(deps, hash_session_token('second'), account_id, expires);

		const list = await query_session_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 2);
		// newest first
		assert.ok(new Date(list[0]!.created_at) >= new Date(list[1]!.created_at));
	});

	test('touch updates last_seen_at', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'frank');
		const token_hash = hash_session_token('touch_me');
		await query_create_session(
			deps,
			token_hash,
			account_id,
			new Date(Date.now() + AUTH_SESSION_LIFETIME_MS),
		);

		const before = await query_session_get_valid(deps, token_hash);
		assert.ok(before);

		await query_session_touch(deps, token_hash);

		const after = await query_session_get_valid(deps, token_hash);
		assert.ok(after);
		assert.ok(new Date(after.last_seen_at) >= new Date(before.last_seen_at));
	});

	test('cleanup_expired removes expired sessions', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'grace');
		const past = new Date(Date.now() - 1000);
		const future = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		await query_create_session(deps, hash_session_token('expired1'), account_id, past);
		await query_create_session(deps, hash_session_token('expired2'), account_id, past);
		await query_create_session(deps, hash_session_token('active'), account_id, future);

		const count = await query_session_cleanup_expired(deps);
		assert.strictEqual(count, 2);

		const list = await query_session_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 1);
	});

	test('revoke_for_account succeeds for own session', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'iris');
		const token_hash = hash_session_token('own_session');
		await query_create_session(
			deps,
			token_hash,
			account_id,
			new Date(Date.now() + AUTH_SESSION_LIFETIME_MS),
		);

		const revoked = await query_session_revoke_for_account(deps, token_hash, account_id);
		assert.strictEqual(revoked, true);

		const session = await query_session_get_valid(deps, token_hash);
		assert.strictEqual(session, undefined);
	});

	test('revoke_for_account fails for other account session', async () => {
		const db = get_db();
		const deps = {db};
		const alice_id = await create_test_account(db, 'alice_rfa');
		const bob_id = await create_test_account(db, 'bob_rfa');
		const token_hash = hash_session_token('alice_session');
		await query_create_session(
			deps,
			token_hash,
			alice_id,
			new Date(Date.now() + AUTH_SESSION_LIFETIME_MS),
		);

		// Bob tries to revoke Alice's session
		const revoked = await query_session_revoke_for_account(deps, token_hash, bob_id);
		assert.strictEqual(revoked, false);

		// Alice's session is still valid
		const session = await query_session_get_valid(deps, token_hash);
		assert.ok(session);
	});

	test('revoke_for_account returns false for nonexistent session', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'jack');

		const revoked = await query_session_revoke_for_account(deps, 'nonexistent_hash', account_id);
		assert.strictEqual(revoked, false);
	});

	test('sessions cascade delete with account', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'heidi');
		await query_create_session(
			deps,
			hash_session_token('cascade_me'),
			account_id,
			new Date(Date.now() + AUTH_SESSION_LIFETIME_MS),
		);

		await query_delete_account(deps, account_id);

		const list = await query_session_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 0);
	});

	test('enforce_session_limit returns 0 when under limit', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'limit_under');
		const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		await query_create_session(deps, hash_session_token('s1'), account_id, expires);
		await query_create_session(deps, hash_session_token('s2'), account_id, expires);

		const evicted = await query_session_enforce_limit(deps, account_id, 5);
		assert.strictEqual(evicted, 0);

		const list = await query_session_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 2);
	});

	test('enforce_session_limit evicts oldest when over limit', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'limit_over');
		const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS).toISOString();
		// insert with explicit created_at to ensure deterministic ordering
		const base = Date.now();
		for (const [label, offset] of [
			['oldest', 0],
			['old', 1000],
			['new', 2000],
			['newest', 3000],
		] as const) {
			await db.query(
				`INSERT INTO auth_session (id, account_id, expires_at, created_at) VALUES ($1, $2, $3, $4)`,
				[hash_session_token(label), account_id, expires, new Date(base + offset).toISOString()],
			);
		}

		const evicted = await query_session_enforce_limit(deps, account_id, 2);
		assert.strictEqual(evicted, 2);

		const list = await query_session_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 2);
		// newest sessions should be kept (list is newest-first)
		assert.strictEqual(list[0]!.id, hash_session_token('newest'));
		assert.strictEqual(list[1]!.id, hash_session_token('new'));
	});

	test('enforce_session_limit with max 1 keeps only the latest', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'limit_one');
		const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS).toISOString();
		// insert with explicit created_at to ensure deterministic ordering
		const base = Date.now();
		for (const [label, offset] of [
			['first', 0],
			['second', 1000],
			['third', 2000],
		] as const) {
			await db.query(
				`INSERT INTO auth_session (id, account_id, expires_at, created_at) VALUES ($1, $2, $3, $4)`,
				[hash_session_token(label), account_id, expires, new Date(base + offset).toISOString()],
			);
		}

		const evicted = await query_session_enforce_limit(deps, account_id, 1);
		assert.strictEqual(evicted, 2);

		const list = await query_session_list_for_account(deps, account_id);
		assert.strictEqual(list.length, 1);
		assert.strictEqual(list[0]!.id, hash_session_token('third'));
	});

	test('enforce_session_limit does not affect other accounts', async () => {
		const db = get_db();
		const deps = {db};
		const alice_id = await create_test_account(db, 'limit_alice');
		const bob_id = await create_test_account(db, 'limit_bob');
		const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		await query_create_session(deps, hash_session_token('alice_s1'), alice_id, expires);
		await query_create_session(deps, hash_session_token('alice_s2'), alice_id, expires);
		await query_create_session(deps, hash_session_token('alice_s3'), alice_id, expires);
		await query_create_session(deps, hash_session_token('bob_s1'), bob_id, expires);

		await query_session_enforce_limit(deps, alice_id, 1);

		const alice_list = await query_session_list_for_account(deps, alice_id);
		assert.strictEqual(alice_list.length, 1);
		const bob_list = await query_session_list_for_account(deps, bob_id);
		assert.strictEqual(bob_list.length, 1);
	});

	// Table-driven enforce_session_limit matrix
	const limit_cases = [
		{session_count: 0, limit: 5, expected_evictions: 0, name: 'no sessions, high limit'},
		{session_count: 1, limit: 5, expected_evictions: 0, name: 'one session under limit'},
		{session_count: 5, limit: 5, expected_evictions: 0, name: 'at exact limit'},
		{session_count: 6, limit: 5, expected_evictions: 1, name: 'one over limit'},
		{session_count: 10, limit: 3, expected_evictions: 7, name: 'many over limit'},
		{session_count: 3, limit: 0, expected_evictions: 3, name: 'limit zero evicts all'},
		{session_count: 1, limit: 1, expected_evictions: 0, name: 'single session at limit one'},
	];

	for (const {session_count, limit, expected_evictions, name} of limit_cases) {
		test(`enforce_session_limit matrix: ${name}`, async () => {
			const db = get_db();
			const deps = {db};
			const account_id = await create_test_account(db, `matrix_${name.replaceAll(' ', '_')}`);
			const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);

			for (let i = 0; i < session_count; i++) {
				const token = generate_session_token();
				const token_hash = hash_session_token(token);
				await query_create_session(deps, token_hash, account_id, expires);
			}

			const evicted = await query_session_enforce_limit(deps, account_id, limit);
			assert.strictEqual(evicted, expected_evictions);

			const remaining = await query_session_list_for_account(deps, account_id);
			assert.strictEqual(remaining.length, session_count - expected_evictions);
		});
	}

	// Table-driven revoke_for_account IDOR matrix
	const idor_cases = [
		{name: 'own session succeeds', use_own_id: true, expected: true},
		{name: 'other account fails', use_own_id: false, expected: false},
	];

	for (const {name, use_own_id, expected} of idor_cases) {
		test(`revoke_for_account IDOR: ${name}`, async () => {
			const db = get_db();
			const deps = {db};
			const owner_id = await create_test_account(db, `idor_owner_${name.replaceAll(' ', '_')}`);
			const other_id = await create_test_account(db, `idor_other_${name.replaceAll(' ', '_')}`);
			const token = generate_session_token();
			const token_hash = hash_session_token(token);
			await query_create_session(
				deps,
				token_hash,
				owner_id,
				new Date(Date.now() + AUTH_SESSION_LIFETIME_MS),
			);

			const account_id_to_use = use_own_id ? owner_id : other_id;
			const revoked = await query_session_revoke_for_account(deps, token_hash, account_id_to_use);
			assert.strictEqual(revoked, expected);

			const session = await query_session_get_valid(deps, token_hash);
			if (expected) {
				assert.strictEqual(session, undefined);
			} else {
				assert.ok(session);
			}
		});
	}

	test('enforce_session_limit counts expired sessions toward the limit', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'limit_expired');
		const past = new Date(Date.now() - 1000);
		const future = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		// 2 expired + 1 active = 3 total
		await query_create_session(deps, hash_session_token('expired_a'), account_id, past);
		await query_create_session(deps, hash_session_token('expired_b'), account_id, past);
		await query_create_session(deps, hash_session_token('active'), account_id, future);

		// max 3 — no eviction because expired sessions count toward the total
		const evicted = await query_session_enforce_limit(deps, account_id, 3);
		assert.strictEqual(evicted, 0);

		// all 3 still in the table (expired ones not cleaned up by enforce)
		const all = await db.query<{id: string}>('SELECT id FROM auth_session WHERE account_id = $1', [
			account_id,
		]);
		assert.strictEqual(all.length, 3);
	});

	test('list_all_active returns active sessions with username, excludes expired', async () => {
		const db = get_db();
		const deps = {db};
		const alice_id = await create_test_account(db, 'active_alice');
		const bob_id = await create_test_account(db, 'active_bob');
		const future = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		const past = new Date(Date.now() - 1000);

		// Alice gets an active session
		await query_create_session(deps, hash_session_token('alice_active'), alice_id, future);
		// Bob gets an expired session
		await query_create_session(deps, hash_session_token('bob_expired'), bob_id, past);

		const active_sessions = await query_session_list_all_active(deps);

		// Only Alice's active session should appear
		const alice_sessions = active_sessions.filter((s) => s.account_id === alice_id);
		assert.strictEqual(alice_sessions.length, 1);
		assert.strictEqual(alice_sessions[0]!.username, 'active_alice');

		// Bob's expired session should not appear
		const bob_sessions = active_sessions.filter((s) => s.account_id === bob_id);
		assert.strictEqual(bob_sessions.length, 0);
	});

	test('touch does not extend expiry when session has plenty of time remaining', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'touch_no_extend');
		const token_hash = hash_session_token('far_future');
		// Expires 30 days from now — well above the 1 day threshold
		const far_future = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		await query_create_session(deps, token_hash, account_id, far_future);

		const before = await query_session_get_valid(deps, token_hash);
		assert.ok(before);
		const expires_before = new Date(before.expires_at).getTime();

		await query_session_touch(deps, token_hash);

		const after = await query_session_get_valid(deps, token_hash);
		assert.ok(after);
		const expires_after = new Date(after.expires_at).getTime();

		// last_seen_at should be updated
		assert.ok(new Date(after.last_seen_at) >= new Date(before.last_seen_at));
		// expires_at should NOT change — still far in the future
		assert.strictEqual(expires_after, expires_before);
	});

	test('touch extends expiry when session expires within 1 day', async () => {
		const db = get_db();
		const deps = {db};
		const account_id = await create_test_account(db, 'touch_extend');
		const token_hash = hash_session_token('near_expiry');
		// Expires in 30 minutes — well under the 1 day threshold
		const near_expiry = new Date(Date.now() + 30 * 60 * 1000);
		await query_create_session(deps, token_hash, account_id, near_expiry);

		const before = await query_session_get_valid(deps, token_hash);
		assert.ok(before);
		const expires_before = new Date(before.expires_at).getTime();

		await query_session_touch(deps, token_hash);

		const after = await query_session_get_valid(deps, token_hash);
		assert.ok(after);
		const expires_after = new Date(after.expires_at).getTime();

		// last_seen_at should be updated
		assert.ok(new Date(after.last_seen_at) >= new Date(before.last_seen_at));
		// expires_at should be extended — it was under the 1 day threshold
		assert.ok(expires_after > expires_before);
	});
});
