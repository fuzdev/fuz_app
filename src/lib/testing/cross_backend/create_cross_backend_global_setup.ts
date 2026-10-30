import '../assert_dev_env.ts';

/**
 * Generic vitest `globalSetup` factory for cross-backend integration suites.
 *
 * Pairs with `make_cross_backend_project`: each cross-backend vitest project
 * sets its own `test.name`, and this factory derives the backend name from
 * that project name (vitest 4 passes the `TestProject` to globalSetup), picks
 * the matching `BackendConfig`, spawns + bootstraps it via `bootstrap_backend`,
 * and `provide`s a serializable handle that `*.cross.test.ts` files read
 * with `inject_backend_handle` (`provided_context.ts`).
 *
 * A consumer's `global_setup.ts` collapses to:
 *
 * ```ts
 * import {create_cross_backend_global_setup} from
 *   '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';
 * import {deno_backend_config, rust_backend_config} from './my_backend_config.ts';
 *
 * export default create_cross_backend_global_setup({
 *   configs: {deno: deno_backend_config, rust: rust_backend_config},
 *   ensure_databases: true,
 *   before_spawn: {rust: () => prepare_cargo_binary(my_cargo_binary)},
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

import type { TestProject } from 'vitest/node';

import type { BackendConfig } from './backend_config.ts';
import { bootstrap_backend } from './bootstrap_backend.ts';
import { ensure_database_for_url } from './postgres_database.ts';
import { serialize_bootstrapped_handle } from './setup.ts';

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
	 * Default `'backend_handle'`, which `provided_context.ts` declares on vitest's
	 * `ProvidedContext`; augment it yourself for another key.
	 */
	readonly provide_key?: string;
	/**
	 * Create the database the selected config's `env.DATABASE_URL` names, on
	 * the server it names, when it is missing and the URL is `postgres:`
	 * (`ensure_database_for_url` — idempotent `createdb`; a URL like
	 * `memory://` is left alone). Off by default, so a test role without
	 * `CREATEDB` is never required unless the setup asks.
	 *
	 * @default false
	 */
	readonly ensure_databases?: boolean;
	/**
	 * Hooks run before a backend's config is built and spawned, by backend
	 * name — the Cargo build of a Rust binary (`prepare_cargo_binary`), so it
	 * runs with its output shown and outside the spawn's startup window, and
	 * the config can spawn the built binary. Runs only for the selected
	 * backend; a key naming no config throws.
	 */
	readonly before_spawn?: Readonly<Record<string, () => unknown>>;
}

/**
 * What `create_cross_backend_global_setup` creates databases and spawns
 * backends with — `ensure_database_for_url` and `bootstrap_backend` by default.
 */
export interface CrossBackendGlobalSetupDeps {
	readonly ensure_database_for_url: (database_url: string) => unknown;
	readonly bootstrap_backend: typeof bootstrap_backend;
}

const default_cross_backend_global_setup_deps: CrossBackendGlobalSetupDeps = {
	ensure_database_for_url,
	bootstrap_backend
};

/**
 * Build a vitest `globalSetup` default export. Returns the
 * `(project) => teardown` function vitest 4 expects.
 *
 * @param options - the configs, and what runs before the spawn
 * @param deps - the database creator and the spawn, the shipped ones by default
 * @throws Error when a `before_spawn` key names no config
 */
export const create_cross_backend_global_setup = (
	{
		configs,
		derive_name = (project_name) => project_name.replace(DEFAULT_PROJECT_NAME_PREFIX, ''),
		provide_key = 'backend_handle',
		ensure_databases = false,
		before_spawn = {}
	}: CrossBackendGlobalSetupOptions,
	deps: CrossBackendGlobalSetupDeps = default_cross_backend_global_setup_deps
): ((project: TestProject) => Promise<() => Promise<void>>) => {
	for (const name of Object.keys(before_spawn)) {
		if (!Object.hasOwn(configs, name)) {
			throw new Error(
				`create_cross_backend_global_setup: before_spawn names '${name}', which has no config — ` +
					`expected one of: ${Object.keys(configs).join(', ')}`
			);
		}
	}
	return async (project) => {
		const name = derive_name(project.name);
		const factory = Object.hasOwn(configs, name) ? configs[name] : undefined;
		if (!factory) {
			throw new Error(
				`Could not derive backend config from vitest project '${project.name}' ` +
					`(derived name '${name}') — expected one of: ${Object.keys(configs).join(', ')}`
			);
		}
		if (Object.hasOwn(before_spawn, name)) await before_spawn[name]!();
		const config = factory();
		const database_url = config.env.DATABASE_URL;
		if (ensure_databases && database_url !== undefined) deps.ensure_database_for_url(database_url);
		const bootstrapped = await deps.bootstrap_backend(config);
		// vitest's `provide` is keyed on the consumer-augmented `ProvidedContext`;
		// the generic key is a plain string, so cast past the keyof constraint.
		(project.provide as (key: string, value: unknown) => void)(
			provide_key,
			serialize_bootstrapped_handle(bootstrapped)
		);
		return async () => {
			await bootstrapped.teardown();
		};
	};
};
