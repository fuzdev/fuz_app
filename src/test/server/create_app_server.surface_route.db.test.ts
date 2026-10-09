/**
 * `GET /api/surface` — opt-in through `AppServerOptions.surface_route`, and
 * when mounted, an admin-only rule-3 surface: a narrowed token is refused it
 * whatever its method list says, ahead of the role gate.
 *
 * @module
 */

import { test, assert, beforeAll, beforeEach, afterAll, describe } from 'vitest';

import { create_session_config } from '$lib/auth/session_cookie.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import { generate_api_token } from '$lib/auth/api_token.ts';
import { query_create_api_token } from '$lib/auth/api_token_queries.ts';
import { token_scope_methods } from '$lib/auth/token_scope.ts';
import { create_health_route_spec } from '$lib/http/common_routes.ts';
import { create_test_app, type TestApp } from '$lib/testing/app_server.ts';
import { auth_truncate_tables } from '$lib/testing/db.ts';

import { default_db_factory } from '../db_fixture.ts';

const session_options = create_session_config('test_session');

let db: Awaited<ReturnType<typeof default_db_factory.create>>;

beforeAll(async () => {
	db = await default_db_factory.create();
});

beforeEach(async () => {
	for (const table of auth_truncate_tables) {
		await db.query(`TRUNCATE ${table} CASCADE`);
	}
});

afterAll(async () => {
	await default_db_factory.close(db);
});

const build = (surface_route?: boolean): Promise<TestApp> =>
	create_test_app({
		session_options,
		db,
		create_route_specs: () => [create_health_route_spec()],
		app_options: surface_route === undefined ? undefined : { surface_route }
	});

const lists_surface_route = (test_app: TestApp): boolean =>
	test_app.surface.routes.some((r) => r.method === 'GET' && r.path === '/api/surface');

describe('surface_route default', () => {
	for (const surface_route of [undefined, false] as const) {
		test(`not mounted (surface_route: ${surface_route})`, async () => {
			const test_app = await build(surface_route);
			try {
				assert.isFalse(lists_surface_route(test_app));
				// an admin session that would pass every gate still finds nothing
				const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
				const res = await test_app.app.request('/api/surface', {
					headers: admin.create_session_headers()
				});
				assert.strictEqual(res.status, 404);
			} finally {
				await test_app.cleanup();
			}
		});
	}
});

describe('surface_route: true', () => {
	test('lists the route with the admin + surface:app_surface gate', async () => {
		const test_app = await build(true);
		try {
			const route = test_app.surface.routes.find(
				(r) => r.method === 'GET' && r.path === '/api/surface'
			);
			assert.isDefined(route);
			assert.deepStrictEqual(route.auth, {
				account: 'required',
				actor: 'required',
				roles: [ROLE_ADMIN],
				required_scope: 'surface:app_surface'
			});
		} finally {
			await test_app.cleanup();
		}
	});

	test('unauthenticated → 401', async () => {
		const test_app = await build(true);
		try {
			const res = await test_app.app.request('/api/surface', {
				headers: { host: 'localhost', origin: 'http://localhost:5173' }
			});
			assert.strictEqual(res.status, 401);
		} finally {
			await test_app.cleanup();
		}
	});

	test('non-admin session → 403', async () => {
		const test_app = await build(true);
		try {
			const user = await test_app.create_account();
			const res = await test_app.app.request('/api/surface', {
				headers: user.create_session_headers()
			});
			assert.strictEqual(res.status, 403);
			assert.notStrictEqual(
				((await res.json()) as { error?: string }).error,
				'token_scope_required'
			);
		} finally {
			await test_app.cleanup();
		}
	});

	test('admin session → 200 with the surface', async () => {
		const test_app = await build(true);
		try {
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const res = await test_app.app.request('/api/surface', {
				headers: admin.create_session_headers()
			});
			assert.strictEqual(res.status, 200);
			const body = (await res.json()) as { routes: Array<{ path: string }> };
			assert.ok(body.routes.some((r) => r.path === '/api/surface'));
		} finally {
			await test_app.cleanup();
		}
	});

	test('admin full-scope bearer → 200', async () => {
		const test_app = await build(true);
		try {
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const res = await test_app.app.request('/api/surface', {
				headers: admin.create_bearer_headers()
			});
			assert.strictEqual(res.status, 200);
		} finally {
			await test_app.cleanup();
		}
	});

	test('non-admin narrowed token → 403 token_scope_required, ahead of the role gate', async () => {
		const test_app = await build(true);
		try {
			const user = await test_app.create_account();
			const { token, id, token_hash } = generate_api_token();
			await query_create_api_token(
				{ db },
				id,
				user.account.id,
				'narrowed',
				token_hash,
				token_scope_methods(['account_verify'])
			);
			const res = await test_app.app.request('/api/surface', {
				headers: { host: 'localhost', authorization: `Bearer ${token}` }
			});
			assert.strictEqual(res.status, 403);
			assert.deepStrictEqual(await res.json(), {
				error: 'token_scope_required',
				required_scope: 'surface:app_surface'
			});
		} finally {
			await test_app.cleanup();
		}
	});

	test('admin narrowed token → 403 token_scope_required (rule 3)', async () => {
		const test_app = await build(true);
		try {
			const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
			const { token, id, token_hash } = generate_api_token();
			await query_create_api_token(
				{ db },
				id,
				admin.account.id,
				'narrowed',
				token_hash,
				token_scope_methods(['account_verify'])
			);
			const res = await test_app.app.request('/api/surface', {
				headers: { host: 'localhost', authorization: `Bearer ${token}` }
			});
			assert.strictEqual(res.status, 403);
			assert.deepStrictEqual(await res.json(), {
				error: 'token_scope_required',
				required_scope: 'surface:app_surface'
			});
		} finally {
			await test_app.cleanup();
		}
	});
});
