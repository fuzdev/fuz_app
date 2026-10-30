/**
 * Cross-backend boot gate for the pool checkout bounds.
 *
 * `global_setup_timing.ts` starts BOTH impls with `FUZ_DB_CHECKOUT_TIMEOUT_MS`
 * and `FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS` set — the Rust `testing_spine_stub`
 * over real Postgres, where they bound its pool, and the TS spine over
 * in-memory pglet, which has no pool and warns that they have no effect. Both
 * must accept the values at boot and keep serving: `/health` answers, and
 * `/ready` reads the database (a checkout under the shortened bound on the
 * stub) and answers ready.
 *
 * Runs under the dedicated `cross_backend_timing` project, whose backends
 * nothing else shares.
 *
 * @module
 */

import { assert, describe, inject, test } from 'vitest';

import { reconstruct_bootstrapped_handle } from '#lib/testing/cross_backend/setup.ts';

import './cross_test_types.ts';

const handles = [
	reconstruct_bootstrapped_handle(inject('timing_handle_a')),
	reconstruct_bootstrapped_handle(inject('timing_handle_b'))
];

describe('the pool checkout bounds at boot', () => {
	for (const handle of handles) {
		test(`${handle.config.name} serves /health and /ready with the bounds set`, async () => {
			const health = await fetch(`${handle.config.base_url}/health`);
			assert.strictEqual(health.status, 200);
			await health.body?.cancel();
			const ready = await fetch(`${handle.config.base_url}/ready`);
			assert.strictEqual(ready.status, 200);
			assert.deepStrictEqual(await ready.json(), { ready: true });
		});
	}
});
