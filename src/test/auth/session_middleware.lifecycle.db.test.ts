/**
 * Tests for `session_middleware.create_session_and_set_cookie` — verifies
 * cookie ↔ DB coherence and per-account session-cap enforcement against a
 * real DB via a real Hono app.
 *
 * @module
 */

import {assert, test} from 'vitest';
import {Hono} from 'hono';

import {create_session_and_set_cookie, get_session_cookie} from '$lib/auth/session_middleware.ts';
import {create_keyring, type Keyring} from '$lib/auth/keyring.ts';
import {create_session_config, parse_session} from '$lib/auth/session_cookie.ts';
import {
	hash_session_token,
	query_session_get_valid,
	query_session_list_for_account,
} from '$lib/auth/session_queries.ts';
import type {Db} from '$lib/db/db.ts';
import {create_test_account_with_actor} from '$lib/testing/db_entities.ts';

import {describe_db} from '../db_fixture.ts';
import {TEST_KEY} from './session_test_helpers.ts';

const SESSION_OPTIONS = create_session_config('test_session');

/**
 * Fire `create_session_and_set_cookie` through a real Hono app and return
 * the raw `Set-Cookie` header.
 */
const fire_create_session = async (params: {
	keyring: Keyring;
	db: Db;
	account_id: string;
	max_sessions?: number | null;
}): Promise<string> => {
	const {keyring, db, account_id, max_sessions} = params;
	const app = new Hono();
	app.post('/create', async (c) => {
		await create_session_and_set_cookie({
			keyring,
			deps: {db},
			c,
			account_id,
			session_options: SESSION_OPTIONS,
			max_sessions,
		});
		return c.json({ok: true});
	});
	const response = await app.request('/create', {method: 'POST'});
	const set_cookie = response.headers.get('set-cookie');
	assert.ok(set_cookie, 'create should set a cookie');
	return set_cookie;
};

/**
 * Round-trip the `Set-Cookie` value through Hono's `getCookie` (URL-decode)
 * + `parse_session` (signature verify) and return the embedded session token.
 */
const read_session_token = async (set_cookie: string, keyring: Keyring): Promise<string | null> => {
	const cookie_pair = set_cookie.split(';')[0]!;
	const app = new Hono();
	app.get('/token', async (c) => {
		const signed = get_session_cookie(c, SESSION_OPTIONS);
		const parsed = await parse_session(signed, keyring, SESSION_OPTIONS);
		return c.json({token: parsed?.identity ?? null});
	});
	const response = await app.request('/token', {headers: {Cookie: cookie_pair}});
	const {token} = (await response.json()) as {token: string | null};
	return token;
};

describe_db('create_session_and_set_cookie', (get_db) => {
	test('cookie verifies and decoded token hashes to a real DB session row', async () => {
		const db = get_db();
		const keyring = create_keyring(TEST_KEY)!;
		const {account} = await create_test_account_with_actor(db, {username: 'alice'});

		const set_cookie = await fire_create_session({keyring, db, account_id: account.id});
		assert.match(set_cookie, /HttpOnly/);
		assert.match(set_cookie, /Secure/);
		assert.match(set_cookie, /SameSite=Strict/);
		assert.match(set_cookie, /Path=\//);

		const token = await read_session_token(set_cookie, keyring);
		assert.ok(token, 'cookie must verify and decode via the real Hono cookie path');

		const session = await query_session_get_valid({db}, hash_session_token(token));
		assert.ok(session, 'session row must exist for hash(token in cookie)');
		assert.strictEqual(session.account_id, account.id);
	});

	test('max_sessions caps the per-account session count by evicting oldest', async () => {
		const db = get_db();
		const keyring = create_keyring(TEST_KEY)!;
		const {account} = await create_test_account_with_actor(db, {username: 'cap'});

		const tokens: Array<string> = [];
		for (let i = 0; i < 4; i++) {
			const set_cookie = await fire_create_session({
				keyring,
				db,
				account_id: account.id,
				max_sessions: 2,
			});
			const token = await read_session_token(set_cookie, keyring);
			assert.ok(token, `create #${i} must yield a verifiable token`);
			tokens.push(token);
		}

		const sessions = await query_session_list_for_account({db}, account.id);
		assert.strictEqual(sessions.length, 2, 'cap should evict to the newest 2');
		// `query_session_list_for_account` orders newest first; the two survivors
		// must be the last two creates, in that order, proving oldest-first eviction.
		assert.deepStrictEqual(
			sessions.map((s) => s.id),
			[hash_session_token(tokens[3]!), hash_session_token(tokens[2]!)],
			'survivors must be the two most-recently-created tokens',
		);
	});

	test('max_sessions: null does not enforce a cap', async () => {
		const db = get_db();
		const keyring = create_keyring(TEST_KEY)!;
		const {account} = await create_test_account_with_actor(db, {username: 'no_cap'});

		for (let i = 0; i < 5; i++) {
			await fire_create_session({keyring, db, account_id: account.id, max_sessions: null});
		}

		const sessions = await query_session_list_for_account({db}, account.id);
		assert.strictEqual(sessions.length, 5);
	});
});
