/**
 * The DEV `Set-Cookie` check alone: with a line recorded under
 * `EXPECTED_FIRST_SET_COOKIE_KEY`, a response whose first `Set-Cookie` is not
 * that line is logged — one with none, one with another line first — and one
 * leading with it and a request with nothing recorded are not. It never
 * changes the response. An accepted upgrade's placeholder is
 * `dev_set_cookie_check.upgrade.test.ts`'s. The assembled server's wiring is
 * `server/create_app_server.dev_set_cookie_check.db.test.ts`'s.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_dev_set_cookie_check } from '#lib/http/dev_set_cookie_check.ts';
import { EXPECTED_FIRST_SET_COOKIE_KEY } from '#lib/hono_context.ts';

const CLEAR = 's=; Path=/; Max-Age=0';

const create_app = (): { app: Hono; errors: Array<string> } => {
	const errors: Array<string> = [];
	const log = new Logger('test', { level: 'off' });
	log.error = (...args: Array<unknown>) => {
		errors.push(String(args[0]));
	};
	const check = create_dev_set_cookie_check({ log });
	assert.ok(check, 'mounted under DEV');
	const app = new Hono();
	app.use('*', check);
	// what the session middleware does for a stale cookie
	app.use('/cleared/*', async (c, next) => {
		c.header('Set-Cookie', CLEAR, { append: true });
		c.set(EXPECTED_FIRST_SET_COOKIE_KEY, CLEAR);
		await next();
	});
	app.get('/cleared/context', (c) => c.json({ ok: true }));
	app.get('/cleared/context_then_own', (c) => {
		c.header('Set-Cookie', 'next=1', { append: true });
		return c.json({ ok: true });
	});
	app.get('/cleared/own_response', () => new Response('raw'));
	app.get(
		'/cleared/other_first',
		() =>
			new Response('raw', {
				headers: [
					['set-cookie', 'other=1'],
					['set-cookie', CLEAR]
				]
			})
	);
	app.get('/plain/own_response', () => new Response('raw'));
	return { app, errors };
};

describe('create_dev_set_cookie_check', () => {
	test('a response leading with the recorded line logs nothing', async () => {
		const { app, errors } = create_app();
		for (const path of ['/cleared/context', '/cleared/context_then_own']) {
			const res = await app.request(path);
			assert.strictEqual(res.headers.getSetCookie()[0], CLEAR, path);
		}
		assert.deepStrictEqual(errors, []);
	});

	test('a response built past the context, with no Set-Cookie, is logged', async () => {
		const { app, errors } = create_app();
		const res = await app.request('/cleared/own_response');
		assert.strictEqual(await res.text(), 'raw', 'the response is left as it was');
		assert.deepStrictEqual(errors, [
			'Response without the expected first Set-Cookie: GET /cleared/own_response — it carries no Set-Cookie'
		]);
	});

	test('a response with another line ahead of the recorded one is logged', async () => {
		const { app, errors } = create_app();
		const res = await app.request('/cleared/other_first');
		assert.deepStrictEqual(res.headers.getSetCookie(), ['other=1', CLEAR]);
		assert.deepStrictEqual(errors, [
			'Response without the expected first Set-Cookie: GET /cleared/other_first — another Set-Cookie comes first'
		]);
	});

	test('a request with nothing recorded logs nothing', async () => {
		const { app, errors } = create_app();
		await app.request('/plain/own_response');
		assert.deepStrictEqual(errors, []);
	});
});
