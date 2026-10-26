/**
 * Tests for `create_cross_backend_global_setup` — the options it refuses
 * before any backend spawns, and the order a setup runs its hook, its config
 * factory, its database creation and its spawn in.
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
	({ env: { DATABASE_URL: database_url } }) as unknown as BackendConfig;

const SPAWN_STOPPED = 'spawn stopped by the test';

/** Deps recording each call, whose spawn throws so no backend starts. */
const recording_deps = (calls: Array<string>): CrossBackendGlobalSetupDeps => ({
	ensure_database_for_url: (url) => calls.push(`ensure ${url}`),
	bootstrap_backend: () => {
		calls.push('spawn');
		return Promise.reject(new Error(SPAWN_STOPPED));
	}
});

const project = (name: string): TestProject => ({ name }) as unknown as TestProject;

describe('create_cross_backend_global_setup', () => {
	test('a before_spawn hook naming no config throws, prototype keys included', () => {
		for (const name of ['rsut', 'constructor', 'toString']) {
			assert.throws(
				() =>
					create_cross_backend_global_setup({
						configs: { rust: unused_config },
						before_spawn: { [name]: () => undefined }
					}),
				new RegExp(`before_spawn names '${name}'`)
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

	test("the selected backend's hook runs before its config factory, then the database, then the spawn", async () => {
		const calls: Array<string> = [];
		const setup = create_cross_backend_global_setup(
			{
				configs: {
					rust: () => {
						calls.push('rust config');
						return stub_config('postgres://localhost/app_test_rust');
					},
					deno: () => {
						calls.push('deno config');
						return stub_config('memory://');
					}
				},
				before_spawn: {
					rust: () => calls.push('rust hook'),
					deno: () => calls.push('deno hook')
				},
				ensure_databases: true
			},
			recording_deps(calls)
		);
		try {
			await setup(project('cross_backend_rust'));
			assert.fail('expected the stopped spawn');
		} catch (error) {
			assert.strictEqual((error as Error).message, SPAWN_STOPPED);
		}
		assert.deepStrictEqual(calls, [
			'rust hook',
			'rust config',
			'ensure postgres://localhost/app_test_rust',
			'spawn'
		]);
	});

	test('without ensure_databases no database is created', async () => {
		const calls: Array<string> = [];
		const setup = create_cross_backend_global_setup(
			{ configs: { rust: () => stub_config('postgres://localhost/app_test_rust') } },
			recording_deps(calls)
		);
		try {
			await setup(project('cross_backend_rust'));
		} catch {
			// the stopped spawn
		}
		assert.deepStrictEqual(calls, ['spawn']);
	});
});
