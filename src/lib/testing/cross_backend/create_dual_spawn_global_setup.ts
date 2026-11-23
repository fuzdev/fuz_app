import '../assert_dev_env.ts';

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
 *   '@fuzdev/fuz_app/testing/cross_backend/create_dual_spawn_global_setup.ts';
 * import {node_backend_config, rust_backend_config} from './my_backend_config.ts';
 *
 * export default create_dual_spawn_global_setup({
 *   configs: {a: node_backend_config, b: rust_backend_config},
 * });
 * ```
 *
 * The `.cross.test.ts` reads both with `inject_parity_handles`
 * (`provided_context.ts`, which declares the default keys) and asserts. Run this project in a
 * later `groupOrder` than the single-backend projects (or with distinct
 * ports) — it reuses both configs' ports, so it must not run concurrently
 * with the per-backend projects.
 *
 * @module
 */

import type { TestProject } from 'vitest/node';

import type { BackendConfig } from './backend_config.ts';
import { bootstrap_backend } from './bootstrap_backend.ts';
import { serialize_bootstrapped_handle, type BootstrappedBackendHandle } from './setup.ts';

export interface DualSpawnGlobalSetupOptions {
	/**
	 * The two backend config factories to spawn. `a` is spawned first; on
	 * its success `b` is spawned (with `a` torn down if `b` throws). Label
	 * them in the consuming test (e.g. via `assert_schema_snapshots_equal`'s labels).
	 */
	readonly configs: { readonly a: () => BackendConfig; readonly b: () => BackendConfig };
	/**
	 * `project.provide` keys for the two serialized handles (read by
	 * `inject` in the test). Default `parity_handle_a` / `parity_handle_b`
	 * (the primary parity use, declared on vitest's `ProvidedContext` by
	 * `provided_context.ts`); override for other dual-spawn gates, augmenting
	 * `ProvidedContext` for those keys yourself.
	 */
	readonly provide_keys?: { readonly a: string; readonly b: string };
	/**
	 * Run against each backend once it is healthy and before its keeper
	 * bootstrap — `bootstrap_backend`'s `before_bootstrap`, for a probe of the
	 * pre-bootstrap window. Omit for none.
	 */
	readonly before_bootstrap?: (config: BackendConfig) => Promise<void>;
	/**
	 * Run against each backend once its keeper bootstrap has succeeded, before
	 * the other is spawned and before any test — for a read of what the
	 * bootstrap wrote, which per-test resets overwrite. `side` names the
	 * config. A throw tears down every backend spawned so far and fails the
	 * setup. Omit for none.
	 */
	readonly after_bootstrap?: (handle: BootstrappedBackendHandle, side: 'a' | 'b') => Promise<void>;
}

/**
 * Build a vitest `globalSetup` default export that spawns both backends.
 */
export const create_dual_spawn_global_setup = ({
	configs,
	provide_keys = { a: 'parity_handle_a', b: 'parity_handle_b' },
	before_bootstrap,
	after_bootstrap
}: DualSpawnGlobalSetupOptions): ((project: TestProject) => Promise<() => Promise<void>>) => {
	return async (project) => {
		const a = await bootstrap_backend(configs.a(), { before_bootstrap });
		// Tear down what is up if `b` fails to spawn or either hook throws — no
		// orphaned child process.
		let b: BootstrappedBackendHandle | null = null;
		try {
			await after_bootstrap?.(a, 'a');
			b = await bootstrap_backend(configs.b(), { before_bootstrap });
			await after_bootstrap?.(b, 'b');
		} catch (err) {
			// the setup's error is the report; a teardown that also failed is
			// logged beside it
			const failures = await teardown_each(b ? [b, a] : [a]);
			for (const failure of failures) console.error(failure);
			throw err;
		}
		const spawned_b = b;
		const provide = project.provide as (key: string, value: unknown) => void;
		provide(provide_keys.a, serialize_bootstrapped_handle(a));
		provide(provide_keys.b, serialize_bootstrapped_handle(spawned_b));
		return async () => {
			// both, whichever fails — a failed exit of one must not strand the other
			const failures = await teardown_each([spawned_b, a]);
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new Error(
					failures.map((f) => (f instanceof Error ? f.message : String(f))).join('\n')
				);
			}
		};
	};
};

/** Tear each handle down in turn, returning the failures rather than stopping at the first. */
const teardown_each = async (
	handles: ReadonlyArray<Pick<BootstrappedBackendHandle, 'teardown'>>
): Promise<Array<unknown>> => {
	const failures: Array<unknown> = [];
	for (const handle of handles) {
		try {
			await handle.teardown();
		} catch (error) {
			failures.push(error);
		}
	}
	return failures;
};
