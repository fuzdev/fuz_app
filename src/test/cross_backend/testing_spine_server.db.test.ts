/**
 * The TS spine binary's app, built with the Node runtime adapter, mounts its
 * WebSocket endpoint through `create_app_server`'s `ws_endpoints` auto-mount —
 * so the endpoint is on the generated surface, which passes the structural
 * invariants.
 *
 * In-process: builds the same app `testing_spine_server_node.ts` serves (real
 * `@hono/node-ws` preparation, in-memory PGlite) without binding a port. The
 * spawned binaries' WS behavior is covered by the cross-backend suites.
 *
 * @module
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, test } from 'vitest';

import { create_node_runtime } from '$lib/runtime/node.ts';
import { default_test_cookie_keys } from '$lib/testing/cross_backend/default_secrets.ts';
import { create_node_testing_adapter } from '$lib/testing/cross_backend/testing_server_node.ts';
import {
	assert_rpc_method_descriptions_present,
	assert_surface_invariants,
	assert_ws_endpoints_include_protocol_actions,
	assert_ws_method_descriptions_present,
	assert_ws_notifications_have_null_auth
} from '$lib/testing/surface_invariants.ts';

import { build_spine_app } from './testing_spine_server.ts';

const SPINE_ENV: Record<string, string> = {
	NODE_ENV: 'development',
	HOST: 'localhost',
	DATABASE_URL: 'memory://',
	SECRET_FUZ_COOKIE_KEYS: default_test_cookie_keys,
	FUZ_ALLOWED_ORIGINS: 'http://localhost:*'
};

test('the Node-built spine surface lists /api/ws and passes the surface invariants', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'fuz_app_spine_surface_'));
	const runtime = { ...create_node_runtime([]), env_get: (name: string) => SPINE_ENV[name] };
	const adapter = create_node_testing_adapter();
	const built = await build_spine_app({
		runtime,
		get_connection_ip: adapter.get_connection_ip,
		daemon_token_path: join(dir, 'run', 'daemon_token'),
		prepare_websocket: (options) => adapter.prepare_websocket(options).create_upgrade_websocket
	});
	try {
		const ws_paths = built.surface.ws_endpoints.map((endpoint) => endpoint.path);
		assert.deepStrictEqual(ws_paths, ['/api/ws']);
		assert_surface_invariants(built.surface);
		// the RPC/WS bundle minus `assert_no_testing_methods`: the binary
		// live-mounts the `_testing_*` backdoors on its RPC and WS endpoints by design
		assert_rpc_method_descriptions_present(built.surface);
		assert_ws_method_descriptions_present(built.surface);
		assert_ws_endpoints_include_protocol_actions(built.surface);
		assert_ws_notifications_have_null_auth(built.surface);
	} finally {
		await built.close();
		await rm(dir, { recursive: true, force: true });
	}
});
