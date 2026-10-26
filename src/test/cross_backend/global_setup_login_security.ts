/**
 * Vitest `globalSetup` for the `cross_backend_security` project — spawns +
 * bootstraps BOTH backends with the login limiters and the action limiters
 * enabled + the loopback proxy trusted (the TS spine on Node + in-memory pglet as `a`,
 * the Rust `testing_spine_stub` over real Postgres as `b`) and provides both
 * serialized handles plus the action limiters' cap, so
 * `login_security.cross.test.ts` (login rate limit + XFF) and
 * `ws_action_rate_limit.cross.test.ts` (action rate limit over RPC + WS) drive
 * each impl.
 *
 * The standard single-backend `global_setup_*.ts` makers null every limiter
 * (the standard cross suites fire many loopback logins and actions a live
 * limiter would throttle), so the limiters can only be exercised on a backend
 * nothing else shares — this dedicated dual-spawn, mirroring
 * `global_setup_schema_parity.ts`. The two suites keep out of each other's
 * buckets: the login limiters and the action limiters are separate instances,
 * and each case reads its own forwarded IP or fresh keeper account.
 * Both backends run on ports, a stub database and backend names of their own
 * (`SECURITY_*` below), so this project runs beside every other cross project.
 * The Rust side is made current first (rebuild + `createdb` of
 * `SECURITY_STUB_DATABASE`) via `prepare_rust_spine_backend`; the stub
 * self-wipes it on startup.
 *
 * @module
 */

import { create_dual_spawn_global_setup } from '#lib/testing/cross_backend/create_dual_spawn_global_setup.ts';
import { ts_spine_node_backend_config } from '#lib/testing/cross_backend/ts_spine_backend_config.ts';
import { rust_spine_stub_backend_config } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import { with_database_name } from '#lib/testing/cross_backend/postgres_database.ts';
import type { TestProject } from 'vitest/node';

import './cross_test_types.ts';
import {
	prepare_rust_spine_backend,
	resolve_rust_spine_stub_database_url,
	RUST_SPINE_STUB_CRATE
} from './global_setup_helpers.ts';

/**
 * The security stub's Postgres database, on the server the stub's URL names —
 * its own, since every stub wipes its database at startup.
 */
const SECURITY_STUB_DATABASE = 'fuz_app_test_rust_spine_stub_security';

/** The TS leg's port — past the parity project's `1181` / `1182`. */
const SECURITY_TS_PORT = 1183;

/** The security stub's port. */
const SECURITY_STUB_PORT = 1184;

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
const create_dual_spawn = (stub_database_url: string) =>
	create_dual_spawn_global_setup({
		configs: {
			a: () =>
				ts_spine_node_backend_config({
					name: 'ts_spine_node_security',
					port: SECURITY_TS_PORT,
					enable_login_rate_limit: true,
					enable_action_rate_limit: true,
					action_rate_limit_max_attempts: ACTION_RATE_LIMIT_MAX_ATTEMPTS
				}),
			b: () =>
				rust_spine_stub_backend_config({
					name: 'spine_stub_security',
					port: SECURITY_STUB_PORT,
					database_url: stub_database_url,
					enable_login_rate_limit: true,
					enable_action_rate_limit: true,
					action_rate_limit_max_attempts: ACTION_RATE_LIMIT_MAX_ATTEMPTS,
					trusted_proxies: '127.0.0.1,::1'
				})
		},
		provide_keys: { a: 'security_handle_a', b: 'security_handle_b' }
	});

const setup = (project: TestProject): Promise<() => Promise<void>> => {
	const stub_database_url = with_database_name(
		resolve_rust_spine_stub_database_url(),
		SECURITY_STUB_DATABASE
	);
	// Make the Rust stub binary current + ensure its DB before the dual spawn.
	prepare_rust_spine_backend({ crate: RUST_SPINE_STUB_CRATE, database_url: stub_database_url });
	project.provide('security_action_rate_limit_max_attempts', ACTION_RATE_LIMIT_MAX_ATTEMPTS);
	return create_dual_spawn(stub_database_url)(project);
};

export default setup;
