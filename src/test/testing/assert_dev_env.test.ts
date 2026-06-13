/**
 * Production-exclusion guard for the `testing/` tree.
 *
 * Every module under `src/lib/testing/` begins with
 * `import './assert_dev_env.js';` — a side-effect import that reads `DEV`
 * from `esm-env` and throws at module-evaluation time when `DEV` is false.
 * That is the load-time fence keeping the test backdoor (`_testing_*`
 * actions, deterministic secrets, the fast Argon2 stub) out of a production
 * bundle: a build with `DEV=false` that reaches a testing module crashes on
 * import instead of silently shipping the backdoor.
 *
 * Vitest runs with `DEV=true`, so the throw branch is never hit incidentally.
 * This test forces `DEV=false` via a scoped `esm-env` mock + a fresh module
 * graph, then dynamically imports the guard and asserts it throws — pinning
 * the production short-circuit nothing else exercises.
 *
 * @module
 */

import {test, assert, afterEach, vi} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';

afterEach(() => {
	vi.doUnmock('esm-env');
	vi.resetModules();
});

test('assert_dev_env throws at import time when DEV is false', async () => {
	vi.resetModules();
	vi.doMock('esm-env', () => ({DEV: false}));
	// The throw happens during module evaluation, so the dynamic import
	// promise itself rejects.
	const err = await assert_rejects(
		() => import('$lib/testing/assert_dev_env.js'),
		/must not be imported in production/,
	);
	assert.ok(err instanceof Error);
});

test('assert_dev_env does not throw when DEV is true', async () => {
	vi.resetModules();
	vi.doMock('esm-env', () => ({DEV: true}));
	// Must resolve (no throw) — the development/test path.
	await import('$lib/testing/assert_dev_env.js');
});
