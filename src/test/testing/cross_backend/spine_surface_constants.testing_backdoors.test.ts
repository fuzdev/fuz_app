/**
 * Holds `TESTING_BACKDOOR_METHODS` to the `_testing_*` actions fuz_app's spine
 * binary mounts, so a backdoor added to the binary fails until it is listed
 * (and, through the testing-backdoor suite's params record, given params).
 *
 * @module
 */

import { assert, test } from 'vitest';

import { create_spine_live_rpc_endpoints } from '#lib/testing/cross_backend/full_spine_mount.ts';
import { TESTING_BACKDOOR_METHODS } from '#lib/testing/cross_backend/spine_surface_constants.ts';
import { TESTING_METHOD_PREFIX } from '#lib/testing/surface_invariants.ts';

test("the known backdoors are exactly the spine binary's `_testing_*` actions", () => {
	const mounted = create_spine_live_rpc_endpoints()
		.flatMap((endpoint) => endpoint.actions.map((action) => action.spec.method))
		.filter((method) => method.startsWith(TESTING_METHOD_PREFIX));
	assert.deepStrictEqual([...TESTING_BACKDOOR_METHODS].sort(), [...mounted].sort());
	assert.strictEqual(new Set(TESTING_BACKDOOR_METHODS).size, TESTING_BACKDOOR_METHODS.length);
});
