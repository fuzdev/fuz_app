/**
 * Adversarial auth attack surface tests.
 *
 * Tests the route spec system's auth enforcement by creating a test app
 * from specs and hitting every route with adversarial inputs.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {Hono} from 'hono';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {apply_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import type {MiddlewareSpec} from '$lib/http/middleware_spec.js';
import {generate_app_surface} from '$lib/http/surface.js';
import {
	REQUEST_CONTEXT_KEY,
	require_auth,
	require_role,
	type RequestContext,
} from '$lib/auth/request_context.js';
import {
	ACCOUNT_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	TEST_CONTEXT_PRESET_KEY,
	type CredentialType,
} from '$lib/hono_context.js';
import {SESSION_COOKIE_OPTIONS} from '$lib/auth/session_cookie.js';
import {API_TOKEN_PREFIX} from '$lib/auth/api_token.js';
import {PASSWORD_LENGTH_MIN} from '$lib/auth/password.js';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
} from '$lib/http/error_schemas.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import {create_stub_db} from '$lib/testing/stubs.js';

const log = new Logger('test', {level: 'off'});
const stub_db = create_stub_db();

/** Create a test request context with an arbitrary list of role_grant roles. */
const create_test_ctx_with_role_grants = (roles: ReadonlyArray<string>): RequestContext => ({
	account: {
		id: 'acc_1' as Uuid,
		username: 'alice',
		password_hash: 'hash',
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		created_by: null,
		updated_by: null,
		email: null,
		email_verified: false,
	},
	actor: {
		id: 'act_1' as Uuid,
		account_id: 'acc_1' as Uuid,
		name: 'alice',
		created_at: new Date().toISOString(),
		updated_at: null,
		updated_by: null,
	},
	role_grants: roles.map((role, i) => ({
		id: `perm_${i + 1}` as Uuid,
		actor_id: 'act_1' as Uuid,
		role,
		scope_kind: null,
		scope_id: null,
		created_at: new Date().toISOString(),
		expires_at: null,
		revoked_at: null,
		revoked_by: null,
		revoked_reason: null,
		granted_by: null,
		source_offer_id: null,
	})),
});

/** Create a test request context with optional single role. */
const create_test_ctx = (role?: string): RequestContext =>
	create_test_ctx_with_role_grants(role ? [role] : []);

/** Create a test Hono app with auth middleware simulation and route specs. */
const create_test_app = (
	specs: Array<RouteSpec>,
	auth_ctx?: RequestContext,
	credential_type?: CredentialType,
): Hono => {
	const app = new Hono();
	// Simulate request context middleware — sets context if provided
	if (auth_ctx) {
		app.use('/*', async (c, next) => {
			(c as any).set(ACCOUNT_ID_KEY, auth_ctx.account.id);
			(c as any).set(REQUEST_CONTEXT_KEY, auth_ctx);
			(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
			if (credential_type) (c as any).set(CREDENTIAL_TYPE_KEY, credential_type);
			await next();
		});
	}
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, stub_db);
	return app;
};

/** Example route specs covering all auth types for testing. */
const test_route_specs: Array<RouteSpec> = [
	{
		method: 'GET',
		path: '/public',
		auth: {account: 'none', actor: 'none'},
		handler: (c) => c.json({ok: true}),
		description: 'Public endpoint',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'GET',
		path: '/authed',
		auth: {account: 'required', actor: 'none'},
		handler: (c) => c.json({ok: true}),
		description: 'Requires authentication',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/admin',
		auth: {account: 'required', actor: 'required', roles: ['admin']},
		handler: (c) => c.json({ok: true}),
		description: 'Requires admin role',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/keeper',
		auth: {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token'],
		},
		handler: (c) => c.json({ok: true}),
		description: 'Requires keeper credentials',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'DELETE',
		path: '/keeper-delete',
		auth: {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token'],
		},
		handler: (c) => c.json({ok: true}),
		description: 'Requires keeper credentials (DELETE)',
		input: z.null(),
		output: z.null(),
	},
];

/**
 * Named credential variants for the auth matrix.
 *
 * `none` = no auth context at all (the fixture omits every auth key).
 * Other entries set `ACCOUNT_ID_KEY`, `REQUEST_CONTEXT_KEY` (with the named
 * role_grants), and `CREDENTIAL_TYPE_KEY`, simulating what each upstream
 * authentication middleware would deposit before the dispatcher's
 * authorization phase.
 */
interface CredentialDescriptor {
	credential_type: CredentialType | null;
	role_grants: ReadonlyArray<string>;
}

const CREDENTIALS = {
	none: {credential_type: null, role_grants: []},
	'session+empty': {credential_type: 'session', role_grants: []},
	'session+viewer': {credential_type: 'session', role_grants: ['viewer']},
	'session+admin': {credential_type: 'session', role_grants: ['admin']},
	'session+keeper': {credential_type: 'session', role_grants: ['keeper']},
	'api_token+empty': {credential_type: 'api_token', role_grants: []},
	'api_token+admin': {credential_type: 'api_token', role_grants: ['admin']},
	'api_token+keeper': {credential_type: 'api_token', role_grants: ['keeper']},
	'daemon_token+empty': {credential_type: 'daemon_token', role_grants: []},
	'daemon_token+admin': {credential_type: 'daemon_token', role_grants: ['admin']},
	'daemon_token+keeper': {credential_type: 'daemon_token', role_grants: ['keeper']},
	'daemon_token+keeper+admin': {credential_type: 'daemon_token', role_grants: ['keeper', 'admin']},
} as const satisfies Record<string, CredentialDescriptor>;

type CredentialName = keyof typeof CREDENTIALS;

/**
 * One row of the credential × route attack matrix. Each row pins one cell
 * with the full (credential, method, path, expected-status) tuple — the
 * matrix is the diagnostic asset, so each combination is named explicitly
 * rather than derived. Adding a route or credential means appending rows
 * (and missing combinations are visible at a glance).
 */
interface AuthMatrixCase {
	credential: CredentialName;
	method: string;
	path: string;
	expected: number;
}

/**
 * Flat (credential × route) auth matrix — 12 credentials × 5 routes = 60 cells.
 *
 * Notable diagnostics this matrix pins:
 *
 * - `daemon_token+keeper+admin` × `POST /admin` = 200 — the bootstrap default.
 *   Bootstrap creates both `keeper` and `admin` role_grants on the keeper actor
 *   (`auth/bootstrap_account.ts`), so daemon-token-authenticated requests
 *   pass the admin gate. Revoking the keeper account's admin role_grant would
 *   silently break daemon-driven admin flows; this row is the regression guard.
 * - `daemon_token+keeper` × `POST /admin` = 403 — proves the role gate is
 *   role_grant-driven, not credential-driven. `require_role(['admin'])` checks
 *   role_grants only, with no credential-type bypass for daemon tokens.
 * - `daemon_token+admin` × `POST /keeper` = 403 — proves the keeper gate's
 *   second arm: daemon-token credential type alone doesn't satisfy keeper
 *   without an actual `keeper` role_grant on the actor.
 * - `session+keeper` × `POST /keeper` = 403 — proves the keeper gate's
 *   first arm: a session-cookie holder with the keeper role_grant cannot access
 *   keeper routes (`require_keeper` rejects on `credential_type !== 'daemon_token'`).
 * - `api_token+admin` × `POST /admin` = 200 — bearer (api_token) credentials
 *   are role_grant-equivalent to sessions for role checks; the gate doesn't
 *   distinguish.
 */
const auth_matrix: ReadonlyArray<AuthMatrixCase> = [
	// GET /public — open to all credentials including unauthenticated.
	{credential: 'none', method: 'GET', path: '/public', expected: 200},
	{credential: 'session+empty', method: 'GET', path: '/public', expected: 200},
	{credential: 'session+viewer', method: 'GET', path: '/public', expected: 200},
	{credential: 'session+admin', method: 'GET', path: '/public', expected: 200},
	{credential: 'session+keeper', method: 'GET', path: '/public', expected: 200},
	{credential: 'api_token+empty', method: 'GET', path: '/public', expected: 200},
	{credential: 'api_token+admin', method: 'GET', path: '/public', expected: 200},
	{credential: 'api_token+keeper', method: 'GET', path: '/public', expected: 200},
	{credential: 'daemon_token+empty', method: 'GET', path: '/public', expected: 200},
	{credential: 'daemon_token+admin', method: 'GET', path: '/public', expected: 200},
	{credential: 'daemon_token+keeper', method: 'GET', path: '/public', expected: 200},
	{credential: 'daemon_token+keeper+admin', method: 'GET', path: '/public', expected: 200},

	// GET /authed — any authenticated credential admits; only `none` 401s.
	{credential: 'none', method: 'GET', path: '/authed', expected: 401},
	{credential: 'session+empty', method: 'GET', path: '/authed', expected: 200},
	{credential: 'session+viewer', method: 'GET', path: '/authed', expected: 200},
	{credential: 'session+admin', method: 'GET', path: '/authed', expected: 200},
	{credential: 'session+keeper', method: 'GET', path: '/authed', expected: 200},
	{credential: 'api_token+empty', method: 'GET', path: '/authed', expected: 200},
	{credential: 'api_token+admin', method: 'GET', path: '/authed', expected: 200},
	{credential: 'api_token+keeper', method: 'GET', path: '/authed', expected: 200},
	{credential: 'daemon_token+empty', method: 'GET', path: '/authed', expected: 200},
	{credential: 'daemon_token+admin', method: 'GET', path: '/authed', expected: 200},
	{credential: 'daemon_token+keeper', method: 'GET', path: '/authed', expected: 200},
	{credential: 'daemon_token+keeper+admin', method: 'GET', path: '/authed', expected: 200},

	// POST /admin — role: admin. RoleGrant-driven; admits any credential type
	// holding an active `admin` role_grant.
	{credential: 'none', method: 'POST', path: '/admin', expected: 401},
	{credential: 'session+empty', method: 'POST', path: '/admin', expected: 403},
	{credential: 'session+viewer', method: 'POST', path: '/admin', expected: 403},
	{credential: 'session+admin', method: 'POST', path: '/admin', expected: 200},
	{credential: 'session+keeper', method: 'POST', path: '/admin', expected: 403},
	{credential: 'api_token+empty', method: 'POST', path: '/admin', expected: 403},
	{credential: 'api_token+admin', method: 'POST', path: '/admin', expected: 200},
	{credential: 'api_token+keeper', method: 'POST', path: '/admin', expected: 403},
	{credential: 'daemon_token+empty', method: 'POST', path: '/admin', expected: 403},
	{credential: 'daemon_token+admin', method: 'POST', path: '/admin', expected: 200},
	{credential: 'daemon_token+keeper', method: 'POST', path: '/admin', expected: 403},
	{credential: 'daemon_token+keeper+admin', method: 'POST', path: '/admin', expected: 200},

	// POST /keeper — keeper. Two-arm gate: daemon_token credential type AND
	// active keeper role_grant; either alone rejects.
	{credential: 'none', method: 'POST', path: '/keeper', expected: 401},
	{credential: 'session+empty', method: 'POST', path: '/keeper', expected: 403},
	{credential: 'session+viewer', method: 'POST', path: '/keeper', expected: 403},
	{credential: 'session+admin', method: 'POST', path: '/keeper', expected: 403},
	{credential: 'session+keeper', method: 'POST', path: '/keeper', expected: 403},
	{credential: 'api_token+empty', method: 'POST', path: '/keeper', expected: 403},
	{credential: 'api_token+admin', method: 'POST', path: '/keeper', expected: 403},
	{credential: 'api_token+keeper', method: 'POST', path: '/keeper', expected: 403},
	{credential: 'daemon_token+empty', method: 'POST', path: '/keeper', expected: 403},
	{credential: 'daemon_token+admin', method: 'POST', path: '/keeper', expected: 403},
	{credential: 'daemon_token+keeper', method: 'POST', path: '/keeper', expected: 200},
	{credential: 'daemon_token+keeper+admin', method: 'POST', path: '/keeper', expected: 200},

	// DELETE /keeper-delete — same auth as POST /keeper, different HTTP
	// method. Verifies the gate isn't sensitive to method.
	{credential: 'none', method: 'DELETE', path: '/keeper-delete', expected: 401},
	{credential: 'session+empty', method: 'DELETE', path: '/keeper-delete', expected: 403},
	{credential: 'session+viewer', method: 'DELETE', path: '/keeper-delete', expected: 403},
	{credential: 'session+admin', method: 'DELETE', path: '/keeper-delete', expected: 403},
	{credential: 'session+keeper', method: 'DELETE', path: '/keeper-delete', expected: 403},
	{credential: 'api_token+empty', method: 'DELETE', path: '/keeper-delete', expected: 403},
	{credential: 'api_token+admin', method: 'DELETE', path: '/keeper-delete', expected: 403},
	{credential: 'api_token+keeper', method: 'DELETE', path: '/keeper-delete', expected: 403},
	{credential: 'daemon_token+empty', method: 'DELETE', path: '/keeper-delete', expected: 403},
	{credential: 'daemon_token+admin', method: 'DELETE', path: '/keeper-delete', expected: 403},
	{credential: 'daemon_token+keeper', method: 'DELETE', path: '/keeper-delete', expected: 200},
	{
		credential: 'daemon_token+keeper+admin',
		method: 'DELETE',
		path: '/keeper-delete',
		expected: 200,
	},
];

describe('auth matrix — credential × route', () => {
	for (const c of auth_matrix) {
		test(`${c.credential} → ${c.method} ${c.path} → ${c.expected}`, async () => {
			const descriptor = CREDENTIALS[c.credential];
			const auth_ctx = descriptor.credential_type
				? create_test_ctx_with_role_grants(descriptor.role_grants)
				: undefined;
			const credential_type = descriptor.credential_type ?? undefined;
			const app = create_test_app(test_route_specs, auth_ctx, credential_type);
			const res = await app.request(c.path, {method: c.method});
			assert.strictEqual(
				res.status,
				c.expected,
				`Expected ${c.expected} for ${c.credential} → ${c.method} ${c.path} (got ${res.status})`,
			);
		});
	}
});

describe('targeted adversarial tests', () => {
	test('expired role_grant does not grant access', async () => {
		const ctx = create_test_ctx();
		ctx.role_grants = [
			{
				id: 'perm_expired' as Uuid,
				actor_id: 'act_1' as Uuid,
				role: 'admin',
				scope_kind: null,
				scope_id: null,
				created_at: new Date().toISOString(),
				expires_at: new Date(Date.now() - 86400_000).toISOString(), // expired yesterday
				revoked_at: null,
				revoked_by: null,
				revoked_reason: null,
				granted_by: null,
				source_offer_id: null,
			},
		];
		const app = create_test_app(test_route_specs, ctx);
		const res = await app.request('/admin', {method: 'POST'});
		assert.strictEqual(res.status, 403);
	});

	test('revoked role_grant does not grant access', async () => {
		const ctx = create_test_ctx();
		ctx.role_grants = [
			{
				id: 'perm_revoked' as Uuid,
				actor_id: 'act_1' as Uuid,
				role: 'admin',
				scope_kind: null,
				scope_id: null,
				created_at: new Date().toISOString(),
				expires_at: null,
				revoked_at: new Date().toISOString(),
				revoked_by: 'someone' as Uuid,
				revoked_reason: null,
				granted_by: null,
				source_offer_id: null,
			},
		];
		const app = create_test_app(test_route_specs, ctx);
		const res = await app.request('/admin', {method: 'POST'});
		assert.strictEqual(res.status, 403);
	});

	test('admin cannot access keeper routes', async () => {
		const app = create_test_app(test_route_specs, create_test_ctx('admin'));
		const res = await app.request('/keeper', {method: 'POST'});
		assert.strictEqual(res.status, 403);
	});

	test('keeper cannot access admin routes', async () => {
		const app = create_test_app(test_route_specs, create_test_ctx('keeper'));
		const res = await app.request('/admin', {method: 'POST'});
		assert.strictEqual(res.status, 403);
	});

	test('require_auth returns 401 with JSON body', async () => {
		const app = new Hono();
		app.get('/test', require_auth, (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
	});

	test('require_role returns 403 with role info', async () => {
		const app = new Hono();
		app.use('/*', async (c, next) => {
			const ctx = create_test_ctx('viewer');
			(c as any).set(ACCOUNT_ID_KEY, ctx.account.id);
			(c as any).set(REQUEST_CONTEXT_KEY, ctx);
			(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
			await next();
		});
		app.get('/test', require_role(['admin']), (c) => c.json({ok: true}));

		const res = await app.request('/test');
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
		assert.deepStrictEqual(body.required_roles, ['admin']);
	});
});

describe('static property assertions', () => {
	test('session cookie uses httpOnly', () => {
		assert.strictEqual(SESSION_COOKIE_OPTIONS.httpOnly, true);
	});

	test('session cookie uses secure', () => {
		assert.strictEqual(SESSION_COOKIE_OPTIONS.secure, true);
	});

	test('session cookie uses sameSite strict', () => {
		assert.strictEqual(SESSION_COOKIE_OPTIONS.sameSite, 'strict');
	});

	test('API token prefix is scannable', () => {
		assert.strictEqual(API_TOKEN_PREFIX, 'secret_fuz_token_');
	});

	test('minimum password length is 12', () => {
		assert.strictEqual(PASSWORD_LENGTH_MIN, 12);
	});
});

describe('surface generation integrity', () => {
	test('every auth type appears in surface', () => {
		const middleware: Array<MiddlewareSpec> = [];
		const surface = generate_app_surface({
			middleware_specs: middleware,
			route_specs: test_route_specs,
		});

		// Every category should be present — categorize via the predicates.
		const has_public = surface.routes.some(
			(r) => r.auth.account === 'none' && r.auth.actor === 'none',
		);
		const has_authed = surface.routes.some(
			(r) =>
				r.auth.account === 'required' && !r.auth.roles?.length && !r.auth.credential_types?.length,
		);
		const has_role = surface.routes.some((r) => !!r.auth.roles?.length);
		const has_keeper = surface.routes.some(
			(r) => r.auth.credential_types?.includes('daemon_token') ?? false,
		);
		assert.ok(has_public);
		assert.ok(has_authed);
		assert.ok(has_role);
		assert.ok(has_keeper);
	});

	test('surface route count matches spec count', () => {
		const surface = generate_app_surface({middleware_specs: [], route_specs: test_route_specs});
		assert.strictEqual(surface.routes.length, test_route_specs.length);
	});

	test('surface is deterministic', () => {
		const surface1 = generate_app_surface({middleware_specs: [], route_specs: test_route_specs});
		const surface2 = generate_app_surface({middleware_specs: [], route_specs: test_route_specs});
		assert.strictEqual(JSON.stringify(surface1), JSON.stringify(surface2));
	});
});
