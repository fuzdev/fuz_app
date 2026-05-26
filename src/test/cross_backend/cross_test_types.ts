/**
 * Shared module augmentation for the cross-backend vitest project.
 *
 * vitest's `provide`/`inject` channel is typed via a global
 * `ProvidedContext` interface that callers augment to declare what's
 * available to `inject()`. The producer (`global_setup.ts`) and the
 * consumer (`*.cross.test.ts`) both need the same `backend_handle`
 * binding visible at type-check time; lifting the augmentation here keeps
 * the single source of truth in one file.
 *
 * Import for side-effect only: `import './cross_test_types.js';`.
 * TypeScript merges module augmentations from any file that's part of the
 * program, so consuming files only need the import statement.
 *
 * @module
 */

import type {SerializableBootstrappedBackendHandle} from '$lib/testing/cross_backend/setup.js';

declare module 'vitest' {
	export interface ProvidedContext {
		// Serializable subset; vitest 4 hard-rejects non-serializable provide
		// values, so the live `child` / `teardown` / `keeper_transport` stay in
		// the globalSetup process. Test files call `reconstruct_bootstrapped_handle`
		// on the injected value to rebuild a usable handle.
		backend_handle: SerializableBootstrappedBackendHandle;
	}
}
