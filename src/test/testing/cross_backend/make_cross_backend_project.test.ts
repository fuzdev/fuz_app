/**
 * Unit tests for `make_cross_backend_project` — the vitest project factory
 * consumers spread into `test.projects`.
 *
 * Pins the emitted shape: the name flows through verbatim (the paired
 * `create_cross_backend_global_setup` derives the backend from it), the
 * spawned-backend invariants (`isolate: false`, `fileParallelism: false`)
 * are fixed, and both timeouts are **always** emitted so a consumer's root
 * `testTimeout` / `hookTimeout` can never leak a 5 s budget into a suite
 * that spawns a backend.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { make_cross_backend_project } from '$lib/testing/cross_backend/make_cross_backend_project.ts';

const GLOBAL_SETUP = './src/test/cross_backend/global_setup.ts';

describe('make_cross_backend_project', () => {
	test('emits the full default shape', () => {
		assert.deepStrictEqual(
			make_cross_backend_project({ name: 'cross_backend_rust', global_setup: GLOBAL_SETUP }),
			{
				extends: true,
				test: {
					name: 'cross_backend_rust',
					include: ['src/test/cross_backend/*.cross.test.ts'],
					exclude: [],
					globalSetup: [GLOBAL_SETUP],
					isolate: false,
					fileParallelism: false,
					sequence: { groupOrder: 3 },
					testTimeout: 30_000,
					hookTimeout: 30_000
				}
			}
		);
	});

	test('timeouts are always emitted, never left to the consumer root config', () => {
		const { test: project } = make_cross_backend_project({
			name: 'cross_backend_ts_deno',
			global_setup: GLOBAL_SETUP
		});
		assert.ok('testTimeout' in project);
		assert.ok('hookTimeout' in project);
	});

	test('overrides flow through', () => {
		const { test: project } = make_cross_backend_project({
			name: 'cross_backend_schema_parity',
			global_setup: GLOBAL_SETUP,
			include: ['src/test/cross_backend/parity/*.cross.test.ts'],
			exclude: ['src/test/cross_backend/parity/skip_me.cross.test.ts'],
			group_order: 4,
			test_timeout: 90_000,
			hook_timeout: 120_000
		});
		assert.deepStrictEqual(project.include, ['src/test/cross_backend/parity/*.cross.test.ts']);
		assert.deepStrictEqual(project.exclude, [
			'src/test/cross_backend/parity/skip_me.cross.test.ts'
		]);
		assert.strictEqual(project.sequence.groupOrder, 4);
		assert.strictEqual(project.testTimeout, 90_000);
		assert.strictEqual(project.hookTimeout, 120_000);
	});

	test('include + exclude are copied, not aliased to the caller arrays', () => {
		const include = ['a'];
		const exclude = ['b'];
		const { test: project } = make_cross_backend_project({
			name: 'cross_backend_rust',
			global_setup: GLOBAL_SETUP,
			include,
			exclude
		});
		include.push('mutated');
		exclude.push('mutated');
		assert.deepStrictEqual(project.include, ['a']);
		assert.deepStrictEqual(project.exclude, ['b']);
	});
});
