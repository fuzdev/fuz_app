/**
 * The fuz_app-only keys of vitest's `ProvidedContext`.
 *
 * `backend_handle` and the dual-spawn `parity_handle_a` / `parity_handle_b`
 * come from the library's `testing/cross_backend/provided_context.ts` (read
 * with `inject_backend_handle` / `inject_parity_handles`); this module adds the
 * keys only fuz_app's own projects provide. Import it for its side effect where
 * one of them is provided or injected: `import './cross_test_types.ts';`.
 *
 * @module
 */

import type { SerializableBootstrappedBackendHandle } from '#lib/testing/cross_backend/setup.ts';

import type { BootstrapTokenProbeResult } from './bootstrap_token_probe.ts';

declare module 'vitest' {
	export interface ProvidedContext {
		// what the single-backend setup's pre-bootstrap token-file probe got
		// back (`bootstrap_token_probe.ts`), asserted by `bootstrap_token.cross.test.ts`
		bootstrap_token_probe: Array<BootstrapTokenProbeResult>;
		// The dual-spawn security project (`global_setup_login_security.ts`)
		// provides both backends' handles — `a` = TS spine (node), `b` = Rust
		// `testing_spine_stub`, both with the login and action limiters enabled +
		// the loopback proxy trusted — so `login_security.cross.test.ts` and
		// `ws_action_rate_limit.cross.test.ts` run against each impl. The action
		// limiters' cap rides along so the suite asserts the number the backends
		// were started with.
		security_handle_a: SerializableBootstrappedBackendHandle;
		security_handle_b: SerializableBootstrappedBackendHandle;
		security_action_rate_limit_max_attempts: number;
		// The dual-spawn TS-runtime differential project
		// (`global_setup_ts_differential.ts`) provides the TS spine binary's
		// handle on two runtimes — `a` = Node, `b` = Bun — for
		// `differential_ts.cross.test.ts`.
		ts_differential_handle_a: SerializableBootstrappedBackendHandle;
		ts_differential_handle_b: SerializableBootstrappedBackendHandle;
		// The dual-spawn timing project (`global_setup_timing.ts`) provides
		// both backends' handles — `a` = TS spine (node), `b` = Rust
		// `testing_spine_stub`, both with the audit stream's keep-alive interval
		// and the WS receive timeout shortened — plus the two intervals, so
		// `sse_keep_alive.cross.test.ts` and `ws_receive_timeout.cross.test.ts`
		// assert against the values the backends were started with.
		timing_handle_a: SerializableBootstrappedBackendHandle;
		timing_handle_b: SerializableBootstrappedBackendHandle;
		timing_audit_sse_keep_alive_ms: number;
		timing_ws_receive_timeout_ms: number;
	}
}
