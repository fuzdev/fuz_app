/**
 * Tests for `create_app_backend` — isolated from `create_app_server.test.ts`
 * because each call creates an uncached PGlite instance (~1-2s cold start).
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import {create_keyring} from '$lib/auth/keyring.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_health_route_spec} from '$lib/http/common_routes.js';
import {create_app_server, type AppServerOptions} from '$lib/server/app_server.js';
import {create_app_backend, type AppBackend} from '$lib/server/app_backend.js';
import {stub_password_deps} from '$lib/testing/app_server.js';

// 32+ char key for keyring
const TEST_KEY = 'test-key-that-is-at-least-32-chars-long!!';
const keyring = create_keyring(TEST_KEY)!;
const session_options = create_session_config('test_session');

const fs_stubs = {
	stat: async () => null,
	read_file: async () => '',
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

	test('migration_namespaces run with pre-initialized backend', {timeout: 15_000}, async () => {
		let migration_ran = false;
		const external_backend = await create_app_backend({
			database_url: 'memory://',
			keyring,
			password: stub_password_deps,
			...fs_stubs,
		});

		await create_app_server(
			create_server_config(external_backend, {
				migration_namespaces: [
					{
						namespace: 'test_ns',
						migrations: [
							async () => {
								migration_ran = true;
							},
						],
					},
				],
			}),
		);

		assert.isTrue(migration_ran);

		await external_backend.close();
	});
});
