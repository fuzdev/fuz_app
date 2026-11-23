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

import type { BackendConfig } from '#lib/testing/cross_backend/backend_config.ts';
import type { DbState } from '#lib/testing/cross_backend/db_state_diff.ts';
import type { SerializableBootstrappedBackendHandle } from '#lib/testing/cross_backend/setup.ts';

import type { BootstrapTokenProbe } from './bootstrap_token_probe.ts';
import type { BootstrapRateLimitProbe } from './bootstrap_rate_limit_probe.ts';

declare module 'vitest' {
	export interface ProvidedContext {
		// what the single-backend setup's pre-bootstrap token-file probe got
		// back, and whether the keeper bootstrap burned the file
		// (`bootstrap_token_probe.ts`), asserted by `bootstrap_token.cross.test.ts`
		bootstrap_token_probe: BootstrapTokenProbe;
		// what each parity backend's keeper bootstrap left in its database, read
		// before any test (`global_setup_schema_parity.ts`), diffed by
		// `bootstrap_db_state.cross.test.ts`
		parity_bootstrap_db_state: { a: DbState; b: DbState };
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
		// each backend's bootstrap 429, gathered before its keeper bootstrap
		// (`bootstrap_rate_limit_probe.ts`)
		security_bootstrap_rate_limit: { a: BootstrapRateLimitProbe; b: BootstrapRateLimitProbe };
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
		// The swap project (`global_setup_swap.ts`) provides its two backends'
		// configs, both over one database, for `backend_swap.cross.test.ts` to
		// spawn one at a time — `ts` = TS spine (node), `stub` = Rust
		// `testing_spine_stub` with its startup reset off.
		swap_backend_configs: { ts: BackendConfig; stub: BackendConfig };
		// The both-live project (`global_setup_both_live.ts`) provides its two
		// backends' configs, over one database, for
		// `backend_both_live.cross.test.ts` to spawn and run at once — `ts` =
		// TS spine (node), `stub` = Rust `testing_spine_stub` with its startup
		// reset off.
		both_live_backend_configs: { ts: BackendConfig; stub: BackendConfig };
	}
}
