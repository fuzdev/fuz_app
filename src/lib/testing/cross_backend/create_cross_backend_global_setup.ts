import '../assert_dev_env.ts';

/**
 * Generic vitest `globalSetup` factory for cross-backend integration suites.
 *
 * Pairs with `make_cross_backend_project`: each cross-backend vitest project
 * sets its own `test.name`, and this factory derives the backend name from
 * that project name (vitest 4 passes the `TestProject` to globalSetup), picks
 * the matching `BackendConfig`, spawns + bootstraps it via `bootstrap_backend`,
 * and `provide`s a serializable handle that `*.cross.test.ts` files
 * `inject` and rebuild with `reconstruct_bootstrapped_handle`.
 *
 * A consumer's `global_setup.ts` collapses to:
 *
 * ```ts
 * import {create_cross_backend_global_setup} from
 *   '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';
 * import {deno_backend_config, rust_backend_config} from './my_backend_config.js';
 * import './cross_test_types.js'; // augments inject('backend_handle')
 *
 * export default create_cross_backend_global_setup({
 *   configs: {deno: deno_backend_config, rust: rust_backend_config},
 * });
 * ```
 *
 * vitest 4's `provide` hard-rejects non-serializable values, so the live
 * `child` / `teardown` / `keeper_transport` are stripped via
 * `serialize_bootstrapped_handle`; the teardown closure stays in the
 * globalSetup process and is returned for vitest to fire after the suite.
 *
 * @module
 */

import type {TestProject} from 'vitest/node';

import type {BackendConfig} from './backend_config.ts';
import {bootstrap_backend} from './bootstrap_backend.ts';
import {serialize_bootstrapped_handle} from './setup.ts';

/**
 * Default project-name → backend-name reduction: strips the
 * `cross_backend_` prefix plus an optional `ts_` discriminator (the TS
 * canonical backends carry it to distinguish JS runtimes). So
 * `cross_backend_ts_deno` → `deno` and `cross_backend_rust` → `rust`.
 */
const DEFAULT_PROJECT_NAME_PREFIX = /^cross_backend_(?:ts_)?/;

export interface CrossBackendGlobalSetupOptions {
	/**
	 * Map of derived backend name → `BackendConfig` factory. The derived
	 * name (see `derive_name`) selects the factory; unknown names throw with
	 * the full supported list so a misnamed project surfaces clearly.
	 */
	readonly configs: Readonly<Record<string, () => BackendConfig>>;
	/**
	 * Derive the backend name from the vitest project name. Default strips
	 * `cross_backend_(ts_)?`.
	 */
	readonly derive_name?: (project_name: string) => string;
	/**
	 * Key passed to `project.provide` (and read by `inject` in test files).
	 * Default `'backend_handle'`. Augment vitest's `ProvidedContext` for it.
	 */
	readonly provide_key?: string;
}

/**
 * Build a vitest `globalSetup` default export. Returns the
 * `(project) => teardown` function vitest 4 expects.
 */
export const create_cross_backend_global_setup = ({
	configs,
	derive_name = (project_name) => project_name.replace(DEFAULT_PROJECT_NAME_PREFIX, ''),
	provide_key = 'backend_handle',
}: CrossBackendGlobalSetupOptions): ((project: TestProject) => Promise<() => Promise<void>>) => {
	return async (project) => {
		const name = derive_name(project.name);
		const factory = configs[name];
		if (!factory) {
			throw new Error(
				`Could not derive backend config from vitest project '${project.name}' ` +
					`(derived name '${name}') — expected one of: ${Object.keys(configs).join(', ')}`,
			);
		}
		const bootstrapped = await bootstrap_backend(factory());
		// vitest's `provide` is keyed on the consumer-augmented `ProvidedContext`;
		// the generic key is a plain string, so cast past the keyof constraint.
		(project.provide as (key: string, value: unknown) => void)(
			provide_key,
			serialize_bootstrapped_handle(bootstrapped),
		);
		return async () => {
			await bootstrapped.teardown();
		};
	};
};
