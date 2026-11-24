/**
 * Tests for `create_cross_backend_global_setup` — the options it refuses
 * before any backend spawns, and the order a setup runs its hook, its
 * database, its config factory and its spawn in.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import type { TestProject } from 'vitest/node';

import {
	create_cross_backend_global_setup,
	type CrossBackendGlobalSetupDeps
} from '#lib/testing/cross_backend/create_cross_backend_global_setup.ts';
import type { BackendConfig } from '#lib/testing/cross_backend/backend_config.ts';

const unused_config = (): BackendConfig => {
	throw new Error('not built in these tests');
};

/** A config carrying only what the setup reads before the spawn. */
const stub_config = (database_url: string): BackendConfig =>
	({ name: 'stub', env: { DATABASE_URL: database_url } }) as unknown as BackendConfig;

const SPAWN_STOPPED = 'spawn stopped by the test';

/** Deps recording each call, whose spawn throws so no backend starts. */
const recording_deps = (
	calls: Array<string>,
	postgres_url?: string
): CrossBackendGlobalSetupDeps => ({
	open_test_database: async (options) => {
		calls.push(
			`open ${options.name} on ${options.postgres_url ?? 'pglet'}` +
				(options.pglet_server_bin === null ? ' (postgres only)' : '')
		);
		return {
			url: `postgres://test/${options.name}`,
			engine: options.postgres_url ? 'postgres' : 'pglet',
			empty: async () => undefined,
			close: async () => {
				calls.push(`close ${options.name}`);
			}
		};
	},
	bootstrap_backend: (config) => {
		calls.push(`spawn ${config.env.DATABASE_URL}`);
		return Promise.reject(new Error(SPAWN_STOPPED));
	},
	postgres_url: () => postgres_url
});

const project = (name: string): TestProject => ({ name }) as unknown as TestProject;

/** Run the setup to its stopped spawn. */
const run_to_stopped_spawn = async (
	setup: (project: TestProject) => Promise<unknown>,
	name: string
): Promise<void> => {
	try {
		await setup(project(name));
		assert.fail('expected the stopped spawn');
	} catch (error) {
		assert.strictEqual((error as Error).message, SPAWN_STOPPED);
	}
};

const PGLET_SERVER = { workspace_dir: '/nonexistent/workspace', profile: 'cross-test' };

describe('create_cross_backend_global_setup', () => {
	test('a before_spawn hook or database naming no config throws, prototype keys included', () => {
		for (const name of ['rsut', 'constructor', 'toString']) {
			assert.throws(
				() =>
					create_cross_backend_global_setup({
						configs: { rust: unused_config },
						before_spawn: { [name]: () => undefined }
					}),
				new RegExp(`before_spawn names '${name}'`)
			);
			assert.throws(
				() =>
					create_cross_backend_global_setup({
						configs: { rust: unused_config },
						databases: { [name]: PGLET_SERVER }
					}),
				new RegExp(`databases names '${name}'`)
			);
		}
	});

	test('a project deriving a prototype key finds no config', async () => {
		const setup = create_cross_backend_global_setup({ configs: { rust: unused_config } });
		try {
			await setup(project('cross_backend_constructor'));
			assert.fail('expected a throw');
		} catch (error) {
			assert.include((error as Error).message, "derived name 'constructor'");
		}
	});

	test("the selected backend's hook runs, then its database opens, then its config is built over it and spawned", async () => {
		const calls: Array<string> = [];
		const setup = create_cross_backend_global_setup(
			{
				configs: {
					rust: (database_url) => {
						calls.push(`rust config ${database_url}`);
						return stub_config(database_url);
					},
					node: (database_url) => {
						calls.push(`node config ${database_url}`);
						return stub_config(database_url);
					}
				},
				databases: { rust: PGLET_SERVER },
				before_spawn: {
					rust: () => calls.push('rust hook'),
					node: () => calls.push('node hook')
				}
			},
			recording_deps(calls)
		);
		await run_to_stopped_spawn(setup, 'cross_backend_rust');
		assert.deepStrictEqual(calls, [
			'rust hook',
			'open rust on pglet',
			'rust config postgres://test/rust',
			'spawn postgres://test/rust',
			// a failed spawn closes what was opened for it
			'close rust'
		]);
	});

	test('FUZ_TEST_POSTGRES_URL reaches the database opener', async () => {
		const calls: Array<string> = [];
		const setup = create_cross_backend_global_setup(
			{ configs: { rust: stub_config }, databases: { rust: null } },
			recording_deps(calls, 'postgres://localhost/postgres')
		);
		await run_to_stopped_spawn(setup, 'cross_backend_rust');
		assert.deepStrictEqual(calls, [
			'open rust on postgres://localhost/postgres (postgres only)',
			'spawn postgres://test/rust',
			'close rust'
		]);
	});

	test('a backend databases does not name gets memory:// and no database', async () => {
		const calls: Array<string> = [];
		const setup = create_cross_backend_global_setup(
			{ configs: { node: stub_config } },
			recording_deps(calls)
		);
		await run_to_stopped_spawn(setup, 'cross_backend_ts_node');
		assert.deepStrictEqual(calls, ['spawn memory://']);
	});

	test("a config that ignores its database's URL is refused, naming the backend, and the database closed", async () => {
		const calls: Array<string> = [];
		const setup = create_cross_backend_global_setup(
			{
				configs: { rust: () => stub_config('postgres://localhost/hardcoded') },
				databases: { rust: PGLET_SERVER }
			},
			recording_deps(calls)
		);
		try {
			await setup(project('cross_backend_rust'));
			assert.fail('expected the refusal');
		} catch (error) {
			assert.match((error as Error).message, /backend stub's DATABASE_URL is not the database/);
		}
		assert.deepStrictEqual(calls, ['open rust on pglet', 'close rust']);
	});
});
