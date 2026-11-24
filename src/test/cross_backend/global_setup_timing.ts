/**
 * Vitest `globalSetup` for the `cross_backend_timing` project — spawns +
 * bootstraps BOTH backends with the audit stream's keep-alive interval and
 * the WS endpoints' receive timeout shortened (the TS spine on Node +
 * in-memory pglet as `a`, the Rust `testing_spine_stub` over a database of its
 * own as `b` — a `pglet_server`, or PostgreSQL under `FUZ_TEST_POSTGRES_URL`) and provides both serialized handles plus the two intervals, so
 * `sse_keep_alive.cross.test.ts` and `ws_receive_timeout.cross.test.ts` watch
 * each impl's timers fire within seconds instead of the defaults' 15 s and
 * 60 s. Both also run with the pool checkout bounds shortened
 * (`FUZ_DB_CHECKOUT_TIMEOUT_MS`, `FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS`), which
 * `db_checkout_timeout.cross.test.ts` boots and probes — a real bound on the
 * stub's pool, a warned-of no-op on the TS spine's pool-less pglet.
 *
 * A dedicated dual-spawn, mirroring `global_setup_login_security.ts`: a
 * shortened receive timeout would close the standard suites' idle sockets
 * mid-case, so the intervals can only be shortened on backends nothing else
 * shares. Both backends run on ports, a stub database and backend names of
 * their own (`CROSS_PROJECT_RESOURCES`), so this project runs beside every
 * other cross project. The Rust side is made current first
 * (`rebuild_rust_spine_stub`).
 *
 * @module
 */

import { create_dual_spawn_global_setup } from '#lib/testing/cross_backend/create_dual_spawn_global_setup.ts';
import { ts_spine_node_backend_config } from '#lib/testing/cross_backend/ts_spine_backend_config.ts';
import { rust_spine_stub_backend_config } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import type { TestProject } from 'vitest/node';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';
import './cross_test_types.ts';
import {
	rebuild_rust_spine_stub,
	RUST_SPINE_STUB_CRATE,
	to_rust_spine_pglet_server,
	with_legible_setup_failure
} from './global_setup_helpers.ts';

/** The project's two backends — the stub over a database of its own. */
const { ts: TIMING_TS, stub: TIMING_STUB } = CROSS_PROJECT_RESOURCES.cross_backend_timing;

/**
 * The audit stream's keep-alive interval on both backends — short, so a
 * suite sees several keep-alives in a second.
 */
const AUDIT_SSE_KEEP_ALIVE_MS = 200;

/**
 * The WS endpoints' receive timeout on both backends — short, so a silent
 * socket closes within seconds, and long enough that a client sending a
 * heartbeat every few hundred ms never trips it, even on a loaded machine.
 */
const WS_RECEIVE_TIMEOUT_MS = 2000;

/**
 * The pool checkout bounds both backends boot with — far under the defaults
 * (5 s and 30 s), and long enough that an idle local pool never trips them.
 */
const DB_CHECKOUT_TIMEOUT_MS = 250;
const DB_AUDIT_CHECKOUT_TIMEOUT_MS = 1_000;

// The generic "spawn two backends, provide two handles" maker, both backends
// given the same two intervals.
const create_dual_spawn = () =>
	create_dual_spawn_global_setup({
		configs: {
			a: () =>
				ts_spine_node_backend_config({
					name: TIMING_TS.name,
					port: TIMING_TS.port,
					audit_sse_keep_alive_ms: AUDIT_SSE_KEEP_ALIVE_MS,
					ws_receive_timeout_ms: WS_RECEIVE_TIMEOUT_MS,
					db_checkout_timeout_ms: DB_CHECKOUT_TIMEOUT_MS,
					db_audit_checkout_timeout_ms: DB_AUDIT_CHECKOUT_TIMEOUT_MS
				}),
			b: (database_url) =>
				rust_spine_stub_backend_config({
					name: TIMING_STUB.name,
					port: TIMING_STUB.port,
					database_url,
					audit_sse_keep_alive_ms: AUDIT_SSE_KEEP_ALIVE_MS,
					ws_receive_timeout_ms: WS_RECEIVE_TIMEOUT_MS,
					db_checkout_timeout_ms: DB_CHECKOUT_TIMEOUT_MS,
					db_audit_checkout_timeout_ms: DB_AUDIT_CHECKOUT_TIMEOUT_MS
				})
		},
		databases: { b: { name: TIMING_STUB.database, pglet_server: to_rust_spine_pglet_server() } },
		provide_keys: { a: 'timing_handle_a', b: 'timing_handle_b' }
	});

const setup = (project: TestProject): Promise<() => Promise<void>> => {
	// make the Rust stub binary current before the dual spawn
	rebuild_rust_spine_stub({ crate: RUST_SPINE_STUB_CRATE });
	project.provide('timing_audit_sse_keep_alive_ms', AUDIT_SSE_KEEP_ALIVE_MS);
	project.provide('timing_ws_receive_timeout_ms', WS_RECEIVE_TIMEOUT_MS);
	return create_dual_spawn()(project);
};

export default with_legible_setup_failure('timing', setup);
