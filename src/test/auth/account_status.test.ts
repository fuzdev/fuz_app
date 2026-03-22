/**
 * Tests for `create_account_status_route_spec` — account status with bootstrap detection.
 *
 * Exercises metadata, authenticated/unauthenticated behavior, bootstrap_available
 * flag presence, and mutable reference tracking.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Hono} from 'hono';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_account_status_route_spec} from '$lib/auth/account_routes.js';
import {apply_route_specs} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import {REQUEST_CONTEXT_KEY, type RequestContext} from '$lib/auth/request_context.js';
import {create_stub_db} from '$lib/testing/stubs.js';

const log = new Logger('test', {level: 'off'});
const db = create_stub_db();

/** Create a test request context for an authenticated user. */
const create_test_ctx = (): RequestContext => ({
	account: {
		id: 'acc_1',
		username: 'alice',
		email: 'alice@example.com',
		email_verified: false,
		password_hash: 'hash',
		created_at: '2025-01-01T00:00:00.000Z',
		updated_at: '2025-01-01T00:00:00.000Z',
		created_by: null,
		updated_by: null,
	},
	actor: {
		id: 'act_1',
		account_id: 'acc_1',
		name: 'alice',
		created_at: '2025-01-01T00:00:00.000Z',
		updated_at: null,
		updated_by: null,
	},
	permits: [],
});

/** Create a test Hono app with route specs and optional auth context. */
const create_test_app = (
	specs: Parameters<typeof apply_route_specs>[1],
	auth_ctx?: RequestContext,
): Hono => {
	const app = new Hono();
	if (auth_ctx) {
		app.use('/*', async (c, next) => {
			(c as any).set(REQUEST_CONTEXT_KEY, auth_ctx);
			await next();
		});
	}
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
	return app;
};

describe('account status route spec metadata', () => {
	test('defaults to GET /api/account/status with auth none', () => {
		const spec = create_account_status_route_spec();
		assert.strictEqual(spec.method, 'GET');
		assert.strictEqual(spec.path, '/api/account/status');
		assert.deepStrictEqual(spec.auth, {type: 'none'});
	});

	test('accepts a custom path', () => {
		const spec = create_account_status_route_spec({path: '/custom/status'});
		assert.strictEqual(spec.path, '/custom/status');
	});
});

describe('account status unauthenticated', () => {
	test('returns 401 with error', async () => {
		const spec = create_account_status_route_spec();
		const app = create_test_app([spec]);
		const res = await app.request('/api/account/status');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, 'authentication_required');
		assert.ok(!('bootstrap_available' in body));
	});

	test('includes bootstrap_available when bootstrap_status is available', async () => {
		const spec = create_account_status_route_spec({bootstrap_status: {available: true}});
		const app = create_test_app([spec]);
		const res = await app.request('/api/account/status');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.bootstrap_available, true);
	});

	test('omits bootstrap_available when not available', async () => {
		const spec = create_account_status_route_spec({bootstrap_status: {available: false}});
		const app = create_test_app([spec]);
		const res = await app.request('/api/account/status');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.ok(!('bootstrap_available' in body));
	});

	test('omits bootstrap_available when bootstrap_status not provided', async () => {
		const spec = create_account_status_route_spec();
		const app = create_test_app([spec]);
		const res = await app.request('/api/account/status');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.ok(!('bootstrap_available' in body));
	});

	test('bootstrap_available reflects the shared mutable reference', async () => {
		const bootstrap_status = {available: true};
		const spec = create_account_status_route_spec({bootstrap_status});
		const app = create_test_app([spec]);

		const res1 = await app.request('/api/account/status');
		const body1 = await res1.json();
		assert.strictEqual(body1.bootstrap_available, true);

		bootstrap_status.available = false;

		const res2 = await app.request('/api/account/status');
		const body2 = await res2.json();
		assert.ok(!('bootstrap_available' in body2));
	});
});

describe('account status authenticated', () => {
	test('returns account with client fields', async () => {
		const spec = create_account_status_route_spec();
		const ctx = create_test_ctx();
		const app = create_test_app([spec], ctx);
		const res = await app.request('/api/account/status');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.account.id, 'acc_1');
		assert.strictEqual(body.account.username, 'alice');
		assert.strictEqual(body.account.email, 'alice@example.com');
		assert.strictEqual(body.account.created_at, '2025-01-01T00:00:00.000Z');
	});

	test('strips sensitive fields', async () => {
		const spec = create_account_status_route_spec();
		const ctx = create_test_ctx();
		const app = create_test_app([spec], ctx);
		const res = await app.request('/api/account/status');
		const body = await res.json();
		assert.strictEqual(body.account.password_hash, undefined);
		assert.strictEqual(body.account.updated_at, undefined);
	});

	test('does not include bootstrap_available', async () => {
		const spec = create_account_status_route_spec({bootstrap_status: {available: true}});
		const ctx = create_test_ctx();
		const app = create_test_app([spec], ctx);
		const res = await app.request('/api/account/status');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.ok(!('bootstrap_available' in body));
	});
});
