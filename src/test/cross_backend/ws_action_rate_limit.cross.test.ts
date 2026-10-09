/**
 * Cross-backend action rate-limit gate for fuz_app's own spine.
 *
 * Runs `describe_ws_action_rate_limit_cross_tests` against BOTH impls — the TS
 * spine (Node + PGlite) and the Rust `testing_spine_stub` (real Postgres) —
 * spawned by the dual-spawn `global_setup_login_security.ts` with the action
 * limiters enabled at a small cap. It proves an action's throttle reaches the
 * WebSocket endpoint, keys the per-IP axis on the forwarded client IP, and
 * shares one budget with HTTP RPC, on both implementations.
 *
 * Runs under the dedicated `cross_backend_security` project for the same
 * reason the login-security gate does: the standard suites share their
 * backends, and a live limiter would throttle them.
 *
 * @module
 */

import { inject, describe } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_ws_action_rate_limit_cross_tests } from '$lib/testing/cross_backend/ws_action_rate_limit.ts';

import './cross_test_types.ts';

const ts = reconstruct_bootstrapped_handle(inject('security_handle_a'));
const rust = reconstruct_bootstrapped_handle(inject('security_handle_b'));
const max_attempts = inject('security_action_rate_limit_max_attempts');

describe('TS spine (node)', () => {
	describe_ws_action_rate_limit_cross_tests({
		setup_test: default_cross_process_setup(ts),
		base_url: ts.config.base_url,
		ws_path: ts.config.ws_path,
		rpc_path: ts.config.rpc_path,
		max_attempts
	});
});

describe('Rust spine_stub', () => {
	describe_ws_action_rate_limit_cross_tests({
		setup_test: default_cross_process_setup(rust),
		base_url: rust.config.base_url,
		ws_path: rust.config.ws_path,
		rpc_path: rust.config.rpc_path,
		max_attempts
	});
});
