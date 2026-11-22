/**
 * The assembled app's session-cookie clear, in-process: an invalid session
 * cookie is cleared whichever credential goes on to authenticate the request,
 * once, on every response a route spec answers — a success (ahead of its own
 * cookie lines), a failure, a raw answer of every body kind, an SSE stream —
 * through every layer of the assembled server, and nothing else about the
 * response changes.
 *
 * The cross-process twin is the rows of
 * `#lib/testing/cross_backend/credential_conformance_wire.ts`.
 *
 * @module
 */

import { describe, test, assert, beforeAll, afterAll } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { literal, loose_object, string } from '@fuzdev/fuz_schema/schema.ts';

import { define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import {
	route_fail,
	route_ok,
	route_raw,
	route_sse,
	type RouteResult
} from '#lib/http/route_result.ts';
import { REST_TABLE_NOT_FOUND } from '#lib/http/error_schemas.ts';
import { create_test_app, type TestApp } from '#lib/testing/test_app.ts';
import { check_db_invariants_after_suite } from '#lib/testing/db_invariants.ts';

const session_cookie_name = 'test_session';
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
		handler: (route) => route_ok({ credential_type: route.credential?.credential_type ?? 'none' })
	});

/** Every kind of result a route answers with, each at `/api/kind/<name>`. */
const KINDS: ReadonlyArray<
	readonly [name: string, own_cookies: Array<string>, handler: RouteSpec['handler']]
> = [
	['ok', [], () => route_ok({ n: 1 })],
	[
		'ok_cookie',
		['other=1', 'more=2'],
		() => route_ok({ n: 1 }, { set_cookie: ['other=1', 'more=2'] })
	],
	['fail', [], () => route_fail(REST_TABLE_NOT_FOUND)],
	['raw_null', [], () => route_raw({ status: 203, headers: { 'X-Kept': '1' } })],
	[
		'raw_text',
		[],
		() =>
			route_raw({
				status: 418,
				headers: { 'Content-Type': 'text/plain', 'X-Kept': '1' },
				body: 'raw text'
			})
	],
	[
		'raw_bytes',
		[],
		() =>
			route_raw({
				status: 200,
				headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' },
				body: new Uint8Array([1, 2, 3])
			})
	],
	[
		'raw_stream',
		[],
		() =>
			route_raw({
				status: 200,
				headers: { 'Content-Type': 'text/plain' },
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('streamed'));
						controller.close();
					}
				})
			})
	],
	['sse', [], (route): RouteResult => route_sse(route.open_sse({ keep_alive_ms: null }))]
];

const create_kind_route_specs = (): Array<RouteSpec> =>
	KINDS.map(([name, , handler]) =>
		define_route({
			method: 'GET',
			path: `/api/kind/${name}`,
			auth: { account: 'required', actor: 'none' },
			description: `Answer a ${name} result`,
			input: literal(null),
			output: loose_object({}),
			errors: [REST_TABLE_NOT_FOUND],
			handler: handler as never
		})
	);

describe('session cookie clear beside another credential', () => {
	let test_app: TestApp;

	beforeAll(async () => {
		test_app = await create_test_app({
			session_cookie_name,
			create_route_specs: () => [create_credential_route_spec(), ...create_kind_route_specs()],
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

	// the app is built in `beforeAll`, outside any test, so it is checked
	// once the describe's tests are done, ahead of the cleanup
	// eslint-disable-next-line no-empty-pattern
	afterAll(async ({}, suite) => {
		try {
			await check_db_invariants_after_suite(suite, test_app);
		} finally {
			await test_app.cleanup();
		}
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

	// what a client reads of a response, its `Set-Cookie` lines apart; an SSE
	// body is read to its first frame, the connect comment
	const read_kind = async (
		name: string,
		headers: Record<string, string>
	): Promise<{ set_cookie: Array<string>; rest: unknown }> => {
		const res = await test_app.app.request(`/api/kind/${name}`, { headers });
		const set_cookie = res.headers.getSetCookie();
		let body: string;
		if (name === 'sse') {
			const reader = res.body!.getReader();
			body = new TextDecoder().decode((await reader.read()).value);
			await reader.cancel();
		} else {
			body = await res.text();
		}
		return {
			set_cookie,
			rest: {
				status: res.status,
				headers: [...res.headers].filter(([key]) => key !== 'set-cookie'),
				body
			}
		};
	};

	for (const [name, own_cookies] of KINDS) {
		test(`a ${name} result carries the clear once, ahead of its own lines, and is otherwise the same`, async () => {
			const stale = await read_kind(name, test_app.create_bearer_headers({ cookie: STALE }));
			const plain = await read_kind(name, test_app.create_bearer_headers());
			assert.deepStrictEqual(stale.set_cookie, [CLEAR, ...own_cookies]);
			assert.deepStrictEqual(plain.set_cookie, own_cookies);
			assert.deepStrictEqual(stale.rest, plain.rest);
		});
	}

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
