/**
 * Tests for session middleware — Hono integration for cookie-based sessions.
 *
 * Uses real `Keyring` and `SessionOptions` with Hono test apps
 * to verify cookie parsing, identity setting, and refresh behavior.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Hono } from 'hono';

import type { Keyring } from '#lib/auth/keyring.ts';
import {
	create_session_config,
	create_session_cookie_value,
	SESSION_AGE_MAX,
	type SessionOptions
} from '#lib/auth/session_cookie.ts';
import {
	clear_session_cookie,
	create_session_middleware,
	set_session_cookie
} from '#lib/auth/session_middleware.ts';
import { SESSION_TOKEN_KEY } from '#lib/hono_context.ts';

import { OLD_KEY, TEST_KEY, create_test_keyring } from './session_test_helpers.ts';

const create_config = (cookie_name = 'test_session') => create_session_config(cookie_name);

/** Create a Hono test app with session middleware and a test handler that echoes the identity. */
const create_test_app = (keyring: Keyring, options: SessionOptions<string>): Hono => {
	const app = new Hono();
	app.use('/*', create_session_middleware(keyring, options));
	app.get('/test', (c) => {
		const identity = c.get(SESSION_TOKEN_KEY);
		return c.json({ identity });
	});
	return app;
};

describe('create_session_middleware', () => {
	test('no cookie sets identity to null', async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const app = create_test_app(keyring, options);

		const res = await app.request('/test');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.identity, null);
	});

	test('valid cookie sets identity on context', async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const app = create_test_app(keyring, options);

		const cookie_value = await create_session_cookie_value(keyring, 'user-42', options);
		const res = await app.request('/test', {
			headers: { Cookie: `${options.cookie_name}=${cookie_value}` }
		});

		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.identity, 'user-42');
	});

	test('expired cookie sets identity to null and clears cookie', async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const app = create_test_app(keyring, options);

		// Create a cookie that expired 1 second ago
		const past = Math.floor(Date.now() / 1000) - SESSION_AGE_MAX - 1;
		const cookie_value = await create_session_cookie_value(keyring, 'user-42', options, past);
		const res = await app.request('/test', {
			headers: { Cookie: `${options.cookie_name}=${cookie_value}` }
		});

		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.identity, null);

		// Should have a Set-Cookie header that clears the cookie
		const set_cookie = res.headers.get('set-cookie');
		assert.ok(set_cookie, 'should set a cookie header to clear');
		assert.ok(
			set_cookie.includes(options.cookie_name),
			'clear cookie should reference the cookie name'
		);
	});

	test('key rotation authenticates the old-key cookie without re-signing it', async () => {
		// The hard-cap invariant at the middleware layer: a rotated-key cookie
		// keeps working as-is — a re-sign would extend the absolute lifetime
		// past the DB row's fixed expiry. Sign with the old key, verify with a
		// keyring that has the new key first.
		const old_keyring = create_test_keyring(OLD_KEY);
		const options = create_config();
		const cookie_value = await create_session_cookie_value(old_keyring, 'user-42', options);

		// New keyring has new key first, old key second (for rotation)
		const rotated_keyring = create_test_keyring(`${TEST_KEY}__${OLD_KEY}`);
		const app = create_test_app(rotated_keyring, options);

		const res = await app.request('/test', {
			headers: { Cookie: `${options.cookie_name}=${cookie_value}` }
		});

		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.identity, 'user-42');

		const set_cookie = res.headers.get('set-cookie');
		assert.strictEqual(set_cookie, null, 'a valid cookie is never re-signed');
	});

	test('cleared cookie sets Max-Age=0', async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const app = create_test_app(keyring, options);

		const res = await app.request('/test', {
			headers: { Cookie: `${options.cookie_name}=tampered.invalidsignature` }
		});

		const set_cookie = res.headers.get('set-cookie')!;
		assert.ok(set_cookie.includes('Max-Age=0'), 'cleared cookie should have Max-Age=0');
	});

	test('invalid signature sets identity to null and clears cookie', async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const app = create_test_app(keyring, options);

		const res = await app.request('/test', {
			headers: { Cookie: `${options.cookie_name}=tampered.invalidsignature` }
		});

		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.identity, null);

		const set_cookie = res.headers.get('set-cookie');
		assert.ok(set_cookie, 'should clear cookie with invalid signature');
	});

	test('the clear is the exact Set-Cookie string', async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const res = await create_test_app(keyring, options).request('/test', {
			headers: { Cookie: `${options.cookie_name}=tampered.invalidsignature` }
		});
		assert.deepStrictEqual(res.headers.getSetCookie(), [
			'test_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
		]);
	});

	test('an empty value is present and invalid — cleared; no pair clears nothing', async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const app = create_test_app(keyring, options);
		const empty = await app.request('/test', { headers: { Cookie: `${options.cookie_name}=` } });
		assert.strictEqual((await empty.json()).identity, null);
		assert.strictEqual(empty.headers.getSetCookie().length, 1, 'an empty value is cleared');
		for (const cookie of [
			'other=1',
			`${options.cookie_name}_x=1`,
			`x${options.cookie_name}=1`,
			''
		]) {
			const res = await app.request('/test', { headers: { Cookie: cookie } });
			assert.deepStrictEqual(res.headers.getSetCookie(), [], JSON.stringify(cookie));
		}
	});

	test('the value is read verbatim: a percent-encoded or quoted cookie is invalid', async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const app = create_test_app(keyring, options);
		const value = await create_session_cookie_value(keyring, 'user-42', options);
		assert.notStrictEqual(encodeURIComponent(value), value, 'the value has characters to encode');
		const control = await app.request('/test', {
			headers: { Cookie: `${options.cookie_name}=${value}` }
		});
		assert.strictEqual((await control.json()).identity, 'user-42');
		for (const sent of [encodeURIComponent(value), `"${value}"`, ` ${value}`]) {
			const res = await app.request('/test', {
				headers: { Cookie: `a=1; ${options.cookie_name}=${sent}` }
			});
			assert.strictEqual((await res.json()).identity, null, sent);
			assert.strictEqual(res.headers.getSetCookie().length, 1, `cleared: ${sent}`);
		}
	});

	test('an invalid first pair is not skipped for a valid second', async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const app = create_test_app(keyring, options);
		const value = await create_session_cookie_value(keyring, 'user-42', options);
		const name = options.cookie_name;
		const res = await app.request('/test', {
			headers: { Cookie: `${name}=bogus; ${name}=${value}` }
		});
		assert.strictEqual((await res.json()).identity, null);
		assert.strictEqual(res.headers.getSetCookie().length, 1);
		const reversed = await app.request('/test', {
			headers: { Cookie: `${name}=${value}; ${name}=bogus` }
		});
		assert.strictEqual((await reversed.json()).identity, 'user-42');
		assert.deepStrictEqual(reversed.headers.getSetCookie(), []);
	});

	test('the clear precedes a Set-Cookie the handler adds, and the new cookie is written raw', async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const app = new Hono();
		app.use('/*', create_session_middleware(keyring, options));
		let minted = '';
		app.post('/login', async (c) => {
			minted = await create_session_cookie_value(keyring, 'user-42', options);
			set_session_cookie(c, minted, options);
			return c.json({ ok: true });
		});
		const res = await app.request('/login', {
			method: 'POST',
			headers: { Cookie: `${options.cookie_name}=stale.invalidsignature` }
		});
		assert.deepStrictEqual(res.headers.getSetCookie(), [
			'test_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
			`test_session=${minted}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_AGE_MAX}`
		]);
		// and it reads back as itself
		const verify = await create_test_app(keyring, options).request('/test', {
			headers: { Cookie: res.headers.getSetCookie()[1]!.split(';', 1)[0]! }
		});
		assert.strictEqual((await verify.json()).identity, 'user-42');
	});

	test('max_age drives the Max-Age attribute', async () => {
		const keyring = create_test_keyring();
		const options = { ...create_config(), max_age: 90 };
		const app = new Hono();
		app.get('/set', (c) => {
			set_session_cookie(c, 'v', options);
			return c.json({ ok: true });
		});
		const res = await app.request('/set');
		assert.deepStrictEqual(res.headers.getSetCookie(), [
			'test_session=v; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=90'
		]);
		assert.ok(keyring);
	});

	test('a value the cookie grammar cannot carry is refused at mint, never written', async () => {
		const options = { ...create_config(), encode_identity: (id: string) => `${id} with spaces` };
		const keyring = create_test_keyring();
		const app = new Hono();
		app.get('/set', async (c) => {
			set_session_cookie(c, await create_session_cookie_value(keyring, 'u', options), options);
			return c.json({ ok: true });
		});
		const res = await app.request('/set');
		assert.strictEqual(res.status, 500, 'the handler throws');
		assert.deepStrictEqual(res.headers.getSetCookie(), []);
	});

	test("several Cookie lines read as one value: Node's raw header list, joined", async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const app = create_test_app(keyring, options);
		const value = await create_session_cookie_value(keyring, 'user-42', options);
		const name = options.cookie_name;
		const send = (raw_headers: Array<string>) =>
			app.request('/test', {}, { incoming: { rawHeaders: raw_headers } });
		const second = await send(['Cookie', 'other=1', 'Cookie', `${name}=${value}`]);
		assert.strictEqual((await second.json()).identity, 'user-42');
		const bogus_first = await send(['Cookie', `${name}=bogus`, 'cookie', `${name}=${value}`]);
		assert.strictEqual((await bogus_first.json()).identity, null);
		assert.strictEqual(bogus_first.headers.getSetCookie().length, 1);
	});

	test('calls next() for downstream handlers', async () => {
		const keyring = create_test_keyring();
		const options = create_config();
		const app = new Hono();
		app.use('/*', create_session_middleware(keyring, options));

		let downstream_called = false;
		app.get('/test', (c) => {
			downstream_called = true;
			return c.json({ ok: true });
		});

		await app.request('/test');
		assert.strictEqual(downstream_called, true);
	});
});

describe('the clear of an invalid session cookie', () => {
	const CLEAR = 'test_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
	const STALE = { Cookie: 'test_session=stale.invalidsignature' };
	const options = create_config();

	/** One response object for every request. */
	const SHARED = new Response(null, { status: 204 });

	/** Routes answering through the context, and with responses of their own. */
	const create_response_app = (keyring: Keyring): Hono => {
		const app = new Hono();
		app.use('/*', create_session_middleware(keyring, options));
		// built by the context
		app.get('/json', (c) => c.json({ ok: true }));
		app.get('/text', (c) => c.text('text'));
		app.get('/no_content', (c) => c.body(null, 204));
		app.get('/not_modified', (c) => c.body(null, 304));
		app.get('/refused', (c) => c.json({ error: 'authentication_required' }, 401));
		app.get('/mint', (c) => {
			c.header('Set-Cookie', 'test_session=new', { append: true });
			return c.json({ ok: true });
		});
		app.get('/two_cookies', (c) => {
			c.header('Set-Cookie', 'a=1', { append: true });
			c.header('Set-Cookie', 'b=2', { append: true });
			c.header('X-Kept', '1');
			return c.json({ ok: true });
		});
		app.get('/throw', () => {
			throw new Error('boom');
		});
		// built by the handler
		app.get('/raw', () => new Response('raw'));
		app.get('/raw_cookie', () => new Response('raw', { headers: { 'Set-Cookie': 'other=1' } }));
		app.get('/redirect', () => Response.redirect('http://localhost/x', 302));
		app.get('/fetched', () => fetch('data:text/plain,fetched'));
		app.get(
			'/status_text',
			() =>
				new Response('short and stout', {
					status: 418,
					statusText: 'Teapot Of Its Own',
					headers: { 'X-Kept': '1', 'Content-Type': 'text/teapot' }
				})
		);
		// the placeholder a runtime adapter answers an upgrade it took with
		app.get('/upgrade_placeholder', () => new Response(null));
		app.get('/shared', () => SHARED);
		return app;
	};

	const CONTEXT_BUILT: ReadonlyArray<
		readonly [path: string, status: number, set_cookies: Array<string>]
	> = [
		['/json', 200, []],
		['/text', 200, []],
		['/no_content', 204, []],
		['/not_modified', 304, []],
		['/refused', 401, []],
		// a cookie the handler mints stays after the clear
		['/mint', 200, ['test_session=new']],
		['/two_cookies', 200, ['a=1', 'b=2']],
		// the error handler's response and the not-found handler's
		['/throw', 500, []],
		['/unrouted', 404, []]
	];

	const HANDLER_BUILT: ReadonlyArray<string> = [
		'/raw',
		'/raw_cookie',
		'/redirect',
		'/fetched',
		'/status_text',
		'/upgrade_placeholder',
		'/shared'
	];

	test('is on every response the context builds, once, ahead of its own Set-Cookie lines', async () => {
		const app = create_response_app(create_test_keyring());
		for (const [path, status, set_cookies] of CONTEXT_BUILT) {
			const res = await app.request(path, { headers: STALE });
			assert.strictEqual(res.status, status, path);
			assert.deepStrictEqual(res.headers.getSetCookie(), [CLEAR, ...set_cookies], path);
		}
	});

	test('changes nothing of a response but its Set-Cookie lines', async () => {
		const app = create_response_app(create_test_keyring());
		for (const [path] of [...CONTEXT_BUILT, ...HANDLER_BUILT.map((p) => [p] as const)]) {
			if (path === '/shared') continue;
			const plain = await app.request(path);
			const stale = await app.request(path, { headers: STALE });
			// `c.text`'s type is Hono's own line once the context carries a header,
			// the runtime's otherwise: one type, spelled with and without a space
			const without_set_cookie = (res: Response): Array<[string, string]> =>
				[...res.headers]
					.filter(([name]) => name !== 'set-cookie')
					.map(([name, value]) => [name, value.replace(/;\s*/g, ';')]);
			assert.strictEqual(stale.status, plain.status, path);
			assert.strictEqual(stale.statusText, plain.statusText, path);
			assert.deepStrictEqual(without_set_cookie(stale), without_set_cookie(plain), path);
			assert.strictEqual(await stale.text(), await plain.text(), path);
		}
	});

	test('is not on a response the handler built, which comes back as the handler made it', async () => {
		const app = create_response_app(create_test_keyring());
		const expected: Record<string, [status: number, set_cookies: Array<string>, body: string]> = {
			'/raw': [200, [], 'raw'],
			'/raw_cookie': [200, ['other=1'], 'raw'],
			'/redirect': [302, [], ''],
			'/fetched': [200, [], 'fetched'],
			'/status_text': [418, [], 'short and stout'],
			'/upgrade_placeholder': [200, [], '']
		};
		for (const [path, [status, set_cookies, body]] of Object.entries(expected)) {
			const res = await app.request(path, { headers: STALE });
			assert.strictEqual(res.status, status, path);
			assert.deepStrictEqual(res.headers.getSetCookie(), set_cookies, path);
			assert.strictEqual(await res.text(), body, path);
		}
		const teapot = await app.request('/status_text', { headers: STALE });
		assert.strictEqual(teapot.statusText, 'Teapot Of Its Own');
		assert.strictEqual(teapot.headers.get('X-Kept'), '1');
		assert.strictEqual(teapot.headers.get('Content-Type'), 'text/teapot');
		const redirect = await app.request('/redirect', { headers: STALE });
		assert.strictEqual(redirect.headers.get('Location'), 'http://localhost/x');
	});

	test('is replaced by a Set-Cookie the handler sets rather than appends', async () => {
		// Hono's `c.header` sets unless told to append, and applies a header
		// record by setting each name: the context's line is replaced. The
		// spine's own `set_session_cookie` / `clear_session_cookie` append — the
		// login and logout tests of this file hold them to it
		const app = new Hono();
		app.use('/*', create_session_middleware(create_test_keyring(), options));
		app.get('/set', (c) => {
			c.header('Set-Cookie', 'own=1');
			return c.json({ ok: true });
		});
		app.get('/record', (c) => c.json({ ok: true }, 200, { 'Set-Cookie': 'own=1' }));
		app.get('/record_list', (c) => c.body('ok', 200, { 'Set-Cookie': ['own=1', 'own=2'] }));
		// controls: an append, and the `headers` of a response init, add to it
		app.get('/append', (c) => {
			c.header('Set-Cookie', 'own=1', { append: true });
			return c.json({ ok: true });
		});
		app.get('/init', (c) => c.body('ok', { headers: { 'Set-Cookie': 'own=1' } }));
		const cases: ReadonlyArray<readonly [path: string, own: Array<string>, replaced: boolean]> = [
			['/set', ['own=1'], true],
			['/record', ['own=1'], true],
			['/record_list', ['own=1', 'own=2'], true],
			['/append', ['own=1'], false],
			['/init', ['own=1'], false]
		];
		for (const [path, own, replaced] of cases) {
			const stale = await app.request(path, { headers: STALE });
			assert.strictEqual(stale.status, 200, path);
			assert.deepStrictEqual(stale.headers.getSetCookie(), replaced ? own : [CLEAR, ...own], path);
			assert.deepStrictEqual((await app.request(path)).headers.getSetCookie(), own, path);
		}
	});

	test('never touches a response object the handler returns to every request', async () => {
		const app = create_response_app(create_test_keyring());
		// with and without a stale cookie, alternating: the very object, unchanged
		for (const headers of [{}, STALE, {}, STALE, {}]) {
			const res = await app.request('/shared', { headers });
			assert.strictEqual(res, SHARED, 'the handler’s own object is what is answered');
			assert.strictEqual(res.status, 204);
			assert.deepStrictEqual(res.headers.getSetCookie(), []);
		}
		assert.deepStrictEqual([...SHARED.headers], []);
	});

	test('never takes the body of a response object the handler returns again', async () => {
		const app = new Hono();
		app.use('/*', create_session_middleware(create_test_keyring(), options));
		const SHARED_BODY = new Response('shared', { headers: { 'X-Shared': '1' } });
		app.get('/shared_body', () => SHARED_BODY);
		// a body is read once, so nothing here reads one until the end: a
		// middleware that had wrapped the object's body in a response of its own
		// would have answered with that response, and left this one's body to it
		for (const headers of [{}, STALE, {}, STALE, STALE, {}]) {
			const res = await app.request('/shared_body', { headers });
			assert.strictEqual(res, SHARED_BODY, 'the handler’s own object is what is answered');
			assert.strictEqual(res.bodyUsed, false);
			assert.strictEqual(res.body?.locked, false);
			assert.deepStrictEqual(
				[...res.headers],
				[
					['content-type', 'text/plain;charset=UTF-8'],
					['x-shared', '1']
				]
			);
		}
		assert.strictEqual(await SHARED_BODY.text(), 'shared');
	});

	test('is absent without an invalid cookie', async () => {
		const keyring = create_test_keyring();
		const app = create_response_app(keyring);
		const valid = await create_session_cookie_value(keyring, 'user-42', options);
		const sent: Array<Record<string, string>> = [
			{},
			{ Cookie: `test_session=${valid}` },
			{ Cookie: 'other=1' }
		];
		for (const headers of sent) {
			for (const [path, status, set_cookies] of CONTEXT_BUILT) {
				const res = await app.request(path, { headers });
				assert.strictEqual(res.status, status, path);
				assert.deepStrictEqual(res.headers.getSetCookie(), set_cookies, path);
			}
		}
	});

	test('a handler clearing a valid cookie answers one clear; beside an invalid one, its own follows', async () => {
		const keyring = create_test_keyring();
		const app = new Hono();
		app.use('/*', create_session_middleware(keyring, options));
		app.post('/logout', (c) => {
			clear_session_cookie(c, options);
			return c.json({ ok: true });
		});
		const valid = await create_session_cookie_value(keyring, 'user-42', options);
		const logout = await app.request('/logout', {
			method: 'POST',
			headers: { Cookie: `test_session=${valid}` }
		});
		assert.deepStrictEqual(logout.headers.getSetCookie(), [CLEAR]);
		// the middleware's clear and the handler's are independent, as on the Rust spine
		const stale = await app.request('/logout', { method: 'POST', headers: STALE });
		assert.deepStrictEqual(stale.headers.getSetCookie(), [CLEAR, CLEAR]);
	});

	test("its scope is the router's reading of the path it is mounted on", async () => {
		const app = new Hono();
		app.use('/api/*', create_session_middleware(create_test_keyring(), options));
		const cases: ReadonlyArray<readonly [path: string, cleared: boolean]> = [
			['/api', true],
			['/api/', true],
			['/api/x', true],
			['/apix', false],
			['/API/x', false],
			['/health', false],
			// read percent-decoded and with dot segments resolved, where the Rust
			// spine reads the raw path
			['/%61pi/x', true],
			['/./api/x', true],
			['/api/../health', false]
		];
		for (const [path, cleared] of cases) {
			const res = await app.request(path, { headers: STALE });
			assert.deepStrictEqual(res.headers.getSetCookie(), cleared ? [CLEAR] : [], path);
		}
	});

	test('reaches a handler-built response only when a layer read c.res ahead of the handler', async () => {
		// Hono's doing, not the middleware's: once the context holds a response of
		// its own, Hono rebuilds the handler's over it — the context's `Set-Cookie`
		// lines in place of the handler's
		const app = new Hono();
		app.use('/*', create_session_middleware(create_test_keyring(), options));
		const early_statuses: Array<number> = [];
		app.use('/early/*', async (c, next) => {
			early_statuses.push(c.res.status);
			await next();
		});
		const own = (): Response => new Response('raw', { headers: { 'Set-Cookie': 'other=1' } });
		app.get('/early/raw_cookie', own);
		app.get('/raw_cookie', own);
		const early = await app.request('/early/raw_cookie', { headers: STALE });
		assert.deepStrictEqual(early.headers.getSetCookie(), [CLEAR]);
		assert.strictEqual(await early.text(), 'raw');
		// the early read has Hono rebuild every handler response, stale cookie or
		// not; while the context has no `Set-Cookie` of its own, the handler's
		// lines are what the rebuilt response keeps
		assert.deepStrictEqual((await app.request('/early/raw_cookie')).headers.getSetCookie(), [
			'other=1'
		]);
		assert.deepStrictEqual(
			(await app.request('/raw_cookie', { headers: STALE })).headers.getSetCookie(),
			['other=1']
		);
	});
});
