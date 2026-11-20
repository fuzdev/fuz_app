/**
 * A session cookie line rides only a response whose writes committed: a
 * login or signup whose `COMMIT` fails answers its 500 minting nothing, and a
 * logout whose commit or in-transaction audit insert fails answers clearing
 * nothing — the session it would have ended is still live. The stale-cookie clear the
 * session middleware owes is unaffected: it reads the request, not the
 * outcome.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_account_route_specs } from '#lib/auth/account_routes.ts';
import { create_signup_route_specs } from '#lib/auth/signup_routes.ts';
import { query_app_settings_update } from '#lib/auth/app_settings_queries.ts';
import { define_route, prefix_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import { route_ok } from '#lib/http/route_result.ts';
import { literal, loose_object } from '@fuzdev/fuz_schema/schema.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import { create_test_app, type TestApp } from '#lib/testing/app_server.ts';
import { create_test_request_headers } from '#lib/testing/test_origin.ts';
import { DEFAULT_TEST_PASSWORD } from '#lib/testing/test_credentials.ts';
import { reset_audit_write_failures } from '#lib/auth/audit_emitter.ts';

import { describe_db } from '../auth_db_default.ts';
import { create_gated_db, is_audit_insert, type GatedDb } from '../gated_db.ts';

const session_options = create_session_config('test_session');
const CLEAR = 'test_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
const STALE = 'test_session=stale.invalidsignature';

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	// a success carrying a cookie from inside the route's own transaction
	define_route({
		method: 'POST',
		path: '/api/cookie_in_route_transaction',
		auth: { account: 'none', actor: 'none' },
		description: 'Write a row and answer a cookie',
		input: literal(null),
		output: loose_object({}),
		handler: async (route) => {
			await route.db.query('SELECT 1');
			return route_ok({}, { set_cookie: ['minted=1; Path=/'] });
		}
	}),
	...prefix_route_specs('/api/account', [
		...create_account_route_specs(ctx.deps, {
			session_options,
			login_ip_rate_limiter: null,
			login_account_rate_limiter: null,
			login_fail_floor_ms: 0
		}),
		...create_signup_route_specs(ctx.deps, {
			session_options,
			signup_ip_rate_limiter: null,
			signup_account_rate_limiter: null,
			signup_fail_floor_ms: 0
		})
	])
];

const post = async (
	test_app: TestApp,
	path: string,
	body: unknown,
	headers?: Record<string, string>
): Promise<Response> =>
	test_app.app.request(path, {
		method: 'POST',
		headers: create_test_request_headers({ 'content-type': 'application/json', ...headers }),
		body: JSON.stringify(body)
	});

/** Send `send`, failing the first transaction it opens at its commit. */
const with_refused_commit = async (
	gated: GatedDb,
	send: () => Promise<Response>
): Promise<Response> => {
	const held = gated.hold_commit();
	const pending = send();
	await held.reached;
	held.fail(new Error('commit refused'));
	return pending;
};

describe_db('session cookie lines and the commit', (get_db) => {
	const setup = async (): Promise<{ gated: GatedDb; test_app: TestApp }> => {
		const gated = create_gated_db(get_db());
		const test_app = await create_test_app({ session_options, db: gated.db, create_route_specs });
		return { gated, test_app };
	};

	const login = (test_app: TestApp, headers?: Record<string, string>) =>
		post(
			test_app,
			'/api/account/login',
			{ username: 'keeper', password: DEFAULT_TEST_PASSWORD },
			headers
		);

	test('a login whose commit fails mints no cookie', async () => {
		const { gated, test_app } = await setup();
		try {
			const res = await with_refused_commit(gated, () => login(test_app));
			assert.strictEqual(res.status, 500);
			assert.deepStrictEqual(res.headers.getSetCookie(), []);
		} finally {
			await test_app.cleanup();
		}
	});

	test('a login carrying a stale cookie whose commit fails clears it and mints nothing', async () => {
		const { gated, test_app } = await setup();
		try {
			const res = await with_refused_commit(gated, () => login(test_app, { cookie: STALE }));
			assert.strictEqual(res.status, 500);
			assert.deepStrictEqual(res.headers.getSetCookie(), [CLEAR]);
		} finally {
			await test_app.cleanup();
		}
	});

	test('a login that commits mints one cookie, after the stale cookie clear', async () => {
		const { test_app } = await setup();
		try {
			const res = await login(test_app, { cookie: STALE });
			assert.strictEqual(res.status, 200);
			const lines = res.headers.getSetCookie();
			assert.strictEqual(lines.length, 2);
			assert.strictEqual(lines[0], CLEAR);
			assert.ok(lines[1]!.startsWith('test_session=') && lines[1] !== CLEAR, lines[1]);
		} finally {
			await test_app.cleanup();
		}
	});

	test('a signup whose commit fails mints no cookie', async () => {
		const { gated, test_app } = await setup();
		try {
			await query_app_settings_update({ db: get_db() }, true, test_app.backend.actor.id);
			const res = await with_refused_commit(gated, () =>
				post(test_app, '/api/account/signup', {
					username: 'newcomer',
					password: 'newcomer-password-123'
				})
			);
			assert.strictEqual(res.status, 500);
			assert.deepStrictEqual(res.headers.getSetCookie(), []);
		} finally {
			await test_app.cleanup();
		}
	});

	test("a success's cookie is not sent when the route transaction's commit fails", async () => {
		const { gated, test_app } = await setup();
		try {
			// the stale cookie puts the clear on the context's headers, which a
			// response built before the commit would have written its line onto
			const res = await with_refused_commit(gated, () =>
				post(test_app, '/api/cookie_in_route_transaction', null, { cookie: STALE })
			);
			assert.strictEqual(res.status, 500);
			assert.deepStrictEqual(res.headers.getSetCookie(), [CLEAR]);
			const committed = await post(test_app, '/api/cookie_in_route_transaction', null, {
				cookie: STALE
			});
			assert.strictEqual(committed.status, 200);
			assert.deepStrictEqual(committed.headers.getSetCookie(), [CLEAR, 'minted=1; Path=/']);
		} finally {
			await test_app.cleanup();
		}
	});

	test('a password change that commits answers one clear', async () => {
		const { test_app } = await setup();
		try {
			const res = await post(
				test_app,
				'/api/account/password',
				{ current_password: DEFAULT_TEST_PASSWORD, new_password: 'changed-password-123' },
				{ cookie: `${session_options.cookie_name}=${test_app.backend.session_cookie}` }
			);
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(res.headers.getSetCookie(), [CLEAR]);
		} finally {
			await test_app.cleanup();
		}
	});

	test('a logout whose commit fails clears no cookie and ends no session', async () => {
		const { gated, test_app } = await setup();
		try {
			const cookie = `${session_options.cookie_name}=${test_app.backend.session_cookie}`;
			const res = await with_refused_commit(gated, () =>
				post(test_app, '/api/account/logout', null, { cookie })
			);
			assert.strictEqual(res.status, 500);
			assert.deepStrictEqual(res.headers.getSetCookie(), []);
			const again = await post(test_app, '/api/account/logout', null, { cookie });
			assert.strictEqual(again.status, 200);
			assert.deepStrictEqual(again.headers.getSetCookie(), [CLEAR]);
		} finally {
			await test_app.cleanup();
		}
	});

	test('a logout whose audit insert fails clears no cookie and ends no session', async () => {
		const { gated, test_app } = await setup();
		try {
			gated.refuse_in_transaction(is_audit_insert, new Error('audit insert refused'));
			const res = await post(test_app, '/api/account/logout', null, {
				cookie: `${session_options.cookie_name}=${test_app.backend.session_cookie}`
			});
			assert.strictEqual(res.status, 500);
			assert.deepStrictEqual(res.headers.getSetCookie(), []);
			// the revoke rolled back with the audit row: the session still works
			const again = await post(test_app, '/api/account/logout', null, {
				cookie: `${session_options.cookie_name}=${test_app.backend.session_cookie}`
			});
			assert.strictEqual(again.status, 200);
			assert.deepStrictEqual(again.headers.getSetCookie(), [CLEAR]);
		} finally {
			reset_audit_write_failures();
			await test_app.cleanup();
		}
	});
});
