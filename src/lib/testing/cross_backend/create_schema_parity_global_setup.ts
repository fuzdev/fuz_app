import '../assert_dev_env.js';

/**
 * Vitest `globalSetup` factory for cross-impl **schema-parity** projects.
 *
 * The per-backend `create_cross_backend_global_setup` spawns one backend
 * (derived from the project name). A schema-parity gate instead needs
 * *two* backends alive at once so the test process can capture each one's
 * schema (via `capture_schema_snapshot`) and diff them with
 * `assert_schema_snapshots_equal`. This factory spawns + bootstraps both
 * configs and `provide`s both serialized handles.
 *
 * A consumer's parity `global_setup.ts` collapses to:
 *
 * ```ts
 * import {create_schema_parity_global_setup} from
 *   '@fuzdev/fuz_app/testing/cross_backend/create_schema_parity_global_setup.js';
 * import {deno_backend_config, rust_backend_config} from './my_backend_config.js';
 * import './cross_test_types.js'; // augments the two provide keys
 *
 * export default create_schema_parity_global_setup({
 *   configs: {a: deno_backend_config, b: rust_backend_config},
 * });
 * ```
 *
 * The parity `.cross.test.ts` `inject`s both keys, rebuilds each with
 * `reconstruct_bootstrapped_handle`, and asserts. Run this project in a
 * later `groupOrder` than the single-backend projects (or with distinct
 * ports) — it reuses both configs' ports, so it must not run concurrently
 * with the per-backend projects.
 *
 * @module
 */

import type {TestProject} from 'vitest/node';

import type {BackendConfig} from './backend_config.js';
import {bootstrap_backend} from './bootstrap_backend.js';
import {serialize_bootstrapped_handle} from './setup.js';

export interface SchemaParityGlobalSetupOptions {
	/**
	 * The two backend config factories to spawn. `a` is spawned first; on
	 * its success `b` is spawned (with `a` torn down if `b` throws). Label
	 * them in the parity test via `assert_schema_snapshots_equal`'s labels.
	 */
	readonly configs: {readonly a: () => BackendConfig; readonly b: () => BackendConfig};
	/**
	 * `project.provide` keys for the two serialized handles (read by
	 * `inject` in the parity test). Default `parity_handle_a` /
	 * `parity_handle_b`. Augment vitest's `ProvidedContext` for them.
	 */
	readonly provide_keys?: {readonly a: string; readonly b: string};
}

/**
 * Build a vitest `globalSetup` default export that spawns both backends.
 */
export const create_schema_parity_global_setup = ({
	configs,
	provide_keys = {a: 'parity_handle_a', b: 'parity_handle_b'},
}: SchemaParityGlobalSetupOptions): ((project: TestProject) => Promise<() => Promise<void>>) => {
	return async (project) => {
		const a = await bootstrap_backend(configs.a());
		// Tear `a` down if `b` fails to spawn — no orphaned child process.
		let b: Awaited<ReturnType<typeof bootstrap_backend>>;
		try {
			b = await bootstrap_backend(configs.b());
		} catch (err) {
			await a.teardown();
			throw err;
		}
		const provide = project.provide as (key: string, value: unknown) => void;
		provide(provide_keys.a, serialize_bootstrapped_handle(a));
		provide(provide_keys.b, serialize_bootstrapped_handle(b));
		return async () => {
			await b.teardown();
			await a.teardown();
		};
	};
};
