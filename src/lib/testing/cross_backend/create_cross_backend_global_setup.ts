import '../assert_dev_env.ts';

/**
 * Generic vitest `globalSetup` factory for cross-backend integration suites.
 *
 * Pairs with `make_cross_backend_project`: each cross-backend vitest project
 * sets its own `test.name`, and this factory derives the backend name from
 * that project name (vitest 4 passes the `TestProject` to globalSetup),
 * provisions the backend's database when `databases` names it
 * (`open_test_database`: a `pglet_server` of its own, or a PostgreSQL database
 * of its own under `FUZ_TEST_POSTGRES_URL`), builds the matching
 * `BackendConfig` over its URL, spawns + bootstraps it via `bootstrap_backend`,
 * and `provide`s a serializable handle that `*.cross.test.ts` files read
 * with `inject_backend_handle` (`provided_context.ts`).
 *
 * A consumer's `global_setup.ts` collapses to:
 *
 * ```ts
 * import {create_cross_backend_global_setup} from
 *   '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';
 * import {MY_CARGO_BINARY, node_backend_config, rust_backend_config} from './my_backend_config.ts';
 *
 * export default create_cross_backend_global_setup({
 *   configs: {node: () => node_backend_config(), rust: (database_url) => rust_backend_config(database_url)},
 *   // the Rust backend, built before its spawn, over a pglet server built in its Cargo workspace
 *   cargo_binaries: {rust: MY_CARGO_BINARY},
 * });
 * ```
 *
 * vitest 4's `provide` hard-rejects non-serializable values, so the live
 * `child` / `teardown` / `keeper_transport` are stripped via
 * `serialize_bootstrapped_handle`; the teardown closure stays in the
 * globalSetup process and is returned for vitest to fire after the suite —
 * the backend's teardown, then its database's `close()`.
 *
 * @module
 */

import type { TestProject } from 'vitest/node';

import type { BackendConfig } from './backend_config.ts';
import { prepare_cargo_binary, type CargoBinaryOptions } from './cargo_binary.ts';
import { bootstrap_backend } from './bootstrap_backend.ts';
import { FUZ_TEST_POSTGRES_URL_ENV } from '../db.ts';
import { serialize_bootstrapped_handle } from './setup.ts';
import {
	assert_config_on_database,
	open_test_database,
	prepare_pglet_server_binary,
	type PgletServerBinaryOptions,
	type TestDatabase
} from './test_database.ts';

/**
 * Default project-name → backend-name reduction: strips the
 * `cross_backend_` prefix plus an optional `ts_` discriminator (the TS
 * canonical backends carry it to distinguish JS runtimes). So
 * `cross_backend_ts_node` → `node` and `cross_backend_rust` → `rust`.
 */
const DEFAULT_PROJECT_NAME_PREFIX = /^cross_backend_(?:ts_)?/;

export interface CrossBackendGlobalSetupOptions {
	/**
	 * Map of derived backend name → `BackendConfig` factory. The derived
	 * name (see `derive_name`) selects the factory; unknown names throw with
	 * the full supported list so a misnamed project surfaces clearly. The
	 * factory gets the URL of the database `databases` provisions for the
	 * backend, or `'memory://'` (in-process pglet, the TS family's default)
	 * for one `databases` doesn't name.
	 */
	readonly configs: Readonly<Record<string, (database_url: string) => BackendConfig>>;
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
	 * The backends that run over a database the setup provisions, by backend
	 * name — a Rust backend, which `tokio-postgres` connects to over the wire.
	 * Each gets a database of its own (`open_test_database`, named for the
	 * backend), empty at its spawn and gone after its teardown: a
	 * `pglet_server` built in the Cargo workspace (and profile) given here,
	 * the backend binary's own (`prepare_pglet_server_binary`), or a
	 * PostgreSQL database under `FUZ_TEST_POSTGRES_URL`. `null` runs the
	 * backend only on PostgreSQL, failing the setup naming the variable when
	 * it is unset. A key naming no config throws.
	 */
	readonly databases?: Readonly<Record<string, PgletServerBinaryOptions | null>>;
	/**
	 * Hooks run before a backend's config is built and spawned, by backend
	 * name — the Cargo build of a Rust binary (`prepare_cargo_binary`), so it
	 * runs with its output shown and outside the spawn's startup window, and
	 * the config can spawn the built binary. Runs only for the selected
	 * backend; a key naming no config throws.
	 */
	readonly before_spawn?: Readonly<Record<string, () => unknown>>;
	/**
	 * The backends built by Cargo, by backend name — the shape every Rust
	 * backend takes: each is built before its spawn (`prepare_cargo_binary`, as
	 * a `before_spawn` hook) and runs over a database of its own, a
	 * `pglet_server` built in the binary's workspace and profile (as a
	 * `databases` entry) or PostgreSQL under `FUZ_TEST_POSTGRES_URL`. A name
	 * here and in `databases` or `before_spawn`, or naming no config, throws.
	 */
	readonly cargo_binaries?: Readonly<Record<string, CargoBinaryOptions>>;
}

/**
 * What `create_cross_backend_global_setup` provisions databases and spawns
 * backends with — `open_test_database` and `bootstrap_backend` by default —
 * and the PostgreSQL server it reads, `process.env[FUZ_TEST_POSTGRES_URL_ENV]`
 * by default.
 */
export interface CrossBackendGlobalSetupDeps {
	readonly open_test_database: typeof open_test_database;
	readonly bootstrap_backend: typeof bootstrap_backend;
	/** Builds a `cargo_binaries` entry. */
	readonly prepare_cargo_binary: (options: CargoBinaryOptions) => unknown;
	readonly postgres_url: () => string | undefined;
}

const default_cross_backend_global_setup_deps: CrossBackendGlobalSetupDeps = {
	open_test_database,
	bootstrap_backend,
	prepare_cargo_binary,
	postgres_url: () => process.env[FUZ_TEST_POSTGRES_URL_ENV]
};

/**
 * Build a vitest `globalSetup` default export. Returns the
 * `(project) => teardown` function vitest 4 expects.
 *
 * @param options - the configs, the databases, what runs before the spawn, and the Cargo-built backends
 * @param deps - the database opener, the spawn, the Cargo build and the PostgreSQL server, the shipped ones by default
 * @throws Error when a `before_spawn`, `databases` or `cargo_binaries` key names no config, or a
 *   `cargo_binaries` key is also a `databases` or `before_spawn` key, and
 *   from the setup when a backend's config ignores the database provisioned for it
 */
export const create_cross_backend_global_setup = (
	{
		configs,
		derive_name = (project_name) => project_name.replace(DEFAULT_PROJECT_NAME_PREFIX, ''),
		provide_key = 'backend_handle',
		databases: declared_databases = {},
		before_spawn: declared_before_spawn = {},
		cargo_binaries = {}
	}: CrossBackendGlobalSetupOptions,
	deps: CrossBackendGlobalSetupDeps = default_cross_backend_global_setup_deps
): ((project: TestProject) => Promise<() => Promise<void>>) => {
	for (const [option, keyed] of [
		['before_spawn', declared_before_spawn],
		['databases', declared_databases],
		['cargo_binaries', cargo_binaries]
	] as const) {
		for (const name of Object.keys(keyed)) {
			if (!Object.hasOwn(configs, name)) {
				throw new Error(
					`create_cross_backend_global_setup: ${option} names '${name}', which has no config — ` +
						`expected one of: ${Object.keys(configs).join(', ')}`
				);
			}
		}
	}
	const databases: Record<string, PgletServerBinaryOptions | null> = { ...declared_databases };
	const before_spawn: Record<string, () => unknown> = { ...declared_before_spawn };
	for (const [name, binary] of Object.entries(cargo_binaries)) {
		for (const [option, keyed] of [
			['databases', declared_databases],
			['before_spawn', declared_before_spawn]
		] as const) {
			if (Object.hasOwn(keyed, name)) {
				throw new Error(
					`create_cross_backend_global_setup: '${name}' is in both cargo_binaries and ${option} — ` +
						'cargo_binaries gives it both'
				);
			}
		}
		databases[name] = { workspace_dir: binary.workspace_dir, profile: binary.profile };
		before_spawn[name] = () => deps.prepare_cargo_binary(binary);
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
		let database: TestDatabase | null = null;
		if (Object.hasOwn(databases, name)) {
			const pglet_server = databases[name]!;
			database = await deps.open_test_database({
				name,
				postgres_url: deps.postgres_url(),
				pglet_server_bin: pglet_server && (() => prepare_pglet_server_binary(pglet_server))
			});
		}
		let bootstrapped;
		try {
			const config = factory(database?.url ?? 'memory://');
			if (database) assert_config_on_database(config, database);
			bootstrapped = await deps.bootstrap_backend(config);
		} catch (error) {
			await database?.close().catch((close_error: unknown) => console.error(close_error));
			throw error;
		}
		// vitest's `provide` is keyed on the consumer-augmented `ProvidedContext`;
		// the generic key is a plain string, so cast past the keyof constraint.
		(project.provide as (key: string, value: unknown) => void)(
			provide_key,
			serialize_bootstrapped_handle(bootstrapped)
		);
		return async () => {
			try {
				await bootstrapped.teardown();
			} finally {
				await database?.close();
			}
		};
	};
};
