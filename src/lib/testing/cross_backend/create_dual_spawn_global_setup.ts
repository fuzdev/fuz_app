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
 * import {MY_CARGO_BINARY, node_backend_config, rust_backend_config} from './my_backend_config.ts';
 *
 * export default create_dual_spawn_global_setup({
 *   configs: {a: () => node_backend_config(), b: (database_url) => rust_backend_config(database_url)},
 *   databases: {b: {name: 'parity_rust', pglet_server: MY_CARGO_BINARY}},
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

import { FUZ_TEST_POSTGRES_URL_ENV } from '../db.ts';
import type { BackendConfig } from './backend_config.ts';
import { bootstrap_backend } from './bootstrap_backend.ts';
import { serialize_bootstrapped_handle, type BootstrappedBackendHandle } from './setup.ts';
import {
	assert_config_on_database,
	open_test_database,
	prepare_pglet_server_binary,
	type PgletServerBinaryOptions,
	type TestDatabase
} from './test_database.ts';

/** One side's database in a dual spawn (`DualSpawnGlobalSetupOptions.databases`). */
export interface DualSpawnDatabase {
	/** Names it (`open_test_database`'s `name`), unique among the repo's cross backends. */
	readonly name: string;
	/**
	 * The Cargo workspace (and profile) its `pglet_server` is built in, the
	 * backend binary's own (`prepare_pglet_server_binary`), or `null` for a
	 * side that runs only on PostgreSQL, failing the setup naming
	 * `FUZ_TEST_POSTGRES_URL` when it is unset.
	 */
	readonly pglet_server: PgletServerBinaryOptions | null;
}

export interface DualSpawnGlobalSetupOptions {
	/**
	 * The two backend config factories to spawn. `a` is spawned first; on
	 * its success `b` is spawned (with `a` torn down if `b` throws). Label
	 * them in the consuming test (e.g. via `assert_schema_snapshots_equal`'s labels).
	 * Each gets the URL of the database `databases` provisions for its side,
	 * or `'memory://'` (in-process pglet, the TS family's default) for a side
	 * with none.
	 */
	readonly configs: {
		readonly a: (database_url: string) => BackendConfig;
		readonly b: (database_url: string) => BackendConfig;
	};
	/**
	 * The sides that run over a database the setup provisions before any
	 * spawn (`open_test_database`): a `pglet_server` of its own, or a
	 * PostgreSQL database of its own under `FUZ_TEST_POSTGRES_URL`. Each is
	 * closed after both backends' teardown. Omit a side for none.
	 */
	readonly databases?: { readonly a?: DualSpawnDatabase; readonly b?: DualSpawnDatabase };
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
 * Build a vitest `globalSetup` default export that provisions the sides'
 * databases, then spawns both backends.
 */
export const create_dual_spawn_global_setup = ({
	configs,
	databases = {},
	provide_keys = { a: 'parity_handle_a', b: 'parity_handle_b' },
	before_bootstrap,
	after_bootstrap
}: DualSpawnGlobalSetupOptions): ((project: TestProject) => Promise<() => Promise<void>>) => {
	if (databases.a && databases.b && databases.a.name === databases.b.name) {
		throw new Error(
			`create_dual_spawn_global_setup: both sides name the database '${databases.a.name}' — ` +
				'each side opens one of its own, so the second would drop the first'
		);
	}
	return async (project) => {
		// every database, then the spawns, so a missing PostgreSQL fails before
		// any backend starts; what was opened closes after everything spawned
		const opened: Array<TestDatabase> = [];
		const side_databases: { a?: TestDatabase; b?: TestDatabase } = {};
		// a side's config over its database's URL, refused when it ignores it
		const build_config = (side: 'a' | 'b'): BackendConfig => {
			const database = side_databases[side];
			const config = configs[side](database?.url ?? 'memory://');
			if (database) assert_config_on_database(config, database);
			return config;
		};
		let a: BootstrappedBackendHandle | null = null;
		let b: BootstrappedBackendHandle | null = null;
		try {
			for (const side of ['a', 'b'] as const) {
				const request = databases[side];
				if (!request) continue;
				const { pglet_server } = request;
				const database = await open_test_database({
					name: request.name,
					postgres_url: process.env[FUZ_TEST_POSTGRES_URL_ENV],
					pglet_server_bin: pglet_server && (() => prepare_pglet_server_binary(pglet_server))
				});
				opened.push(database);
				side_databases[side] = database;
			}
			a = await bootstrap_backend(build_config('a'), { before_bootstrap });
			await after_bootstrap?.(a, 'a');
			b = await bootstrap_backend(build_config('b'), { before_bootstrap });
			await after_bootstrap?.(b, 'b');
		} catch (err) {
			// the setup's error is the report; a teardown that also failed is
			// logged beside it. Tear down what is up — no orphaned child process.
			const spawned = [b, a].filter((handle) => handle !== null);
			const failures = [...(await teardown_each(spawned)), ...(await close_each(opened))];
			for (const failure of failures) console.error(failure);
			throw err;
		}
		const spawned_a = a;
		const spawned_b = b;
		const provide = project.provide as (key: string, value: unknown) => void;
		provide(provide_keys.a, serialize_bootstrapped_handle(spawned_a));
		provide(provide_keys.b, serialize_bootstrapped_handle(spawned_b));
		return async () => {
			// both, whichever fails — a failed exit of one must not strand the
			// other — then the databases
			const failures = [
				...(await teardown_each([spawned_b, spawned_a])),
				...(await close_each(opened))
			];
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new Error(
					failures.map((f) => (f instanceof Error ? f.message : String(f))).join('\n')
				);
			}
		};
	};
};

/** Close each database in turn, returning the failures rather than stopping at the first. */
const close_each = async (databases: ReadonlyArray<TestDatabase>): Promise<Array<unknown>> => {
	const failures: Array<unknown> = [];
	for (const database of databases) {
		try {
			await database.close();
		} catch (error) {
			failures.push(error);
		}
	}
	return failures;
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
