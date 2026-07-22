/**
 * Cross-backend login-security gate for fuz_app's own spine.
 *
 * Runs `describe_login_security_cross_tests` against BOTH impls — the TS spine
 * (Node + PGlite) and the Rust `testing_spine_stub` (real Postgres) — spawned
 * by the dual-spawn `global_setup_login_security.ts` with the login limiters
 * enabled + the loopback proxy trusted. It proves the per-IP login `429` +
 * `Retry-After` shape and the `X-Forwarded-For` bucket keying converge over the
 * wire on both implementations.
 *
 * This is a DEDICATED project (`cross_backend_security`) rather than a row in
 * the single-backend projects: those null every limiter (the standard suites
 * fire many loopback logins that a live limiter would `429`), so the limiter
 * can only be enabled on a backend nothing else shares. Dual-spawn so one
 * project covers both impls — mirroring `cross_backend_parity`.
 *
 * Opt-in (behind `FUZ_TEST_CROSS_BACKEND=1`); the Rust side needs a Postgres
 * the stub can reach — `npm run test:cross:security` rebuilds the stub + creates
 * its DB by default.
 *
 * @module
 */

import { inject, describe } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_login_security_cross_tests } from '$lib/testing/cross_backend/login_security.ts';

import './cross_test_types.ts';

const ts = reconstruct_bootstrapped_handle(inject('security_handle_a'));
const rust = reconstruct_bootstrapped_handle(inject('security_handle_b'));

describe('TS spine (node)', () => {
	describe_login_security_cross_tests({ setup_test: default_cross_process_setup(ts) });
});

describe('Rust spine_stub', () => {
	describe_login_security_cross_tests({ setup_test: default_cross_process_setup(rust) });
});
