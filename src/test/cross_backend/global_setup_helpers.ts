/**
 * Shared `globalSetup` maker for the cross-process self-test projects.
 *
 * Each `cross_backend_*` vitest project points at a one-line `global_setup_*.ts`
 * that calls {@link make_spine_global_setup} with its backend config factory.
 * The maker spawns + bootstraps the backend and `provide`s a serializable
 * handle (`*.cross.test.ts` files rebuild it via
 * `reconstruct_bootstrapped_handle`).
 *
 * @module
 */

import type {TestProject} from 'vitest/node';

import type {BackendConfig} from '$lib/testing/cross_backend/backend_config.js';
import {bootstrap_backend} from '$lib/testing/cross_backend/bootstrap_backend.js';
import {serialize_bootstrapped_handle} from '$lib/testing/cross_backend/setup.js';

import './cross_test_types.js';

/**
 * Build a vitest `globalSetup` default export that spawns + bootstraps the
 * backend produced by `config_factory` and provides the serialized handle.
 *
 * `config_factory` is invoked lazily (inside setup) so a config that throws
 * when its prerequisites are missing (e.g. `spine_stub_backend_config`
 * without `FUZ_TESTING_SPINE_STUB_BIN`) only fails the project that uses it.
 */
export const make_spine_global_setup =
	(config_factory: () => BackendConfig) =>
	async (project: TestProject): Promise<() => Promise<void>> => {
		const config = config_factory();
		const bootstrapped = await bootstrap_backend(config);
		// vitest 4's `provide` hard-rejects non-serializable values, so strip the
		// live `child` / `teardown` / `keeper_transport`; test files rebuild a
		// usable handle via `reconstruct_bootstrapped_handle`.
		project.provide('backend_handle', serialize_bootstrapped_handle(bootstrapped));
		return async () => {
			await bootstrapped.teardown();
		};
	};
