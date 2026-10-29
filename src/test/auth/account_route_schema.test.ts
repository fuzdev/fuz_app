/**
 * Tests for the account route shapes — the `/verify` probe's rule-3 gate.
 *
 * `/verify` is the nginx `auth_request` probe: it answers 200 for the account
 * behind any credential, so a narrowed token would pass every location the
 * probe guards as its account. It is a non-RPC surface, and refuses one.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_account_route_shapes } from '#lib/auth/account_route_schema.ts';
import { apply_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { REQUEST_CONTEXT_KEY, type RequestContext } from '#lib/auth/request_context.ts';
import { RESOLVED_AUTH_KEY, TEST_CONTEXT_PRESET_KEY } from '#lib/hono_context.ts';
import { create_test_resolved_auth } from '#lib/testing/resolved_auth.ts';
import { token_scope_full, token_scope_methods, type TokenScope } from '#lib/auth/token_scope.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';

const log = new Logger('test', { level: 'off' });
const db = create_stub_db();

const ctx: RequestContext = {
	account: {
		id: 'acc_1' as Uuid,
		username: 'alice',
		email: null,
		email_verified: false,
		password_hash: 'hash',
		created_at: '2025-01-01T00:00:00Z',
		updated_at: '2025-01-01T00:00:00Z',
		created_by: null,
		updated_by: null,
		deleted_at: null,
		deleted_by: null
	},
	actor: null,
	role_grants: []
};

/** The `/verify` shape with a stand-in for the live handler's answer, under a credential of `scope`. */
const create_verify_app = (scope: TokenScope): Hono => {
	const [verify_shape] = create_account_route_shapes({ login_account_rate_limited: false });
	const spec: RouteSpec = { ...verify_shape, handler: (c) => c.body(null, 200) };
	const app = new Hono();
	app.use('/*', async (c, next) => {
		(c as any).set(
			RESOLVED_AUTH_KEY,
			create_test_resolved_auth({ credential_type: 'api_token', account_id: ctx.account.id, scope })
		);
		(c as any).set(REQUEST_CONTEXT_KEY, ctx);
		(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
		await next();
	});
	apply_route_specs(app, [spec], fuz_auth_guard_resolver, log, db);
	return app;
};

describe('account verify probe', () => {
	test('declares the account_verify surface', () => {
		const [verify_shape] = create_account_route_shapes({ login_account_rate_limited: false });
		assert.deepStrictEqual(verify_shape.auth, {
			account: 'required',
			actor: 'none',
			required_scope: 'surface:account_verify'
		});
	});

	test('a narrowed token → 403 token_scope_required', async () => {
		const res = await create_verify_app(token_scope_methods(['account_verify'])).request('/verify');
		assert.strictEqual(res.status, 403);
		assert.deepStrictEqual(await res.json(), {
			error: 'token_scope_required',
			required_scope: 'surface:account_verify'
		});
	});

	test('a full-scope credential → 200, empty body', async () => {
		const res = await create_verify_app(token_scope_full()).request('/verify');
		assert.strictEqual(res.status, 200);
		assert.strictEqual(await res.text(), '');
	});
});
