/**
 * Tests for `create_app_backend` — isolated from `create_app_server.test.ts`
 * because each call creates an uncached PGlite instance (~1-2s cold start).
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';

import {create_keyring} from '$lib/auth/keyring.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_health_route_spec} from '$lib/http/common_routes.js';
import {create_app_server, type AppServerOptions} from '$lib/server/app_server.js';
import {create_app_backend, type AppBackend} from '$lib/server/app_backend.js';
import {stub_password_deps} from '$lib/testing/app_server.js';
import {AUTH_MIGRATION_NAMESPACE} from '$lib/auth/migrations.js';
import type {MigrationNamespace} from '$lib/db/migrate.js';

// 32+ char key for keyring
const TEST_KEY = 'test-key-that-is-at-least-32-chars-long!!';
const keyring = create_keyring(TEST_KEY)!;
const session_options = create_session_config('test_session');

const fs_stubs = {
	stat: async () => null,
	read_text_file: async () => '',
	delete_file: async (_path: string) => {},
};

/** Shared option fields (everything except backend). */
const base_config: Omit<AppServerOptions, 'backend'> = {
	session_options,
	allowed_origins: [/^http:\/\/localhost/],
	proxy: {
		trusted_proxies: ['127.0.0.1'],
		get_connection_ip: () => '127.0.0.1',
	},
	create_route_specs: () => [create_health_route_spec()],
	env_schema: z.object({}),
};

/** Create options with a pre-initialized backend. */
const create_server_config = (
	backend: AppBackend,
	overrides?: Partial<AppServerOptions>,
): AppServerOptions => ({
	backend,
	...base_config,
	...overrides,
});

describe('create_app_backend', () => {
	test(
		'accepts pre-initialized backend (skips create_app_backend)',
		{timeout: 15_000},
		async () => {
			const external_backend = await create_app_backend({
				database_url: 'memory://',
				keyring,
				password: stub_password_deps,
				...fs_stubs,
			});

			const result = await create_app_server(create_server_config(external_backend));

			// App works
			const res = await result.app.request('/health');
			assert.strictEqual(res.status, 200);

			await external_backend.close();
		},
	);

	test(
		'no migration_namespaces option runs only the auth namespace',
		{timeout: 15_000},
		async () => {
			const backend = await create_app_backend({
				database_url: 'memory://',
				keyring,
				password: stub_password_deps,
				...fs_stubs,
			});

			const namespaces = backend.migration_results.map((r) => r.namespace);
			assert.deepStrictEqual(namespaces, [AUTH_MIGRATION_NAMESPACE]);

			await backend.close();
		},
	);

	test(
		'migration_namespaces option splices consumer migrations after auth',
		{timeout: 15_000},
		async () => {
			const ran: Array<string> = [];
			const ns: MigrationNamespace = {
				namespace: 'test_ns_a',
				migrations: [
					{
						name: 'v0',
						up: async (db) => {
							ran.push('a_v0');
							await db.query('CREATE TABLE test_ns_a_table (id SERIAL PRIMARY KEY)');
						},
					},
				],
			};

			const backend = await create_app_backend({
				database_url: 'memory://',
				keyring,
				password: stub_password_deps,
				...fs_stubs,
				migration_namespaces: [ns],
			});

			assert.deepStrictEqual(ran, ['a_v0']);

			const namespaces = backend.migration_results.map((r) => r.namespace);
			assert.deepStrictEqual(namespaces, [AUTH_MIGRATION_NAMESPACE, 'test_ns_a']);

			// schema_version row should reflect the consumer namespace
			const rows = await backend.deps.db.query<{namespace: string; name: string}>(
				"SELECT namespace, name FROM schema_version WHERE namespace = 'test_ns_a' ORDER BY sequence",
			);
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.name, 'v0');

			await backend.close();
		},
	);

	test(
		'migration_namespaces preserves order across multiple namespaces',
		{timeout: 15_000},
		async () => {
			const ran: Array<string> = [];
			const ns_a: MigrationNamespace = {
				namespace: 'order_a',
				migrations: [
					{
						name: 'a_v0',
						up: async () => {
							ran.push('a');
						},
					},
				],
			};
			const ns_b: MigrationNamespace = {
				namespace: 'order_b',
				migrations: [
					{
						name: 'b_v0',
						up: async () => {
							ran.push('b');
						},
					},
				],
			};

			const backend = await create_app_backend({
				database_url: 'memory://',
				keyring,
				password: stub_password_deps,
				...fs_stubs,
				migration_namespaces: [ns_a, ns_b],
			});

			assert.deepStrictEqual(ran, ['a', 'b']);
			const namespaces = backend.migration_results.map((r) => r.namespace);
			assert.deepStrictEqual(namespaces, [AUTH_MIGRATION_NAMESPACE, 'order_a', 'order_b']);

			await backend.close();
		},
	);

	test(
		"migration_namespaces rejects the reserved 'fuz_auth' namespace",
		{timeout: 15_000},
		async () => {
			await assert_rejects(
				() =>
					create_app_backend({
						database_url: 'memory://',
						keyring,
						password: stub_password_deps,
						...fs_stubs,
						migration_namespaces: [{namespace: AUTH_MIGRATION_NAMESPACE, migrations: []}],
					}),
				/reserved by fuz_app/,
			);
		},
	);
});
