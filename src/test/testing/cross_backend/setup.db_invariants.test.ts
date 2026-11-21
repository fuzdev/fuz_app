/**
 * `default_cross_process_setup`'s requirement on the invariants backdoor: a
 * backend not declaring `_testing_db_invariants` throws when the setup is
 * built, naming both ways out, and `exclude_db_invariants: {all}` lifts it.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	default_cross_process_setup,
	type ReconstructedBootstrappedBackendHandle
} from '#lib/testing/cross_backend/setup.ts';
import type { TestingBackdoorMethod } from '#lib/testing/cross_backend/spine_surface_constants.ts';

/** A stub handle whose backend declares `testing_backdoors`. */
const handle_declaring = (
	testing_backdoors: ReadonlyArray<TestingBackdoorMethod>
): ReconstructedBootstrappedBackendHandle =>
	({
		config: { name: 'stub', capabilities: { testing_backdoors }, env: {} }
	}) as unknown as ReconstructedBootstrappedBackendHandle;

const HARNESS: ReadonlyArray<TestingBackdoorMethod> = ['_testing_reset', '_testing_drain_effects'];

test('a backend not declaring _testing_db_invariants throws, naming both ways out', () => {
	assert.throws(
		() => default_cross_process_setup(handle_declaring(HARNESS)),
		/default_cross_process_setup\(stub\): the backend doesn't declare _testing_db_invariants.*exclude_db_invariants: \{all: '<reason>'\}.*setup: \{exclude_db_invariants: \{all: '<reason>'\}\}/
	);
});

test('the check turned off with all, or the backdoor declared, builds the setup', () => {
	assert.isFunction(
		default_cross_process_setup(handle_declaring(HARNESS), {
			exclude_db_invariants: { all: 'not under test' }
		})
	);
	assert.isFunction(
		default_cross_process_setup(handle_declaring([...HARNESS, '_testing_db_invariants']))
	);
});
