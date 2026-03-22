/**
 * Tests for cross-account isolation.
 *
 * Verifies that session, token, and permit queries are properly scoped
 * to the requesting account and cannot leak data across account boundaries.
 *
 * @module
 */

import {assert, test} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {query_create_account_with_actor} from '$lib/auth/account_queries.js';
import {
	query_create_session,
	query_session_list_for_account,
	query_session_revoke_for_account,
	query_session_revoke_all_for_account,
	query_session_get_valid,
	hash_session_token,
	AUTH_SESSION_LIFETIME_MS,
} from '$lib/auth/session_queries.js';
import {
	query_create_api_token,
	query_api_token_list_for_account,
	query_revoke_api_token_for_account,
	query_revoke_all_api_tokens_for_account,
	query_validate_api_token,
} from '$lib/auth/api_token_queries.js';
import {generate_api_token} from '$lib/auth/api_token.js';
import {
	query_grant_permit,
	query_revoke_permit,
	query_permit_list_for_actor,
	query_permit_find_active_for_actor,
} from '$lib/auth/permit_queries.js';
import {query_audit_log, query_audit_log_list} from '$lib/auth/audit_log_queries.js';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import type {Db} from '$lib/db/db.js';

import {describe_db} from '../db_fixture.js';

const log = new Logger('test', {level: 'off'});

interface TestUser {
	account_id: string;
	actor_id: string;
}

const create_user = async (db: Db, username: string): Promise<TestUser> => {
	const deps = {db};
	const {account, actor} = await query_create_account_with_actor(deps, {
		username,
		password_hash: 'hash',
	});
	return {account_id: account.id, actor_id: actor.id};
};

describe_db('CrossAccountIsolation', (get_db) => {
	// -- Session isolation --

	test('session list only returns sessions for the queried account', async () => {
		const db = get_db();
		const deps = {db};
		const alice = await create_user(db, 'iso_alice');
		const bob = await create_user(db, 'iso_bob');

		const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		await query_create_session(deps, hash_session_token('alice_s1'), alice.account_id, expires);
		await query_create_session(deps, hash_session_token('alice_s2'), alice.account_id, expires);
		await query_create_session(deps, hash_session_token('bob_s1'), bob.account_id, expires);

		const alice_sessions = await query_session_list_for_account(deps, alice.account_id);
		const bob_sessions = await query_session_list_for_account(deps, bob.account_id);

		assert.strictEqual(alice_sessions.length, 2);
		assert.strictEqual(bob_sessions.length, 1);

		// verify no cross-contamination
		for (const s of alice_sessions) {
			assert.strictEqual(s.account_id, alice.account_id);
		}
		for (const s of bob_sessions) {
			assert.strictEqual(s.account_id, bob.account_id);
		}
	});

	test('session revoke_for_account rejects cross-account revocation', async () => {
		const db = get_db();
		const deps = {db};
		const alice = await create_user(db, 'iso_alice_rev');
		const bob = await create_user(db, 'iso_bob_rev');

		const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		const alice_hash = hash_session_token('alice_protected');
		await query_create_session(deps, alice_hash, alice.account_id, expires);

		// bob tries to revoke alice's session
		const revoked = await query_session_revoke_for_account(deps, alice_hash, bob.account_id);
		assert.strictEqual(revoked, false);

		// alice's session still valid
		const session = await query_session_get_valid(deps, alice_hash);
		assert.ok(session);
		assert.strictEqual(session.account_id, alice.account_id);
	});

	test('session revoke_all only affects the target account', async () => {
		const db = get_db();
		const deps = {db};
		const alice = await create_user(db, 'iso_alice_ra');
		const bob = await create_user(db, 'iso_bob_ra');

		const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		await query_create_session(deps, hash_session_token('alice_ra1'), alice.account_id, expires);
		await query_create_session(deps, hash_session_token('alice_ra2'), alice.account_id, expires);
		await query_create_session(deps, hash_session_token('bob_ra1'), bob.account_id, expires);

		const count = await query_session_revoke_all_for_account(deps, alice.account_id);
		assert.strictEqual(count, 2);

		// bob's session unaffected
		const bob_sessions = await query_session_list_for_account(deps, bob.account_id);
		assert.strictEqual(bob_sessions.length, 1);
	});

	// -- API token isolation --

	test('token list only returns tokens for the queried account', async () => {
		const db = get_db();
		const deps = {db};
		const alice = await create_user(db, 'iso_alice_tok');
		const bob = await create_user(db, 'iso_bob_tok');

		const {id: tok_a1, token_hash: h_a1} = generate_api_token();
		const {id: tok_a2, token_hash: h_a2} = generate_api_token();
		const {id: tok_b1, token_hash: h_b1} = generate_api_token();

		await query_create_api_token(deps, tok_a1, alice.account_id, 'alice-1', h_a1);
		await query_create_api_token(deps, tok_a2, alice.account_id, 'alice-2', h_a2);
		await query_create_api_token(deps, tok_b1, bob.account_id, 'bob-1', h_b1);

		const alice_tokens = await query_api_token_list_for_account(deps, alice.account_id);
		const bob_tokens = await query_api_token_list_for_account(deps, bob.account_id);

		assert.strictEqual(alice_tokens.length, 2);
		assert.strictEqual(bob_tokens.length, 1);
	});

	test('token revoke_for_account rejects cross-account revocation', async () => {
		const db = get_db();
		const deps = {db};
		const alice = await create_user(db, 'iso_alice_trev');
		const bob = await create_user(db, 'iso_bob_trev');

		const {id: tok_id, token_hash} = generate_api_token();
		await query_create_api_token(deps, tok_id, alice.account_id, 'protected', token_hash);

		// bob tries to revoke alice's token
		const revoked = await query_revoke_api_token_for_account(deps, tok_id, bob.account_id);
		assert.strictEqual(revoked, false);

		// alice's token still listed
		const tokens = await query_api_token_list_for_account(deps, alice.account_id);
		assert.strictEqual(tokens.length, 1);
	});

	test('token revoke_all only affects the target account', async () => {
		const db = get_db();
		const deps = {db};
		const alice = await create_user(db, 'iso_alice_tra');
		const bob = await create_user(db, 'iso_bob_tra');

		for (let i = 0; i < 3; i++) {
			const {id, token_hash} = generate_api_token();
			await query_create_api_token(deps, id, alice.account_id, `alice-${i}`, token_hash);
		}
		const {id: bob_tok, token_hash: bob_hash} = generate_api_token();
		await query_create_api_token(deps, bob_tok, bob.account_id, 'bob-1', bob_hash);

		const count = await query_revoke_all_api_tokens_for_account(deps, alice.account_id);
		assert.strictEqual(count, 3);

		// bob's token unaffected
		const bob_tokens = await query_api_token_list_for_account(deps, bob.account_id);
		assert.strictEqual(bob_tokens.length, 1);
	});

	test('validating a token returns the correct account_id', async () => {
		const db = get_db();
		const deps = {db};
		const alice = await create_user(db, 'iso_alice_val');
		const bob = await create_user(db, 'iso_bob_val');

		const {id: tok_a, token: raw_a, token_hash: h_a} = generate_api_token();
		const {id: tok_b, token: raw_b, token_hash: h_b} = generate_api_token();
		await query_create_api_token(deps, tok_a, alice.account_id, 'alice', h_a);
		await query_create_api_token(deps, tok_b, bob.account_id, 'bob', h_b);

		const result_a = await query_validate_api_token({db, log}, raw_a, '127.0.0.1', undefined);
		const result_b = await query_validate_api_token({db, log}, raw_b, '127.0.0.1', undefined);

		assert.ok(result_a);
		assert.ok(result_b);
		assert.strictEqual(result_a.account_id, alice.account_id);
		assert.strictEqual(result_b.account_id, bob.account_id);
		assert.notStrictEqual(result_a.account_id, result_b.account_id);
	});

	// -- Permit isolation --

	test('permit queries are actor-scoped — no cross-actor leakage', async () => {
		const db = get_db();
		const deps = {db};
		const alice = await create_user(db, 'iso_alice_perm');
		const bob = await create_user(db, 'iso_bob_perm');

		await query_grant_permit(deps, {actor_id: alice.actor_id, role: ROLE_ADMIN, granted_by: null});
		await query_grant_permit(deps, {actor_id: bob.actor_id, role: ROLE_KEEPER, granted_by: null});

		const alice_active = await query_permit_find_active_for_actor(deps, alice.actor_id);
		const bob_active = await query_permit_find_active_for_actor(deps, bob.actor_id);

		assert.strictEqual(alice_active.length, 1);
		assert.strictEqual(alice_active[0]!.role, ROLE_ADMIN);
		assert.strictEqual(bob_active.length, 1);
		assert.strictEqual(bob_active[0]!.role, ROLE_KEEPER);

		// list includes revoked too
		const alice_all = await query_permit_list_for_actor(deps, alice.actor_id);
		for (const p of alice_all) {
			assert.strictEqual(p.actor_id, alice.actor_id);
		}
	});

	// -- Audit log isolation --

	test('audit log queries are account-scoped — no cross-account metadata leakage', async () => {
		const db = get_db();
		const deps = {db};
		const alice = await create_user(db, 'iso_alice_audit');
		const bob = await create_user(db, 'iso_bob_audit');

		await query_audit_log(deps, {
			event_type: 'password_change',
			account_id: alice.account_id,
			actor_id: alice.actor_id,
			metadata: {sessions_revoked: 2},
		});
		await query_audit_log(deps, {
			event_type: 'login',
			account_id: bob.account_id,
			metadata: {username: 'iso_bob_audit'},
		});

		const alice_events = await query_audit_log_list(deps, {account_id: alice.account_id});
		const bob_events = await query_audit_log_list(deps, {account_id: bob.account_id});

		assert.strictEqual(alice_events.length, 1);
		assert.strictEqual(alice_events[0]!.event_type, 'password_change');
		assert.strictEqual(alice_events[0]!.account_id, alice.account_id);

		assert.strictEqual(bob_events.length, 1);
		assert.strictEqual(bob_events[0]!.event_type, 'login');
		assert.strictEqual(bob_events[0]!.account_id, bob.account_id);
	});

	test('audit log cross-account events appear for both actor and target', async () => {
		const db = get_db();
		const deps = {db};
		const admin = await create_user(db, 'iso_admin_audit');
		const target = await create_user(db, 'iso_target_audit');

		await query_audit_log(deps, {
			event_type: 'permit_grant',
			account_id: admin.account_id,
			actor_id: admin.actor_id,
			target_account_id: target.account_id,
			metadata: {role: 'admin', permit_id: 'test-1'},
		});

		// event visible to both admin (as actor) and target (as target)
		const admin_events = await query_audit_log_list(deps, {account_id: admin.account_id});
		const target_events = await query_audit_log_list(deps, {account_id: target.account_id});

		assert.strictEqual(admin_events.length, 1);
		assert.strictEqual(target_events.length, 1);
		// both queries return the same event
		assert.strictEqual(admin_events[0]!.id, target_events[0]!.id);
	});

	test('permit revoke with wrong actor_id returns null (IDOR guard)', async () => {
		const db = get_db();
		const deps = {db};
		const alice = await create_user(db, 'iso_alice_idor');
		const bob = await create_user(db, 'iso_bob_idor');

		const permit = await query_grant_permit(deps, {
			actor_id: alice.actor_id,
			role: ROLE_ADMIN,
			granted_by: null,
		});

		// bob's actor_id doesn't match — revoke should fail
		const result = await query_revoke_permit(deps, permit.id, bob.actor_id, bob.actor_id);
		assert.strictEqual(result, null);

		// alice's permit is still active
		const active = await query_permit_find_active_for_actor(deps, alice.actor_id);
		assert.strictEqual(active.length, 1);
		assert.strictEqual(active[0]!.id, permit.id);
	});
});
