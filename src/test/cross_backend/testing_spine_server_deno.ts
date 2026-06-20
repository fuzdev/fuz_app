/**
 * Deno spawn entry for the domain-free TS spine test binary.
 *
 * Run via `deno run -A src/test/cross_backend/testing_spine_server_deno.ts`
 * (the `cross_backend_ts_deno` project's `globalSetup` spawns it). Wires the
 * Deno runtime adapter to the shared `build_spine_app`. Counterpart to the
 * Node entry — isolates the JS-runtime axis on the same TS surface.
 *
 * **Never ships in a release** — `src/test/` is excluded from the package
 * build. `Deno.exit` is declared locally so this typechecks under fuz_app's
 * Node config; it is only ever run under Deno.
 *
 * @module
 */

import {join} from 'node:path';

import {start_testing_server} from '#lib/testing/cross_backend/testing_server_core.ts';
import {create_deno_testing_adapter} from '#lib/testing/cross_backend/testing_server_deno.ts';
import {build_spine_app, resolve_spine_server_config} from './testing_spine_server.ts';

declare const Deno: {exit: (code: number) => never};

/** Dir env var whose `{dir}/run/daemon_token` matches `BackendConfig.bootstrap.daemon_token_path`. */
const TS_SPINE_DIR_ENV = 'FUZ_TESTING_TS_SPINE_DIR';
const DAEMON_NAME = 'fuz_app_ts_spine_deno';

const start = async (): Promise<void> => {
	const adapter = create_deno_testing_adapter();
	const {host, port} = resolve_spine_server_config(adapter.runtime);
	const dir = adapter.runtime.env_get(TS_SPINE_DIR_ENV);
	if (!dir) {
		throw new Error(
			`testing_spine_server_deno: ${TS_SPINE_DIR_ENV} must point at the harness's backend root ` +
				'(its `{dir}/run/daemon_token` is where the cross-process harness reads the keeper token).',
		);
	}
	const daemon_token_path = join(dir, 'run', 'daemon_token');
	await start_testing_server({
		adapter,
		daemon_name: DAEMON_NAME,
		host,
		port,
		build_app: () =>
			build_spine_app({
				runtime: adapter.runtime,
				get_connection_ip: adapter.get_connection_ip,
				daemon_token_path,
			}),
	});
};

start().catch((error: unknown) => {
	console.error('[testing_spine_server] Failed to start:', error);
	Deno.exit(1);
});
