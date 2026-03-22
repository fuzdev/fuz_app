/**
 * Tests for `create_test_app_server` factory.
 *
 * @module
 */

import {test, assert, beforeAll, beforeEach, afterAll} from 'vitest';
import {z} from 'zod';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {ROLE_KEEPER} from '$lib/auth/role_schema.js';
import {create_health_route_spec} from '$lib/http/common_routes.js';
import {create_app_server} from '$lib/server/app_server.js';
import {create_test_app_server} from '$lib/testing/app_server.js';
import {AUTH_TRUNCATE_TABLES} from '$lib/testing/db.js';
import {query_permit_find_active_for_actor} from '$lib/auth/permit_queries.js';

import {pglite_factory} from '../db_fixture.js';

const session_options = create_session_config('test_session');

let db: Awaited<ReturnType<typeof pglite_factory.create>>;

beforeAll(async () => {
	db = await pglite_factory.create();
});

beforeEach(async () => {
	for (const table of AUTH_TRUNCATE_TABLES) {
		await db.query(`TRUNCATE ${table} CASCADE`);
	}
});

afterAll(async () => {
	await pglite_factory.close(db);
});

test('creates a bootstrapped auth server', async () => {
	const server = await create_test_app_server({session_options, db});

	// Account exists with default username
	assert.strictEqual(server.account.username, 'keeper');

	// API token has the expected prefix
	assert.ok(server.api_token.startsWith('secret_fuz_token_'));

	// Session cookie is signed (non-empty)
	assert.ok(server.session_cookie.length > 0);

	// DB is live — account exists
	const rows = await server.deps.db.query('SELECT id FROM account LIMIT 1');
	assert.isTrue(rows.length > 0);
});

test('custom username and roles are applied', async () => {
	const server = await create_test_app_server({
		session_options,
		db,
		username: 'admin',
		roles: [ROLE_KEEPER, 'admin'],
	});

	assert.strictEqual(server.account.username, 'admin');

	const permits = await query_permit_find_active_for_actor({db: server.deps.db}, server.actor.id);
	assert.strictEqual(permits.length, 2);
});

test('works with create_app_server', async () => {
	const test_server = await create_test_app_server({session_options, db});

	const {app} = await create_app_server({
		backend: test_server,
		session_options,
		allowed_origins: [/^http:\/\/localhost/],
		proxy: {
			trusted_proxies: ['127.0.0.1'],
			get_connection_ip: () => '127.0.0.1',
		},
		create_route_specs: () => [create_health_route_spec()],
		env_schema: z.object({}),
	});

	const res = await app.request('/health');
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.status, 'ok');
});
