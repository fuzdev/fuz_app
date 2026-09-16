/**
 * Vitest `globalSetup` for the `cross_backend_security` project — spawns +
 * bootstraps BOTH backends with the login limiters enabled + the loopback
 * proxy trusted (the TS spine on Node + PGlite as `a`, the Rust
 * `testing_spine_stub` over real Postgres as `b`) and provides both serialized
 * handles, so `login_security.cross.test.ts` can drive the login rate-limit +
 * XFF parity suite against each.
 *
 * The standard single-backend `global_setup_*.ts` makers null every limiter
 * (the standard cross suites fire many loopback logins a live limiter would
 * `429`), so the login limiters can only be exercised on a backend nothing else
 * shares — this dedicated dual-spawn, mirroring `global_setup_schema_parity.ts`.
 * The Rust side is made current first (rebuild + `createdb`) via
 * `prepare_rust_spine_backend`, sharing the stub's DB + port with the other Rust
 * projects (it self-wipes on startup). Like every cross project, this one is run
 * as its own script (`npm run test:cross:security`), never in the same `vitest`
 * invocation as the parity / rust-stub projects — vitest spawns all projects'
 * globalSetups upfront, so two port-sharing dual-spawns would collide on the
 * shared port.
 *
 * @module
 */

import { create_dual_spawn_global_setup } from '$lib/testing/cross_backend/create_dual_spawn_global_setup.ts';
import { ts_spine_node_backend_config } from '$lib/testing/cross_backend/ts_spine_backend_config.ts';
import { rust_spine_stub_backend_config } from '$lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import type { TestProject } from 'vitest/node';

import './cross_test_types.ts';
import { prepare_rust_spine_backend } from './global_setup_helpers.ts';

// The generic "spawn two backends, provide two handles" maker. Both backends
// enable the login limiters; the Rust side also opts into XFF resolution (the
// TS binary wires `trusted_proxies` unconditionally).
const dual_spawn = create_dual_spawn_global_setup({
	configs: {
		a: () => ts_spine_node_backend_config({ enable_login_rate_limit: true }),
		b: () =>
			rust_spine_stub_backend_config({
				enable_login_rate_limit: true,
				trusted_proxies: '127.0.0.1,::1'
			})
	},
	provide_keys: { a: 'security_handle_a', b: 'security_handle_b' }
});

const setup = (project: TestProject): Promise<() => Promise<void>> => {
	// Make the Rust stub binary current + ensure its DB before the dual spawn.
	// (Matches `global_setup.ts` / `global_setup_schema_parity.ts` so all the Rust
	// projects share the one DB.)
	prepare_rust_spine_backend({
		crate: 'testing_spine_stub',
		database: 'fuz_app_test_rust_spine_stub'
	});
	return dual_spawn(project);
};

export default setup;
