/**
 * Integration test: session revocation blocks access.
 *
 * Closes the gap that the core auth invariant ("revoke means revoke") was
 * previously untested end-to-end through the request context middleware.
 *
 * @module
 */

import {assert, describe, test} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {Hono} from 'hono';

import {query_create_account_with_actor} from '$lib/auth/account_queries.js';
import {
	query_create_session,
	query_session_revoke_by_hash,
	query_session_revoke_all_for_account,
	generate_session_token,
	hash_session_token,
	AUTH_SESSION_LIFETIME_MS,
} from '$lib/auth/session_queries.js';
import {query_grant_permit} from '$lib/auth/permit_queries.js';
import {create_request_context_middleware, require_auth} from '$lib/auth/request_context.js';

import {ERROR_AUTHENTICATION_REQUIRED} from '$lib/http/error_schemas.js';
import {describe_db} from '../db_fixture.js';

const log = new Logger('test', {level: 'off'});

describe_db('session revoke blocks access', (get_db) => {
	test('valid session token gives access; after revoke the same token is rejected', async () => {
		const db = get_db();
		const deps = {db};

		// set up account, actor, permit, and session
		const {account, actor} = await query_create_account_with_actor(deps, {
			username: 'alice',
			password_hash: 'hash',
		});
		await query_grant_permit(deps, {actor_id: actor.id, role: 'admin', granted_by: null});

		const token = generate_session_token();
		const token_hash = hash_session_token(token);
		const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
		await query_create_session(deps, token_hash, account.id, expires);

		// build a minimal app: session token pre-set → request context middleware → require_auth guard
		const create_app = (session_token: string | null): Hono => {
			const app = new Hono();
			app.use('/*', async (c, next) => {
				if (session_token) c.set('auth_session_id', session_token);
				await next();
			});
			app.use('/*', create_request_context_middleware(deps, log));
			app.use('/*', require_auth);
			app.get('/protected', (c) => c.json({ok: true}));
			return app;
		};

		// 1. valid session → 200
		const res_before = await create_app(token).request('/protected');
		assert.strictEqual(res_before.status, 200, 'valid session should pass auth');

		// 2. revoke the session
		await query_session_revoke_by_hash(deps, token_hash);

		// 3. same token → 401
		const res_after = await create_app(token).request('/protected');
		assert.strictEqual(res_after.status, 401, 'revoked session should be rejected');

		const body = await res_after.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	describe('multi-session isolation', () => {
		test('revoking one session does not affect another session for the same account', async () => {
			const db = get_db();
			const deps = {db};

			const {account, actor} = await query_create_account_with_actor(deps, {
				username: 'bob',
				password_hash: 'hash',
			});
			await query_grant_permit(deps, {actor_id: actor.id, role: 'admin', granted_by: null});

			// Create two sessions for the same account
			const token_a = generate_session_token();
			const token_hash_a = hash_session_token(token_a);
			const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
			await query_create_session(deps, token_hash_a, account.id, expires);

			const token_b = generate_session_token();
			const token_hash_b = hash_session_token(token_b);
			await query_create_session(deps, token_hash_b, account.id, expires);

			const create_app = (session_token: string | null): Hono => {
				const app = new Hono();
				app.use('/*', async (c, next) => {
					if (session_token) c.set('auth_session_id', session_token);
					await next();
				});
				app.use('/*', create_request_context_middleware(deps, log));
				app.use('/*', require_auth);
				app.get('/protected', (c) => c.json({ok: true}));
				return app;
			};

			// Both sessions should work initially
			const res_a_before = await create_app(token_a).request('/protected');
			assert.strictEqual(res_a_before.status, 200, 'session A should pass auth');
			const res_b_before = await create_app(token_b).request('/protected');
			assert.strictEqual(res_b_before.status, 200, 'session B should pass auth');

			// Revoke session A only
			await query_session_revoke_by_hash(deps, token_hash_a);

			// Session A should be rejected
			const res_a_after = await create_app(token_a).request('/protected');
			assert.strictEqual(res_a_after.status, 401, 'revoked session A should be rejected');

			// Session B should still work
			const res_b_after = await create_app(token_b).request('/protected');
			assert.strictEqual(res_b_after.status, 200, 'session B should still pass auth');
		});
	});

	describe('revoke-all for account', () => {
		test('revoking all sessions for an account rejects every session', async () => {
			const db = get_db();
			const deps = {db};

			const {account, actor} = await query_create_account_with_actor(deps, {
				username: 'carol',
				password_hash: 'hash',
			});
			await query_grant_permit(deps, {actor_id: actor.id, role: 'admin', granted_by: null});

			const expires = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
			const tokens: Array<{raw: string; hash: string}> = [];

			// Create three sessions
			for (let i = 0; i < 3; i++) {
				const raw = generate_session_token();
				const hash = hash_session_token(raw);
				await query_create_session(deps, hash, account.id, expires);
				tokens.push({raw, hash});
			}

			const create_app = (session_token: string | null): Hono => {
				const app = new Hono();
				app.use('/*', async (c, next) => {
					if (session_token) c.set('auth_session_id', session_token);
					await next();
				});
				app.use('/*', create_request_context_middleware(deps, log));
				app.use('/*', require_auth);
				app.get('/protected', (c) => c.json({ok: true}));
				return app;
			};

			// All sessions should work initially
			for (const t of tokens) {
				const res = await create_app(t.raw).request('/protected');
				assert.strictEqual(res.status, 200, 'session should pass auth before revoke-all');
			}

			// Revoke all sessions for the account
			const revoked_count = await query_session_revoke_all_for_account(deps, account.id);
			assert.strictEqual(revoked_count, 3, 'should revoke all 3 sessions');

			// All sessions should now be rejected
			for (const t of tokens) {
				const res = await create_app(t.raw).request('/protected');
				assert.strictEqual(res.status, 401, 'session should be rejected after revoke-all');
			}
		});
	});
});
