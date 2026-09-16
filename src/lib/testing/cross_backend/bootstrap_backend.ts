import '../assert_dev_env.ts';

/**
 * One-call spawn + bootstrap helper.
 *
 * Composes `spawn_backend(config)` and `bootstrap({transport, config})` so a
 * consumer's vitest `globalSetup` reduces to a single await:
 *
 * ```ts
 * import {bootstrap_backend} from '@fuzdev/fuz_app/testing/cross_backend/bootstrap_backend.ts';
 *
 * export default async function ({provide}) {
 *   const bootstrapped = await bootstrap_backend(deno_backend_config());
 *   provide('backend_handle', bootstrapped);
 *   return async () => {
 *     await bootstrapped.teardown();
 *   };
 * }
 * ```
 *
 * If `bootstrap()` throws — typically a bad token, port collision, or
 * keeper-username mismatch — the spawned binary is torn down before the
 * error propagates so vitest doesn't strand the port.
 *
 * @module
 */

import type { BackendConfig } from './backend_config.ts';
import { spawn_backend } from './spawn_backend.ts';
import { bootstrap } from '../transports/bootstrap.ts';
import { create_fetch_transport } from '../transports/fetch_transport.ts';
import type { BootstrappedBackendHandle } from './setup.ts';

/**
 * Spawn the test binary described by `config`, bootstrap a keeper, and
 * return the enriched handle.
 *
 * The keeper transport is constructed against `config.base_url` with no
 * initial cookies; `bootstrap()` populates its jar with the session
 * cookie returned by `POST {config.bootstrap_path}`. Subsequent calls
 * against `bootstrapped.keeper_transport` are authenticated as keeper.
 *
 * Mirrors the composition `default_cross_process_setup`'s caller would
 * otherwise hand-roll in every consumer's `globalSetup`.
 */
export const bootstrap_backend = async (
	config: BackendConfig
): Promise<BootstrappedBackendHandle> => {
	const handle = await spawn_backend(config);
	try {
		const keeper_transport = create_fetch_transport({ base_url: config.base_url });
		const keeper = await bootstrap({ transport: keeper_transport, config });
		return {
			...handle,
			keeper_transport,
			// Origin-free twin carrying the same keeper cookie jar — the
			// daemon-token middleware discards the credential in a browser
			// context, so the `_testing_*` daemon-token calls route through this.
			keeper_daemon_transport: create_fetch_transport({
				base_url: config.base_url,
				initial_cookies: keeper.cookies,
				origin: null
			}),
			keeper_account: keeper.account,
			keeper_actor: keeper.actor,
			keeper_cookies: keeper.cookies
		};
	} catch (err) {
		await handle.teardown();
		throw err;
	}
};
