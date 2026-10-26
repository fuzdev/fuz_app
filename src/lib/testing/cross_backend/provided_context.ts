import '../assert_dev_env.ts';

/**
 * The vitest `ProvidedContext` keys the cross-backend global setups provide,
 * and the helpers a `*.cross.test.ts` file reads them with.
 *
 * `create_cross_backend_global_setup` provides one backend's handle as
 * `backend_handle`; `create_dual_spawn_global_setup` provides two, as
 * `parity_handle_a` / `parity_handle_b` by default. This module augments
 * vitest's `ProvidedContext` with those keys, so a test file that imports
 * `inject_backend_handle` (or `inject_parity_handles`) gets the typed `inject`
 * with no augmentation of its own. A project providing other keys — a dual
 * spawn under its own `provide_keys`, a probe result — augments
 * `ProvidedContext` for those in its own module, beside this one.
 *
 * vitest refuses a value that isn't serializable, so the handles cross as
 * `SerializableBootstrappedBackendHandle`; the helpers rebuild a usable handle
 * with `reconstruct_bootstrapped_handle`.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	reconstruct_bootstrapped_handle,
	type ReconstructedBootstrappedBackendHandle,
	type SerializableBootstrappedBackendHandle
} from './setup.ts';

declare module 'vitest' {
	export interface ProvidedContext {
		/** The single-backend project's handle (`create_cross_backend_global_setup`). */
		backend_handle: SerializableBootstrappedBackendHandle;
		/** A dual-spawn project's first handle (`create_dual_spawn_global_setup`'s default keys). */
		parity_handle_a: SerializableBootstrappedBackendHandle;
		/** A dual-spawn project's second handle. */
		parity_handle_b: SerializableBootstrappedBackendHandle;
	}
}

/**
 * The backend the project's `globalSetup` spawned, rebuilt from the provided
 * `backend_handle`. Call at a test file's top level.
 */
export const inject_backend_handle = (): ReconstructedBootstrappedBackendHandle =>
	reconstruct_bootstrapped_handle(inject('backend_handle'));

/** The two backends a dual-spawn project's `globalSetup` spawned, under the default keys. */
export interface InjectedParityHandles {
	readonly a: ReconstructedBootstrappedBackendHandle;
	readonly b: ReconstructedBootstrappedBackendHandle;
}

/**
 * The two backends a dual-spawn project provides as `parity_handle_a` /
 * `parity_handle_b`, rebuilt. Call at a test file's top level.
 */
export const inject_parity_handles = (): InjectedParityHandles => ({
	a: reconstruct_bootstrapped_handle(inject('parity_handle_a')),
	b: reconstruct_bootstrapped_handle(inject('parity_handle_b'))
});
