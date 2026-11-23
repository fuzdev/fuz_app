/**
 * The in-process fixture's `mint_expired_token`: the token it returns is
 * refused, its rows read as a real expiry leaves them (created, used, then
 * expired, all before the database's `NOW()`), and the mint waits on no
 * timer — the in-process fixture holds the database, so it backdates the rows
 * rather than sleeping out the shortened lifetime as the cross-process one
 * must.
 *
 * @module
 */

import { assert, test, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '#lib/auth/session_cookie.ts';
import { hash_api_token } from '#lib/auth/api_token.ts';
import { default_in_process_setup } from '#lib/testing/cross_backend/in_process_setup.ts';
import { EXPIRED_CREDENTIAL_WAIT_MS } from '#lib/testing/cross_backend/setup.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { SPINE_RPC_PATH } from '#lib/testing/cross_backend/spine_surface_constants.ts';

import { describe_db } from '../../auth_db_default.ts';

describe_db('in-process mint_expired_token', (get_db) => {
	test('mints a refused token, its rows expired in order, without a wait', async () => {
		const db = get_db();
		const fixture = await default_in_process_setup({
			session_cookie_name: SESSION_COOKIE_NAME,
			create_route_specs: create_spine_route_specs,
			rpc_endpoints: spine_rpc_endpoints,
			db
		})();

		// clock-free: the cross-process fixture's wait is a timer of exactly this length
		const timers = vi.spyOn(globalThis, 'setTimeout');
		let token: string;
		try {
			token = await fixture.mint_expired_token();
			assert.notInclude(
				timers.mock.calls.map((call) => call[1]),
				EXPIRED_CREDENTIAL_WAIT_MS,
				'the mint sleeps out no lifetime'
			);
		} finally {
			timers.mockRestore();
		}

		const [row] = await db.query<{
			account_id: string;
			ordered: boolean;
		}>(
			`SELECT account_id,
				created_at <= COALESCE(last_used_at, created_at)
					AND COALESCE(last_used_at, created_at) <= expires_at
					AND expires_at <= NOW() AS ordered
			 FROM api_token WHERE token_hash = $1`,
			[hash_api_token(token)]
		);
		assert.ok(row, 'the token has a row');
		assert.strictEqual(row.ordered, true, 'created, used, then expired, all before NOW()');
		const sessions = await db.query<{ ordered: boolean }>(
			`SELECT created_at <= expires_at AND expires_at <= NOW() AS ordered
			 FROM auth_session WHERE account_id = $1`,
			[row.account_id]
		);
		assert.ok(sessions.length > 0, "the token's account has sessions");
		for (const session of sessions) {
			assert.strictEqual(session.ordered, true, 'its sessions expired after their creation');
		}

		const verify = (headers: Record<string, string>) =>
			fixture.fresh_transport()(SPINE_RPC_PATH, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify({ jsonrpc: '2.0', method: 'account_verify', id: 1 })
			});
		const { authorization } = fixture.create_bearer_headers();
		assert.ok(authorization);
		assert.strictEqual(
			(await verify({ authorization })).status,
			200,
			"the control: the keeper's token"
		);
		assert.strictEqual(
			(await verify({ authorization: `Bearer ${token}` })).status,
			401,
			'the expired token authenticates nothing'
		);
	});
});
