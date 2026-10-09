/**
 * Bun spawn entry for the domain-free TS spine test binary.
 *
 * Run via `bun run src/test/cross_backend/testing_spine_server_bun.ts`
 * (the `cross_backend_ts_bun` project's `globalSetup` spawns it). Wires the
 * Bun runtime adapter to the shared `build_spine_app`. Third sibling to the
 * Node + Deno entries — isolates the JS-runtime axis on the same TS surface.
 * **Never ships in a release** — `src/test/` is excluded from the package
 * build.
 *
 * @module
 */

import process from 'node:process';
import { join } from 'node:path';

import { start_testing_server } from '#lib/testing/cross_backend/testing_server_core.ts';
import { TS_SPINE_DIR_ENV } from '#lib/testing/cross_backend/spine_surface_constants.ts';
import { create_bun_testing_adapter } from '#lib/testing/cross_backend/testing_server_bun.ts';
import { build_spine_app, resolve_spine_server_config } from './testing_spine_server.ts';

const DAEMON_NAME = 'fuz_app_ts_spine_bun';

const start = async (): Promise<void> => {
	const adapter = create_bun_testing_adapter();
	const { host, port } = resolve_spine_server_config(adapter.runtime);
	const dir = adapter.runtime.env_get(TS_SPINE_DIR_ENV);
	if (!dir) {
		throw new Error(
			`testing_spine_server_bun: ${TS_SPINE_DIR_ENV} must point at the harness's backend root ` +
				'(its `{dir}/run/daemon_token` is where the cross-process harness reads the keeper token).'
		);
	}
	const daemon_token_path = join(dir, 'run', 'daemon_token');
	await start_testing_server({
		adapter,
		daemon_name: DAEMON_NAME,
		host,
		port,
		build_app: ({ prepare_websocket }) =>
			build_spine_app({
				runtime: adapter.runtime,
				get_connection_ip: adapter.get_connection_ip,
				daemon_token_path,
				prepare_websocket
			})
	});
};

start().catch((error: unknown) => {
	console.error('[testing_spine_server] Failed to start:', error);
	process.exit(1);
});
