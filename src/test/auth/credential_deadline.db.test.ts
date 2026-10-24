/**
 * The credential deadline against a real database — the remaining lifetime
 * the validation queries read on the database clock, and the deadline the
 * auth middleware sets from it (`CREDENTIAL_DEADLINE_KEY`).
 *
 * - **Session** — the earlier of the signed cookie's expiry and the row's.
 * - **API token** — the row's; none for an eternal token.
 *
 * Row expiries are written relative to the database's `NOW()`, and the
 * deadline is read against `performance.now()`, so a deadline that follows
 * the row is the DB-relative read the twin spines share.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { query_create_account_with_actor } from '#lib/auth/account_queries.ts';
import { generate_api_token } from '#lib/auth/api_token.ts';
import { query_create_api_token, query_validate_api_token } from '#lib/auth/api_token_queries.ts';
import { create_bearer_auth_middleware } from '#lib/auth/bearer_auth.ts';
import { create_request_context_middleware } from '#lib/auth/request_context.ts';
import { get_resolved_auth } from '#lib/auth/resolved_auth.ts';
import {
	SESSION_AGE_MAX,
	create_session_cookie_value,
	fuz_session_config
} from '#lib/auth/session_cookie.ts';
import { create_session_middleware } from '#lib/auth/session_middleware.ts';
import {
	generate_session_token,
	hash_session_token,
	query_create_session,
	query_session_get_valid
} from '#lib/auth/session_queries.ts';
import { token_scope_full } from '#lib/auth/token_scope.ts';
import type { Db } from '#lib/db/db.ts';

import { describe_db } from '../db_fixture.ts';
import { create_test_keyring } from './session_test_helpers.ts';

const DAY_MS = 86_400_000;

/** Slack for the clock reads between the row's `NOW()` and `performance.now()`. */
const SLACK_MS = 5000;

let account_counter = 0;

const create_account = async (db: Db): Promise<string> => {
	const { account } = await query_create_account_with_actor(
		{ db },
		{ username: `deadline_${account_counter++}`, password_hash: 'hash' }
	);
	return account.id;
};

const assert_near = (actual: number | null, expected: number, what: string): void => {
	assert.ok(
		actual !== null && actual <= expected + 50 && expected - actual <= SLACK_MS,
		`${what}: expected about ${expected}ms, got ${String(actual)}`
	);
};

const set_expiry = async (db: Db, table: string, interval: string): Promise<void> => {
	await db.query(`UPDATE ${table} SET expires_at = NOW() + INTERVAL '${interval}'`);
};

const keyring = create_test_keyring('k'.repeat(32));

/**
 * An app over the session → request-context → bearer chain whose route
 * answers how far ahead the resolved credential's deadline lies.
 */
const create_deadline_app = (db: Db): Hono => {
	const app = new Hono();
	const log = new Logger('test', { level: 'off' });
	app.use('*', async (c, next) => {
		c.set('client_ip', '127.0.0.1');
		c.set('pending_effects', []);
		await next();
	});
	app.use('*', create_session_middleware(keyring, fuz_session_config));
	app.use('*', create_request_context_middleware({ db }));
	app.use('*', create_bearer_auth_middleware({ db }, log));
	app.get('/deadline', (c) => {
		const resolved = get_resolved_auth(c);
		const deadline = resolved?.credential_deadline ?? null;
		return c.json({
			credential_type: resolved?.credential_type ?? null,
			ahead_ms: deadline === null ? null : deadline - performance.now()
		});
	});
	return app;
};

const get_deadline = async (
	app: Hono,
	headers: Record<string, string>
): Promise<{ credential_type: string | null; ahead_ms: number | null }> => {
	const res = await app.request('/deadline', { headers });
	assert.strictEqual(res.status, 200);
	return res.json();
};

describe_db('credential deadline', (get_db) => {
	test('a valid session reads its remaining lifetime on the database clock', async () => {
		const db = get_db();
		const account_id = await create_account(db);
		const token_hash = hash_session_token(generate_session_token());
		await query_create_session({ db }, token_hash, account_id, new Date(Date.now() + DAY_MS));
		await set_expiry(db, 'auth_session', '3 seconds');
		const session = await query_session_get_valid({ db }, token_hash);
		assert.ok(session);
		assert_near(session.expires_in_ms, 3000, 'session row');
	});

	test('a live token reads its remaining lifetime; an eternal one reads none', async () => {
		const db = get_db();
		const account_id = await create_account(db);
		const minted = generate_api_token();
		await query_create_api_token(
			{ db },
			minted.id,
			account_id,
			'deadline',
			minted.token_hash,
			token_scope_full(),
			null
		);
		const deps = { db, log: new Logger('test', { level: 'off' }) };
		const eternal = await query_validate_api_token(deps, minted.token, undefined, undefined);
		assert.ok(eternal);
		assert.strictEqual(eternal.expires_in_ms, null);

		await set_expiry(db, 'api_token', '36500 days');
		const far = await query_validate_api_token(deps, minted.token, undefined, undefined);
		assert_near(far?.expires_in_ms ?? null, 36_500 * DAY_MS, 'far token row');
	});

	test("a session's deadline is the earlier of its cookie and its row", async () => {
		const db = get_db();
		const app = create_deadline_app(db);
		const account_id = await create_account(db);
		const session_token = generate_session_token();
		await query_create_session(
			{ db },
			hash_session_token(session_token),
			account_id,
			new Date(Date.now() + DAY_MS)
		);
		const cookie = await create_session_cookie_value(keyring, session_token, fuz_session_config);
		const headers = { cookie: `${fuz_session_config.cookie_name}=${cookie}` };

		// the row (a day) under the cookie (30 days)
		const by_row = await get_deadline(app, headers);
		assert.strictEqual(by_row.credential_type, 'session');
		assert_near(by_row.ahead_ms, DAY_MS, 'row under cookie');

		// the cookie once the row outlives it
		await set_expiry(db, 'auth_session', '40 days');
		assert_near((await get_deadline(app, headers)).ahead_ms, SESSION_AGE_MAX * 1000, 'cookie');

		// the row again, pulled in to seconds
		await set_expiry(db, 'auth_session', '3 seconds');
		assert_near((await get_deadline(app, headers)).ahead_ms, 3000, 'shortened row');
	});

	test("a bearer's deadline is its row's, and none for an eternal token", async () => {
		const db = get_db();
		const app = create_deadline_app(db);
		const account_id = await create_account(db);
		const minted = generate_api_token();
		await query_create_api_token(
			{ db },
			minted.id,
			account_id,
			'deadline',
			minted.token_hash,
			token_scope_full(),
			null
		);
		const headers = { authorization: `Bearer ${minted.token}` };

		const eternal = await get_deadline(app, headers);
		assert.strictEqual(eternal.credential_type, 'api_token');
		assert.strictEqual(eternal.ahead_ms, null);

		await set_expiry(db, 'api_token', '3 seconds');
		assert_near((await get_deadline(app, headers)).ahead_ms, 3000, 'token row');
	});
});
