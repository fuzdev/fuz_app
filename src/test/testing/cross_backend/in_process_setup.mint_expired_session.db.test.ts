/**
 * The in-process fixture's `mint_expired_session`: the cookie it returns
 * authenticated once and is now refused, its session row reads as a real
 * expiry leaves it (created, then expired, before the database's `NOW()`),
 * the keeper's own session lives on, and the mint waits on no timer — the
 * in-process fixture backdates the rows rather than sleeping out the
 * shortened lifetime as the cross-process one must.
 *
 * @module
 */

import { assert, test, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '#lib/auth/session_cookie.ts';
import { default_in_process_setup } from '#lib/testing/cross_backend/in_process_setup.ts';
import { EXPIRED_CREDENTIAL_WAIT_MS } from '#lib/testing/cross_backend/setup.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { SPINE_RPC_PATH } from '#lib/testing/cross_backend/spine_surface_constants.ts';

import { describe_db } from '../../auth_db_default.ts';

describe_db('in-process mint_expired_session', (get_db) => {
	test('mints a refused session of a fresh account, its row expired in order, without a wait', async () => {
		const db = get_db();
		const fixture = await default_in_process_setup({
			session_cookie_name: SESSION_COOKIE_NAME,
			create_route_specs: create_spine_route_specs,
			rpc_endpoints: spine_rpc_endpoints,
			db
		})();

		// clock-free: the cross-process fixture's wait is a timer of exactly this length
		const timers = vi.spyOn(globalThis, 'setTimeout');
		let cookie: string;
		try {
			cookie = await fixture.mint_expired_session();
			assert.notInclude(
				timers.mock.calls.map((call) => call[1]),
				EXPIRED_CREDENTIAL_WAIT_MS,
				'the mint sleeps out no lifetime'
			);
		} finally {
			timers.mockRestore();
		}
		assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=`), cookie);

		const sessions = await db.query<{ account_id: string; ordered: boolean }>(
			`SELECT account_id, created_at <= expires_at AND expires_at <= NOW() AS ordered
			 FROM auth_session WHERE account_id <> $1`,
			[fixture.account.id]
		);
		assert.ok(sessions.length > 0, 'the fresh account has a session');
		for (const session of sessions) {
			assert.strictEqual(session.ordered, true, 'created, then expired, both before NOW()');
		}

		const verify = (headers: Record<string, string>) =>
			fixture.fresh_transport()(SPINE_RPC_PATH, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify({ jsonrpc: '2.0', method: 'account_verify', id: 1 })
			});
		const { cookie: keeper_cookie } = fixture.create_session_headers();
		assert.ok(keeper_cookie);
		assert.strictEqual(
			(await verify({ cookie: keeper_cookie })).status,
			200,
			"the control: the keeper's session lives on"
		);
		assert.strictEqual(
			(await verify({ cookie })).status,
			401,
			'the expired session authenticates nothing'
		);
	});
});
