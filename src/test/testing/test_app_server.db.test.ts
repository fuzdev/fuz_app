/**
 * Tests for `create_test_app_server` factory.
 *
 * @module
 */

import { test, assert, beforeAll, beforeEach, afterAll } from 'vitest';
import { z } from 'zod';

import type { RequestResponseActionSpec } from '$lib/actions/action_spec.ts';
import type { RpcAction } from '$lib/actions/action_rpc.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import { ROLE_KEEPER } from '$lib/auth/role_schema.ts';
import { create_health_route_spec } from '$lib/http/common_routes.ts';
import { create_app_server } from '$lib/server/app_server.ts';
import { create_test_app, create_test_app_server } from '$lib/testing/app_server.ts';
import { auth_truncate_tables } from '$lib/testing/db.ts';
import { query_role_grant_find_active_for_actor } from '$lib/auth/role_grant_queries.ts';

import { pglite_factory } from '../db_fixture.ts';

const session_options = create_session_config('test_session');

let db: Awaited<ReturnType<typeof pglite_factory.create>>;

beforeAll(async () => {
	db = await pglite_factory.create();
});

beforeEach(async () => {
	for (const table of auth_truncate_tables) {
		await db.query(`TRUNCATE ${table} CASCADE`);
	}
});

afterAll(async () => {
	await pglite_factory.close(db);
});

test('creates a bootstrapped auth server', async () => {
	const server = await create_test_app_server({ session_options, db });

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
		roles: [ROLE_KEEPER, 'admin']
	});

	assert.strictEqual(server.account.username, 'admin');

	const role_grants = await query_role_grant_find_active_for_actor(
		{ db: server.deps.db },
		server.actor.id
	);
	assert.strictEqual(role_grants.length, 2);
});

test('works with create_app_server', async () => {
	const test_server = await create_test_app_server({ session_options, db });

	const { app } = await create_app_server({
		backend: test_server,
		session_options,
		allowed_origins: [/^http:\/\/localhost/],
		proxy: {
			trusted_proxies: ['127.0.0.1'],
			get_connection_ip: () => '127.0.0.1'
		},
		create_route_specs: () => [create_health_route_spec()],
		env_schema: z.object({})
	});

	const res = await app.request('/health');
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.status, 'ok');
});

// --- create_test_app: top-level `rpc_endpoints` option (15g) ---------------

const widget_list_spec: RequestResponseActionSpec = {
	method: 'widget_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'none', actor: 'none' },
	side_effects: false,
	input: z.void(),
	output: z.strictObject({ items: z.array(z.string()) }),
	async: true,
	description: 'List widgets'
};

const widget_actions: Array<RpcAction> = [
	{ spec: widget_list_spec, handler: () => ({ items: ['a'] }) }
];

test('create_test_app forwards top-level rpc_endpoints to create_app_server', async () => {
	const test_app = await create_test_app({
		session_options,
		db,
		create_route_specs: () => [],
		rpc_endpoints: [{ path: '/api/rpc', actions: widget_actions }]
	});
	try {
		assert.strictEqual(test_app.surface.rpc_endpoints.length, 1);
		assert.strictEqual(test_app.surface.rpc_endpoints[0]?.path, '/api/rpc');
	} finally {
		await test_app.cleanup();
	}
});

// `backend.deps.audit` closes over the threaded `audit_log_config`.
// Emit-time validation behavior of the threaded config is covered by
// `auth/audit_log_queries.db.test.ts`'s `AuditEmitter.emit forwards config
// to query_audit_log` test, which uses the same threading path.
