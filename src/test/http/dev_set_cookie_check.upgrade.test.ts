/**
 * The DEV `Set-Cookie` check on an accepted WebSocket upgrade. No runtime
 * adapter answers Hono with a `101`: `@hono/node-server`'s `upgradeWebSocket`
 * returns `new Response()` and `@hono/bun`'s `new Response(null)`, both a
 * `200` with no body and no `Set-Cookie`, and the runtime writes the real
 * `101` itself. `create_stub_upgrade` answers the same placeholder, so an
 * upgrade accepted under a stale session cookie must log nothing here — the
 * placeholder is no response a client reads. The skip is that shape and no
 * wider: a bodiless `200` to a request without the header, and a `200` with a
 * body to one with it, are checked.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_dev_set_cookie_check } from '#lib/http/dev_set_cookie_check.ts';
import { EXPECTED_FIRST_SET_COOKIE_KEY } from '#lib/hono_context.ts';
import { create_stub_upgrade } from '#lib/testing/ws_round_trip.ts';

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
	app.use('*', async (c, next) => {
		c.header('Set-Cookie', CLEAR, { append: true });
		c.set(EXPECTED_FIRST_SET_COOKIE_KEY, CLEAR);
		await next();
	});
	// built past the context, so neither carries the clear
	app.get('/bodiless', () => new Response(null));
	app.get('/with_body', () => new Response('raw'));
	return { app, errors };
};

describe('create_dev_set_cookie_check on an accepted upgrade', () => {
	test('a bodiless 200 to a request without `Upgrade: websocket` is still checked', async () => {
		const { app, errors } = create_app();
		await app.request('/bodiless');
		await app.request('/bodiless', { headers: { upgrade: 'h2c' } });
		assert.deepStrictEqual(errors, [
			'Response without the expected first Set-Cookie: GET /bodiless — it carries no Set-Cookie',
			'Response without the expected first Set-Cookie: GET /bodiless — it carries no Set-Cookie'
		]);
	});

	test('a 200 with a body to an upgrade request is still checked', async () => {
		const { app, errors } = create_app();
		await app.request('/with_body', { headers: { upgrade: 'websocket' } });
		assert.deepStrictEqual(errors, [
			'Response without the expected first Set-Cookie: GET /with_body — it carries no Set-Cookie'
		]);
	});

	test("the adapter's placeholder answer to a stale cookie logs nothing", async () => {
		const { app, errors } = create_app();
		const stub = create_stub_upgrade();
		app.get(
			'/ws',
			stub.upgradeWebSocket(() => ({}))
		);
		const res = await app.request('/ws', { headers: { upgrade: 'websocket' } });
		assert.strictEqual(stub.upgrades.length, 1, 'the upgrade was accepted');
		assert.strictEqual(res.status, 200, "the adapters' placeholder status");
		assert.deepStrictEqual(errors, []);
	});
});
