/**
 * Tests for `require_keeper` — two-part keeper credential guard.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {Hono} from 'hono';

import {require_keeper} from '$lib/auth/require_keeper.js';
import {REQUEST_CONTEXT_KEY, type RequestContext} from '$lib/auth/request_context.js';
import {CREDENTIAL_TYPE_KEY, type CredentialType} from '$lib/hono_context.js';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
} from '$lib/http/error_schemas.js';
import {create_test_account, create_test_actor, create_test_permit} from '$lib/testing/entities.js';

const create_context = (roles: Array<string>): RequestContext => ({
	account: create_test_account(),
	actor: create_test_actor(),
	permits: roles.map((r) => create_test_permit({role: r})),
});

/** Create a test app with require_keeper and optional injected auth state. */
const create_keeper_app = (ctx?: RequestContext, credential_type?: CredentialType): Hono => {
	const app = new Hono();
	if (ctx) {
		app.use('/*', async (c, next) => {
			c.set(REQUEST_CONTEXT_KEY, ctx);
			if (credential_type) {
				c.set(CREDENTIAL_TYPE_KEY, credential_type);
			}
			await next();
		});
	}
	app.use('/*', require_keeper);
	app.get('/test', (c) => c.json({ok: true}));
	return app;
};

describe('require_keeper', () => {
	test('returns 401 when no request context', async () => {
		const app = create_keeper_app();

		const res = await app.request('/test');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	test('returns 403 when credential_type is session (even with keeper role)', async () => {
		const ctx = create_context(['keeper', 'admin']);
		const app = create_keeper_app(ctx, 'session');

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_KEEPER_REQUIRES_DAEMON_TOKEN);
		assert.strictEqual(body.credential_type, 'session');
	});

	test('returns 403 when credential_type is api_token (even with keeper role)', async () => {
		const ctx = create_context(['keeper', 'admin']);
		const app = create_keeper_app(ctx, 'api_token');

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_KEEPER_REQUIRES_DAEMON_TOKEN);
		assert.strictEqual(body.credential_type, 'api_token');
	});

	test('returns 403 when credential_type is not set', async () => {
		const ctx = create_context(['keeper']);
		const app = create_keeper_app(ctx); // no credential_type

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_KEEPER_REQUIRES_DAEMON_TOKEN);
		assert.strictEqual(body.credential_type, 'none');
	});

	test('returns 403 when credential_type is daemon_token but keeper role missing', async () => {
		const ctx = create_context(['admin']);
		const app = create_keeper_app(ctx, 'daemon_token');

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
		assert.strictEqual(body.required_role, 'keeper');
	});

	test('passes when credential_type is daemon_token and keeper role present', async () => {
		const ctx = create_context(['keeper', 'admin']);
		const app = create_keeper_app(ctx, 'daemon_token');

		const res = await app.request('/test');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});

	test('returns 403 when keeper permit is expired (daemon_token credential)', async () => {
		const past = new Date(Date.now() - 60000).toISOString();
		const ctx: RequestContext = {
			account: create_test_account(),
			actor: create_test_actor(),
			permits: [{...create_test_permit({role: 'keeper'}), expires_at: past}],
		};
		const app = create_keeper_app(ctx, 'daemon_token');

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
		assert.strictEqual(body.required_role, 'keeper');
	});

	test('returns 403 when keeper permit is revoked (daemon_token credential)', async () => {
		const ctx: RequestContext = {
			account: create_test_account(),
			actor: create_test_actor(),
			permits: [{...create_test_permit({role: 'keeper'}), revoked_at: '2024-06-01T00:00:00Z'}],
		};
		const app = create_keeper_app(ctx, 'daemon_token');

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
		assert.strictEqual(body.required_role, 'keeper');
	});
});
