import '../assert_dev_env.js';

/**
 * Generic **dual-spawn** vitest `globalSetup` factory — spawns + bootstraps
 * *two* backends at once and `provide`s both serialized handles, for any
 * cross-impl gate that needs both alive together. (The per-backend
 * `create_cross_backend_global_setup` derives one backend from the project
 * name; this brings up a pair.)
 *
 * Its primary use is the **schema- / action-manifest-parity** gates (capture
 * each backend over a `_testing_*` introspection RPC and diff with
 * `assert_schema_snapshots_equal` / `assert_action_manifests_equal`) — which is
 * why the default `provide_keys` are `parity_handle_*`. The login-security gate
 * (`global_setup_login_security.ts`) reuses it with its own keys; any future
 * two-backend gate can too.
 *
 * A consumer's dual-spawn `global_setup.ts` collapses to:
 *
 * ```ts
 * import {create_dual_spawn_global_setup} from
 *   '@fuzdev/fuz_app/testing/cross_backend/create_dual_spawn_global_setup.js';
 * import {deno_backend_config, rust_backend_config} from './my_backend_config.js';
 * import './cross_test_types.js'; // augments the two provide keys
 *
 * export default create_dual_spawn_global_setup({
 *   configs: {a: deno_backend_config, b: rust_backend_config},
 * });
 * ```
 *
 * The `.cross.test.ts` `inject`s both keys, rebuilds each with
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

export interface DualSpawnGlobalSetupOptions {
	/**
	 * The two backend config factories to spawn. `a` is spawned first; on
	 * its success `b` is spawned (with `a` torn down if `b` throws). Label
	 * them in the consuming test (e.g. via `assert_schema_snapshots_equal`'s labels).
	 */
	readonly configs: {readonly a: () => BackendConfig; readonly b: () => BackendConfig};
	/**
	 * `project.provide` keys for the two serialized handles (read by
	 * `inject` in the test). Default `parity_handle_a` / `parity_handle_b`
	 * (the primary parity use); override for other dual-spawn gates. Augment
	 * vitest's `ProvidedContext` for whichever keys you use.
	 */
	readonly provide_keys?: {readonly a: string; readonly b: string};
}

/**
 * Build a vitest `globalSetup` default export that spawns both backends.
 */
export const create_dual_spawn_global_setup = ({
	configs,
	provide_keys = {a: 'parity_handle_a', b: 'parity_handle_b'},
}: DualSpawnGlobalSetupOptions): ((project: TestProject) => Promise<() => Promise<void>>) => {
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
