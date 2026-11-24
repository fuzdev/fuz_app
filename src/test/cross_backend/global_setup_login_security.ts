/**
 * Vitest `globalSetup` for the `cross_backend_security` project — spawns +
 * bootstraps BOTH backends with the login limiters and the action limiters
 * enabled + the loopback proxy trusted (the TS spine on Node + in-memory pglet as `a`,
 * the Rust `testing_spine_stub` over a database of its own as `b` — a
 * `pglet_server`, or PostgreSQL under `FUZ_TEST_POSTGRES_URL`) and provides both
 * serialized handles plus the action limiters' cap, so
 * `login_security.cross.test.ts` (login rate limit + XFF) and
 * `ws_action_rate_limit.cross.test.ts` (action rate limit over RPC + WS) drive
 * each impl. Before each keeper bootstrap it spends the bootstrap limiter's
 * budget from a forwarded address of its own (`bootstrap_rate_limit_probe.ts`)
 * and provides both backends' 429 as `security_bootstrap_rate_limit`, which
 * `bootstrap_rate_limit.cross.test.ts` asserts.
 *
 * The standard single-backend `global_setup_*.ts` makers null every limiter
 * (the standard cross suites fire many loopback logins and actions a live
 * limiter would throttle), so the limiters can only be exercised on a backend
 * nothing else shares — this dedicated dual-spawn, mirroring
 * `global_setup_schema_parity.ts`. The two suites keep out of each other's
 * buckets: the login limiters and the action limiters are separate instances,
 * and each case reads its own forwarded IP or fresh keeper account.
 * Both backends run on ports, a stub database and backend names of their own
 * (`CROSS_PROJECT_RESOURCES`), so this project runs beside every other cross
 * project. The Rust side is made current first (`rebuild_rust_spine_stub`).
 *
 * @module
 */

import { create_dual_spawn_global_setup } from '#lib/testing/cross_backend/create_dual_spawn_global_setup.ts';
import { ts_spine_node_backend_config } from '#lib/testing/cross_backend/ts_spine_backend_config.ts';
import { rust_spine_stub_backend_config } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import type { TestProject } from 'vitest/node';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';
import {
	probe_bootstrap_rate_limit,
	type BootstrapRateLimitProbe
} from './bootstrap_rate_limit_probe.ts';
import './cross_test_types.ts';
import {
	rebuild_rust_spine_stub,
	RUST_SPINE_STUB_CRATE,
	to_rust_spine_pglet_server,
	with_legible_setup_failure
} from './global_setup_helpers.ts';

/** The project's two backends — the stub over a database of its own. */
const { ts: SECURITY_TS, stub: SECURITY_STUB } = CROSS_PROJECT_RESOURCES.cross_backend_security;

/**
 * The action limiters' `max_attempts` on both backends — small, so a case
 * reaches the cap in a few calls. The fixture setup charges none of the
 * account-limited actions on the fresh keeper the per-test reset seeds; the
 * login-security spray case's `create_account` charges one `invite_create` on
 * its keeper and one `account_token_create` on the attacker, under any cap.
 */
const ACTION_RATE_LIMIT_MAX_ATTEMPTS = 4;

// The generic "spawn two backends, provide two handles" maker. Both backends
// enable the login and action limiters; the Rust side also opts into XFF
// resolution (the TS binary wires `trusted_proxies` unconditionally).
const create_dual_spawn = (probes: Map<string, BootstrapRateLimitProbe>) =>
	create_dual_spawn_global_setup({
		configs: {
			a: () =>
				ts_spine_node_backend_config({
					name: SECURITY_TS.name,
					port: SECURITY_TS.port,
					enable_login_rate_limit: true,
					enable_action_rate_limit: true,
					action_rate_limit_max_attempts: ACTION_RATE_LIMIT_MAX_ATTEMPTS
				}),
			b: (database_url) =>
				rust_spine_stub_backend_config({
					name: SECURITY_STUB.name,
					port: SECURITY_STUB.port,
					database_url,
					enable_login_rate_limit: true,
					enable_action_rate_limit: true,
					action_rate_limit_max_attempts: ACTION_RATE_LIMIT_MAX_ATTEMPTS,
					trusted_proxies: '127.0.0.1,::1'
				})
		},
		databases: {
			b: { name: SECURITY_STUB.database, pglet_server: to_rust_spine_pglet_server() }
		},
		provide_keys: { a: 'security_handle_a', b: 'security_handle_b' },
		before_bootstrap: async (config) => {
			probes.set(config.name, await probe_bootstrap_rate_limit(config));
		}
	});

const setup = async (project: TestProject): Promise<() => Promise<void>> => {
	// make the Rust stub binary current before the dual spawn
	rebuild_rust_spine_stub({ crate: RUST_SPINE_STUB_CRATE });
	project.provide('security_action_rate_limit_max_attempts', ACTION_RATE_LIMIT_MAX_ATTEMPTS);
	const probes: Map<string, BootstrapRateLimitProbe> = new Map();
	const teardown = await create_dual_spawn(probes)(project);
	const a = probes.get(SECURITY_TS.name);
	const b = probes.get(SECURITY_STUB.name);
	if (!a || !b) {
		// the missing probe is the report; a failed teardown is logged beside it
		await teardown().catch((error: unknown) => console.error(error));
		throw new Error('the bootstrap rate-limit probe did not run on both backends');
	}
	project.provide('security_bootstrap_rate_limit', { a, b });
	return teardown;
};

export default with_legible_setup_failure('security', setup);
