/**
 * The assembled app's session-cookie clear, in-process: an invalid session
 * cookie is cleared whichever credential goes on to authenticate the request,
 * on a response the context builds — and a response a route builds itself
 * comes back as the route made it, through every layer of the assembled
 * server.
 *
 * The cross-process twin is the rows of
 * `#lib/testing/cross_backend/credential_conformance_wire.ts`.
 *
 * @module
 */

import { describe, test, assert, beforeAll, afterAll } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { literal, loose_object, string } from '@fuzdev/fuz_schema/schema.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { get_resolved_auth } from '#lib/auth/resolved_auth.ts';
import { define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import { route_ok, route_raw } from '#lib/http/route_result.ts';
import { create_test_app, type TestApp } from '#lib/testing/app_server.ts';

const session_options = create_session_config('test_session');
const CLEAR = 'test_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
const STALE = 'test_session=stale.invalidsignature';

/** Answers the credential type that authenticated the request. */
const create_credential_route_spec = (): RouteSpec =>
	define_route({
		method: 'GET',
		path: '/api/credential',
		auth: { account: 'required', actor: 'none' },
		description: 'Return the credential type the request authenticated with',
		input: literal(null),
		output: loose_object({ credential_type: string }),
		handler: (c) => route_ok({ credential_type: get_resolved_auth(c)?.credential_type ?? 'none' })
	});

/** Answers a response the handler built itself, with a `Set-Cookie` of its own. */
const create_handler_built_route_spec = (): RouteSpec =>
	define_route({
		method: 'GET',
		path: '/api/handler_built',
		auth: { account: 'required', actor: 'none' },
		description: 'Return a response the handler built itself',
		input: literal(null),
		output: loose_object({}),
		handler: () =>
			route_raw(
				new Response('handler built', {
					status: 203,
					headers: { 'Set-Cookie': 'other=1', 'X-Kept': '1', 'Content-Type': 'text/plain' }
				})
			)
	});

describe('session cookie clear beside another credential', () => {
	let test_app: TestApp;

	beforeAll(async () => {
		test_app = await create_test_app({
			session_options,
			create_route_specs: () => [create_credential_route_spec(), create_handler_built_route_spec()],
			app_options: {
				// a layer behind the auth stack that throws, as a credential leg does:
				// what the assembled server's error handler answers
				transform_middleware: (specs) => [
					...specs,
					{
						name: 'http_exception_probe',
						path: '/api/http_exception/*',
						handler: (c) => {
							throw c.req.path.endsWith('/own_response')
								? new HTTPException(401, {
										res: new Response('denied', {
											status: 401,
											headers: { 'Set-Cookie': 'h=1' }
										})
									})
								: new HTTPException(403, { message: 'denied' });
						}
					}
				]
			}
		});
	});

	afterAll(async () => {
		await test_app.cleanup();
	});

	const request = async (
		headers: Record<string, string>
	): Promise<{ status: number; credential_type: unknown; set_cookie: Array<string> }> => {
		const res = await test_app.app.request('/api/credential', { headers });
		const body: unknown = await res.json();
		return {
			status: res.status,
			credential_type: (body as { credential_type?: unknown }).credential_type,
			set_cookie: res.headers.getSetCookie()
		};
	};

	// The daemon-token leg resolves ahead of the session middleware and the
	// bearer leg behind it, so nothing is resolved yet when the bearer case's
	// cookie is read. A clear skipped for a request already authenticated loses
	// the daemon case; one skipped for a request that offers another credential
	// header loses the bearer case.
	test('an invalid cookie beside a winning daemon token is cleared', async () => {
		assert.deepStrictEqual(await request(test_app.create_daemon_token_headers({ cookie: STALE })), {
			status: 200,
			credential_type: 'daemon_token',
			set_cookie: [CLEAR]
		});
	});

	test('an invalid cookie beside a winning bearer token is cleared', async () => {
		assert.deepStrictEqual(await request(test_app.create_bearer_headers({ cookie: STALE })), {
			status: 200,
			credential_type: 'api_token',
			set_cookie: [CLEAR]
		});
	});

	test('no cookie beside a winning credential clears nothing', async () => {
		for (const headers of [
			test_app.create_bearer_headers(),
			test_app.create_daemon_token_headers()
		]) {
			const got = await request(headers);
			assert.strictEqual(got.status, 200);
			assert.deepStrictEqual(got.set_cookie, []);
		}
	});

	test('an invalid cookie alone is refused and cleared', async () => {
		const got = await request({ host: 'localhost', cookie: STALE });
		assert.strictEqual(got.status, 401);
		assert.deepStrictEqual(got.set_cookie, [CLEAR]);
	});

	test('a response the route built itself comes back as it was made, with no clear', async () => {
		const read = async (headers: Record<string, string>): Promise<unknown> => {
			const res = await test_app.app.request('/api/handler_built', { headers });
			return {
				status: res.status,
				headers: [...res.headers],
				set_cookie: res.headers.getSetCookie(),
				body: await res.text()
			};
		};
		const stale = await read(test_app.create_bearer_headers({ cookie: STALE }));
		assert.deepStrictEqual(stale, await read(test_app.create_bearer_headers()));
		assert.deepInclude(stale, { status: 203, set_cookie: ['other=1'], body: 'handler built' });
	});

	test('a thrown HTTPException is answered through the context: the clear, then its own cookie', async () => {
		const read = async (path: string, headers: Record<string, string>): Promise<unknown> => {
			const res = await test_app.app.request(path, { headers });
			return { status: res.status, set_cookie: res.headers.getSetCookie(), body: await res.text() };
		};
		const stale = { host: 'localhost', cookie: STALE };
		const plain = { host: 'localhost' };
		assert.deepStrictEqual(await read('/api/http_exception/own_response', stale), {
			status: 401,
			set_cookie: [CLEAR, 'h=1'],
			body: 'denied'
		});
		assert.deepStrictEqual(await read('/api/http_exception/own_response', plain), {
			status: 401,
			set_cookie: ['h=1'],
			body: 'denied'
		});
		assert.deepStrictEqual(await read('/api/http_exception/message', stale), {
			status: 403,
			set_cookie: [CLEAR],
			body: 'denied'
		});
		assert.deepStrictEqual(await read('/api/http_exception/message', plain), {
			status: 403,
			set_cookie: [],
			body: 'denied'
		});
	});
});
