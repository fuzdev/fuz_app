/**
 * Tests for `create_app_backend` — isolated from `create_app_server.test.ts`
 * because each call creates an uncached PGlite instance (~1-2s cold start).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { create_keyring } from '$lib/auth/keyring.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_health_route_spec } from '$lib/http/common_routes.ts';
import { create_app_server, type AppServerOptions } from '$lib/server/app_server.ts';
import { create_app_backend, type AppBackend, type AuditFactory } from '$lib/server/app_backend.ts';
import { stub_password_deps } from '$lib/testing/app_server.ts';
import { AUTH_MIGRATION_NAMESPACE } from '$lib/auth/migrations.ts';
import type { MigrationNamespace } from '$lib/db/migrate.ts';
import { create_audit_emitter } from '$lib/auth/audit_emitter.ts';

// 32+ char key for keyring
const TEST_KEY = 'test-key-that-is-at-least-32-chars-long!!';
const keyring = create_keyring(TEST_KEY)!;
const session_options = create_session_config('test_session');

const fs_stubs = {
	stat: async () => null,
	read_text_file: async () => '',
	delete_file: async (_path: string) => {}
};

/** Canonical default audit factory — every test uses this unless it cares about emitter wiring. */
const test_audit_factory: AuditFactory = ({ db, log }) => create_audit_emitter({ db, log });

/** Shared option fields (everything except backend). */
const base_config: Omit<AppServerOptions, 'backend'> = {
	session_options,
	allowed_origins: [/^http:\/\/localhost/],
	proxy: {
		trusted_proxies: ['127.0.0.1'],
		get_connection_ip: () => '127.0.0.1'
	},
	create_route_specs: () => [create_health_route_spec()],
	env_schema: z.object({})
};

/** Create options with a pre-initialized backend. */
const create_server_config = (
	backend: AppBackend,
	overrides?: Partial<AppServerOptions>
): AppServerOptions => ({
	backend,
	...base_config,
	...overrides
});

describe('create_app_backend', () => {
	test(
		'accepts pre-initialized backend (skips create_app_backend)',
		{ timeout: 15_000 },
		async () => {
			const external_backend = await create_app_backend({
				database_url: 'memory://',
				keyring,
				password: stub_password_deps,
				...fs_stubs,
				audit_factory: test_audit_factory
			});

			const result = await create_app_server(create_server_config(external_backend));

			// App works
			const res = await result.app.request('/health');
			assert.strictEqual(res.status, 200);

			await external_backend.close();
		}
	);

	test(
		'no migration_namespaces option runs only the auth namespace',
		{ timeout: 15_000 },
		async () => {
			const backend = await create_app_backend({
				database_url: 'memory://',
				keyring,
				password: stub_password_deps,
				...fs_stubs,
				audit_factory: test_audit_factory
			});

			const namespaces = backend.migration_results.map((r) => r.namespace);
			assert.deepStrictEqual(namespaces, [AUTH_MIGRATION_NAMESPACE]);

			await backend.close();
		}
	);

	test(
		'migration_namespaces option splices consumer migrations after auth',
		{ timeout: 15_000 },
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
						}
					}
				]
			};

			const backend = await create_app_backend({
				database_url: 'memory://',
				keyring,
				password: stub_password_deps,
				...fs_stubs,
				audit_factory: test_audit_factory,
				migration_namespaces: [ns]
			});

			assert.deepStrictEqual(ran, ['a_v0']);

			const namespaces = backend.migration_results.map((r) => r.namespace);
			assert.deepStrictEqual(namespaces, [AUTH_MIGRATION_NAMESPACE, 'test_ns_a']);

			// schema_version row should reflect the consumer namespace
			const rows = await backend.deps.db.query<{ namespace: string; name: string }>(
				"SELECT namespace, name FROM schema_version WHERE namespace = 'test_ns_a' ORDER BY sequence"
			);
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0]!.name, 'v0');

			await backend.close();
		}
	);

	test(
		'migration_namespaces preserves order across multiple namespaces',
		{ timeout: 15_000 },
		async () => {
			const ran: Array<string> = [];
			const ns_a: MigrationNamespace = {
				namespace: 'order_a',
				migrations: [
					{
						name: 'a_v0',
						up: async () => {
							ran.push('a');
						}
					}
				]
			};
			const ns_b: MigrationNamespace = {
				namespace: 'order_b',
				migrations: [
					{
						name: 'b_v0',
						up: async () => {
							ran.push('b');
						}
					}
				]
			};

			const backend = await create_app_backend({
				database_url: 'memory://',
				keyring,
				password: stub_password_deps,
				...fs_stubs,
				audit_factory: test_audit_factory,
				migration_namespaces: [ns_a, ns_b]
			});

			assert.deepStrictEqual(ran, ['a', 'b']);
			const namespaces = backend.migration_results.map((r) => r.namespace);
			assert.deepStrictEqual(namespaces, [AUTH_MIGRATION_NAMESPACE, 'order_a', 'order_b']);

			await backend.close();
		}
	);

	test(
		"migration_namespaces rejects the reserved 'fuz_auth' namespace",
		{ timeout: 15_000 },
		async () => {
			await assert_rejects(
				() =>
					create_app_backend({
						database_url: 'memory://',
						keyring,
						password: stub_password_deps,
						...fs_stubs,
						audit_factory: test_audit_factory,
						migration_namespaces: [{ namespace: AUTH_MIGRATION_NAMESPACE, migrations: [] }]
					}),
				/reserved by fuz_app/
			);
		}
	);

	// --- audit_factory contract ---
	//
	// `audit_factory` is the new public API surface — every consumer threads
	// `on_audit_event` / `audit_log_config` through its body, so the contract
	// (called once, after migrations, with the `{db, log}` handlers later see,
	// not called on early-throw paths) is load-bearing for downstream wiring.

	test(
		'audit_factory is called exactly once with {db, log} matching deps',
		{ timeout: 15_000 },
		async () => {
			const calls: Array<{ db: object; log: object }> = [];
			const backend = await create_app_backend({
				database_url: 'memory://',
				keyring,
				password: stub_password_deps,
				...fs_stubs,
				audit_factory: ({ db, log }) => {
					calls.push({ db, log });
					return create_audit_emitter({ db, log });
				}
			});

			assert.strictEqual(calls.length, 1, 'audit_factory must run exactly once');
			// Reference identity — handlers will reach `deps.db` / `deps.log`
			// through `RouteContext` / `ActionContext`; mismatched references
			// would route audit writes to a different pool than queries.
			assert.strictEqual(calls[0]!.db, backend.deps.db);
			assert.strictEqual(calls[0]!.log, backend.deps.log);

			await backend.close();
		}
	);

	test(
		'audit_factory return value lands on deps.audit (no shallow copy)',
		{ timeout: 15_000 },
		async () => {
			// Reference identity is the strongest contract — proves the factory
			// output flows through to `AppDeps.audit` without being re-wrapped or
			// shallow-copied (the latter would silently break listener
			// composition — `add_listener` — by `create_app_server`).
			let returned: ReturnType<typeof create_audit_emitter> | null = null;
			const backend = await create_app_backend({
				database_url: 'memory://',
				keyring,
				password: stub_password_deps,
				...fs_stubs,
				audit_factory: ({ db, log }) => {
					returned = create_audit_emitter({ db, log });
					return returned;
				}
			});

			assert.strictEqual(backend.deps.audit, returned);

			await backend.close();
		}
	);

	test(
		'audit_factory runs AFTER migrations — body can query migrated tables',
		{ timeout: 15_000 },
		async () => {
			// `audit_log` is created by the v0 migration; if the factory ran
			// before migrations, this SELECT would fail with "relation does
			// not exist". Pins migration-then-factory ordering at the contract
			// level so a refactor that hoisted factory-construction above
			// `run_migrations` surfaces here instead of in some downstream
			// consumer's runtime.
			let migration_check!: Promise<Array<{ n: number }>>;
			const backend = await create_app_backend({
				database_url: 'memory://',
				keyring,
				password: stub_password_deps,
				...fs_stubs,
				audit_factory: ({ db, log }) => {
					migration_check = db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM audit_log');
					return create_audit_emitter({ db, log });
				}
			});
			const rows = await migration_check;
			assert.strictEqual(rows[0]?.n, 0, 'audit_log must exist and be empty by factory time');

			await backend.close();
		}
	);

	test(
		'audit_factory is NOT called when reserved-namespace check rejects',
		{ timeout: 15_000 },
		async () => {
			let called = false;
			await assert_rejects(
				() =>
					create_app_backend({
						database_url: 'memory://',
						keyring,
						password: stub_password_deps,
						...fs_stubs,
						audit_factory: ({ db, log }) => {
							called = true;
							return create_audit_emitter({ db, log });
						},
						migration_namespaces: [{ namespace: AUTH_MIGRATION_NAMESPACE, migrations: [] }]
					}),
				/reserved by fuz_app/
			);
			assert.strictEqual(called, false, 'audit_factory must not run when validation rejects');
		}
	);

	test(
		'a throwing audit_factory propagates the original error and closes the db',
		{ timeout: 15_000 },
		async () => {
			// Pre-decorator-era `create_app_backend` would leak the pool on
			// any post-`create_db` throw — `close` was only returned on the
			// success path. The try/catch added alongside the audit_factory
			// refactor guards every post-`create_db` step: reserved-namespace,
			// `run_migrations`, the factory itself.
			//
			// Strongest signal we can grab without mocking `create_db`:
			// the original error reaches the caller verbatim (the cleanup
			// `try/catch` swallows close errors and re-throws the audit
			// failure, not a teardown-shaped one). PGlite's `memory://`
			// driver has no observable resource state to assert against
			// — verifying the close call itself would need a `vi.mock` of
			// `create_db`, which conflicts with `.db.test.ts`'s
			// `isolate: false` config.
			const err = await assert_rejects(
				() =>
					create_app_backend({
						database_url: 'memory://',
						keyring,
						password: stub_password_deps,
						...fs_stubs,
						audit_factory: () => {
							throw new Error('audit_factory threw on purpose');
						}
					}),
				/audit_factory threw on purpose/
			);
			// Belt + suspenders — confirm the cleanup `try/catch` didn't
			// swallow the original cause and re-throw a teardown-shaped error.
			assert.strictEqual(err.message, 'audit_factory threw on purpose');
		}
	);
});
