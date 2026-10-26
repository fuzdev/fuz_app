import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for refusing CORS simple requests.
 *
 * A `POST` with no `Content-Type`, or a `text/plain` / form / multipart one,
 * is what a browser sends cross-origin without a preflight — carrying the
 * session cookie when the page is same-site, which any other `localhost`
 * port is. Every spine's JSON routes require `application/json` and refuse
 * anything else with a flat `415` `{error: 'unsupported_content_type'}`
 * before reading a credential or the body: the TS spine per route
 * (`apply_route_specs`, every `POST` that isn't `raw_body`), the Rust spine
 * in each JSON handler. The cases carry an allowed `Origin` and, where it
 * matters, the keeper's session — the exact shape of a same-site page's
 * forged request, which the origin allowlist alone admits when it's a
 * wildcard — and a refused request must leave that session untouched.
 *
 * Runs both legs via the shared `setup_test` protocol: in-process
 * (`auth/simple_request_parity.db.test.ts`) and cross-process
 * (`cross_backend/spine_suites.cross.test.ts`). Every spine has the gate,
 * so the suite is ungated.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { account_verify_action_spec } from '../../auth/account_action_specs.ts';
import { ERROR_UNSUPPORTED_CONTENT_TYPE } from '../../http/error_schemas.ts';
import type { RpcPathCrossSuiteOptions, TestFixture } from './setup.ts';
import {
	SPINE_ACCOUNT_LOGIN_PATH,
	SPINE_ACCOUNT_LOGOUT_PATH,
	SPINE_RPC_PATH
} from './spine_surface_constants.ts';

/** Options for the simple-request parity suite. */
export interface SimpleRequestCrossTestOptions extends RpcPathCrossSuiteOptions {
	/** REST login route path. Default `/api/account/login` (the spine convention). */
	readonly login_path?: string;
	/** REST logout route path. Default `/api/account/logout` (the spine convention). */
	readonly logout_path?: string;
}

/** Build the JSON-RPC envelope body for a nullary `account_verify` call. */
const verify_envelope = (id: string): string =>
	JSON.stringify({ jsonrpc: '2.0', method: account_verify_action_spec.method, id });

/** Assert a flat `415` content-type refusal. */
const assert_refused = async (res: Response, label: string): Promise<void> => {
	assert.strictEqual(res.status, 415, `${label} must be refused with 415`);
	const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
	assert.strictEqual(body?.error, ERROR_UNSUPPORTED_CONTENT_TYPE, label);
};

export const describe_simple_request_cross_tests = (
	options: SimpleRequestCrossTestOptions
): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const login_path = options.login_path ?? SPINE_ACCOUNT_LOGIN_PATH;
	const logout_path = options.logout_path ?? SPINE_ACCOUNT_LOGOUT_PATH;

	/** POST a JSON `account_verify` with the fixture's session — 200 while it's valid. */
	const verify_session = async (fixture: TestFixture, id: string): Promise<number> => {
		const res = await fixture.transport(rpc_path, {
			method: 'POST',
			headers: { ...fixture.create_session_headers(), 'content-type': 'application/json' },
			body: verify_envelope(id)
		});
		return res.status;
	};

	describe('CORS simple-request refusal parity', () => {
		test('a CORS-safelisted RPC POST with a session → 415, in any spelling', async () => {
			const fixture = await setup_test();
			for (const content_type of [
				'text/plain;charset=UTF-8',
				'Text/Plain',
				'application/x-www-form-urlencoded',
				'multipart/form-data; boundary=x'
			]) {
				const res = await fixture.transport(rpc_path, {
					method: 'POST',
					headers: { ...fixture.create_session_headers(), 'content-type': content_type },
					body: verify_envelope('simple-safelisted')
				});
				await assert_refused(res, `a ${content_type} RPC POST`);
			}
		});

		test('RPC POST with no Content-Type → 415', async () => {
			const fixture = await setup_test();
			// a byte body, so `fetch` adds no `Content-Type` of its own (a string
			// body would get `text/plain;charset=UTF-8`)
			const res = await fixture.transport(rpc_path, {
				method: 'POST',
				headers: fixture.create_session_headers(),
				body: new TextEncoder().encode(verify_envelope('simple-untyped'))
			});
			await assert_refused(res, 'an untyped RPC POST');
		});

		test('a JSON route refuses any type but application/json', async () => {
			const fixture = await setup_test();
			for (const content_type of ['application/octet-stream', 'application/vnd.api+json', '']) {
				const res = await fixture.transport(rpc_path, {
					method: 'POST',
					headers: { ...fixture.create_session_headers(), 'content-type': content_type },
					body: verify_envelope('simple-not-json')
				});
				await assert_refused(res, `an RPC POST typed '${content_type}'`);
				const login = await fixture.fresh_transport()(login_path, {
					method: 'POST',
					headers: { 'content-type': content_type },
					body: JSON.stringify({ username: 'keeper', password: 'whatever' })
				});
				await assert_refused(login, `a login typed '${content_type}'`);
			}
		});

		test('form-encoded login → 415', async () => {
			const fixture = await setup_test();
			const res = await fixture.fresh_transport()(login_path, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: 'username=keeper&password=whatever'
			});
			await assert_refused(res, 'a form-encoded login');
		});

		test('a forged text/plain logout with a session → 415, and the session survives', async () => {
			const fixture = await setup_test();
			const res = await fixture.transport(logout_path, {
				method: 'POST',
				headers: { ...fixture.create_session_headers(), 'content-type': 'text/plain' }
			});
			await assert_refused(res, 'a text/plain logout');
			assert.strictEqual(
				await verify_session(fixture, 'after-forged-logout'),
				200,
				'the refused logout must not end the session'
			);
		});

		test('an untyped logout with no session → 415, before the auth check', async () => {
			const fixture = await setup_test();
			const res = await fixture.fresh_transport()(logout_path, {
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' }
			});
			await assert_refused(res, 'an octet-stream logout');
		});

		test('JSON logout with no body and no session → 401, not 415', async () => {
			const fixture = await setup_test();
			const res = await fixture.fresh_transport()(logout_path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' }
			});
			assert.strictEqual(res.status, 401, 'a bodyless JSON logout must reach the auth check');
		});

		test('application/json with a charset → dispatched', async () => {
			const fixture = await setup_test();
			const res = await fixture.transport(rpc_path, {
				method: 'POST',
				headers: {
					...fixture.create_session_headers(),
					'content-type': 'application/json; charset=utf-8'
				},
				body: verify_envelope('json-charset')
			});
			assert.strictEqual(res.status, 200, 'a JSON RPC POST must be dispatched');
		});
	});
};
