/**
 * The `{acting}` route query, a `@fuzdev/fuz_schema` `object`, through an
 * assembled app: `GET /api/surface` for an admin with two actors, the admin
 * role on the first. What the query admits reaches the authorization phase,
 * which resolves the acting actor from it; what it refuses is a 400
 * `invalid_query_params` before that phase. Pins how the query string, Hono's
 * `c.req.query()`, the schema, and the selector compose: a repeated key is
 * read at its first occurrence, a bare `?acting` is the empty string, a
 * percent-encoded id decodes to the id, and an own `__proto__` key is an
 * unknown key.
 *
 * @module
 */

import { test, assert, beforeAll, beforeEach, afterAll, describe } from 'vitest';
import { readFileSync } from 'node:fs';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { query_create_actor } from '#lib/auth/account_queries.ts';
import { create_health_route_spec } from '#lib/http/common_routes.ts';
import { create_test_app, type TestAccount, type TestApp } from '#lib/testing/app_server.ts';
import { auth_truncate_tables } from '#lib/testing/db.ts';

import { default_db_factory } from '../db_fixture.ts';

const session_options = create_session_config('test_session');

const SURFACE_FIXTURE_PATH = new URL('../fixtures/surface/acting_query.json', import.meta.url);

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

interface Setup {
	test_app: TestApp;
	admin: TestAccount;
	/** The admin's second actor, which holds no admin grant. */
	other_actor_id: string;
	request: (query: string) => Promise<Response>;
}

const setup = async (): Promise<Setup> => {
	const test_app = await create_test_app({
		session_options,
		db,
		create_route_specs: () => [create_health_route_spec()],
		app_options: { surface_route: true }
	});
	const admin = await test_app.create_account({ roles: [ROLE_ADMIN] });
	const other = await query_create_actor({ db }, admin.account.id, 'second');
	return {
		test_app,
		admin,
		other_actor_id: other.id,
		request: async (query) =>
			await test_app.app.request(`/api/surface${query}`, {
				headers: admin.create_session_headers()
			})
	};
};

/** Percent-encodes every character of `s`, ASCII, not only the reserved ones. */
const percent_encode_all = (s: string): string =>
	s.replace(/./g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

const read_error = async (res: Response): Promise<unknown> =>
	((await res.json()) as { error?: unknown }).error;

describe('GET /api/surface `?acting=` through the route stack', () => {
	test('the served surface lists the route with the Zod-era query schema', async () => {
		const { test_app, admin, request } = await setup();
		try {
			const res = await request(`?acting=${admin.actor.id}`);
			assert.strictEqual(res.status, 200);
			const body = (await res.json()) as {
				routes: Array<{ method: string; path: string; query_schema: unknown }>;
			};
			const served = body.routes.find((r) => r.method === 'GET' && r.path === '/api/surface');
			const fixture = (
				JSON.parse(readFileSync(SURFACE_FIXTURE_PATH, 'utf8')) as Array<{
					method: string;
					path: string;
					query_schema: unknown;
				}>
			).find((r) => r.method === 'GET' && r.path === '/api/surface');
			assert.ok(served && fixture);
			assert.deepStrictEqual(served.query_schema, fixture.query_schema);
		} finally {
			await test_app.cleanup();
		}
	});

	test('the acting actor is resolved from the selector, in either case', async () => {
		const { test_app, admin, other_actor_id, request } = await setup();
		try {
			// two actors and no selector: the authorization phase asks for one
			const none = await request('');
			assert.strictEqual(none.status, 400);
			assert.strictEqual(await read_error(none), 'actor_required');
			assert.strictEqual((await request(`?acting=${admin.actor.id}`)).status, 200);
			assert.strictEqual((await request(`?acting=${admin.actor.id.toUpperCase()}`)).status, 200);
			// the second actor holds no admin grant, so the role gate refuses it
			assert.strictEqual((await request(`?acting=${other_actor_id}`)).status, 403);
			// a valid id of no actor on the account
			const stranger = await request('?acting=f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
			assert.strictEqual(stranger.status, 400);
			assert.strictEqual(await read_error(stranger), 'actor_not_on_account');
		} finally {
			await test_app.cleanup();
		}
	});

	test('a repeated `acting` is read at its first occurrence', async () => {
		const { test_app, admin, other_actor_id, request } = await setup();
		try {
			assert.strictEqual(
				(await request(`?acting=${admin.actor.id}&acting=${other_actor_id}`)).status,
				200
			);
			assert.strictEqual(
				(await request(`?acting=${other_actor_id}&acting=${admin.actor.id}`)).status,
				403
			);
			assert.strictEqual((await request(`?acting=${admin.actor.id}&acting=junk`)).status, 200);
			const junk_first = await request(`?acting=junk&acting=${admin.actor.id}`);
			assert.strictEqual(junk_first.status, 400);
			assert.strictEqual(await read_error(junk_first), 'invalid_query_params');
		} finally {
			await test_app.cleanup();
		}
	});

	test('a bare `?acting` is the empty string, a uuid issue', async () => {
		const { test_app, request } = await setup();
		try {
			for (const query of ['?acting', '?acting=']) {
				const res = await request(query);
				assert.strictEqual(res.status, 400, query);
				assert.deepStrictEqual(
					await res.json(),
					{
						error: 'invalid_query_params',
						issues: [
							{
								kind: 'uuid',
								path: ['acting'],
								expected: 'uuid',
								received: 'string',
								message: 'acting: expected uuid, received string'
							}
						]
					},
					query
				);
			}
		} finally {
			await test_app.cleanup();
		}
	});

	test('a percent-encoded id decodes to the id', async () => {
		const { test_app, admin, other_actor_id, request } = await setup();
		try {
			assert.strictEqual(
				(await request(`?acting=${percent_encode_all(admin.actor.id.toUpperCase())}`)).status,
				200
			);
			assert.strictEqual(
				(await request(`?acting=${percent_encode_all(other_actor_id)}`)).status,
				403
			);
			// an encoded key reads as its decoded name
			assert.strictEqual(
				(await request(`?${percent_encode_all('acting')}=${admin.actor.id}`)).status,
				200
			);
		} finally {
			await test_app.cleanup();
		}
	});

	test('an own `__proto__` key is an unknown key, before the authorization phase', async () => {
		const { test_app, admin, request } = await setup();
		try {
			for (const query of ['?__proto__=1', `?acting=${admin.actor.id}&__proto__=1`]) {
				const res = await request(query);
				assert.strictEqual(res.status, 400, query);
				assert.deepStrictEqual(
					await res.json(),
					{
						error: 'invalid_query_params',
						issues: [
							{
								kind: 'unknown_key',
								path: ['__proto__'],
								expected: 'no unknown keys',
								received: 'string',
								message: '__proto__: expected no unknown keys, received string'
							}
						]
					},
					query
				);
			}
		} finally {
			await test_app.cleanup();
		}
	});
});
