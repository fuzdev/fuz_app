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

import { create_keyring } from '$lib/auth/keyring.ts';
import {
	create_session_config,
	create_session_cookie_value,
	SESSION_AGE_MAX,
	type SessionOptions
} from '$lib/auth/session_cookie.ts';
import { create_session_middleware } from '$lib/auth/session_middleware.ts';

import { OLD_KEY, TEST_KEY } from './session_test_helpers.ts';

const create_test_keyring = (key = TEST_KEY) => create_keyring(key)!;

const create_config = (cookie_name = 'test_session') => create_session_config(cookie_name);

/** Create a Hono test app with session middleware and a test handler that echoes the identity. */
const create_test_app = (
	keyring: ReturnType<typeof create_keyring>,
	options: SessionOptions<string>
): Hono => {
	const app = new Hono();
	app.use('/*', create_session_middleware(keyring!, options));
	app.get('/test', (c) => {
		const identity = (c as any).get(options.context_key);
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
		const rotated_keyring = create_keyring(`${TEST_KEY}__${OLD_KEY}`);
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

	test('custom context_key works', async () => {
		const keyring = create_test_keyring();
		const options: SessionOptions<string> = {
			...create_config(),
			context_key: 'custom_identity'
		};

		const app = new Hono();
		app.use('/*', create_session_middleware(keyring, options));
		app.get('/test', (c) => {
			const identity = (c as any).get('custom_identity');
			return c.json({ identity });
		});

		const cookie_value = await create_session_cookie_value(keyring, 'user-99', options);
		const res = await app.request('/test', {
			headers: { Cookie: `${options.cookie_name}=${cookie_value}` }
		});

		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.identity, 'user-99');
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
