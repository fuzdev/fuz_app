import '../assert_dev_env.js';

/**
 * Capability vocabulary for cross-backend integration testing.
 *
 * Backends declare which optional behaviors they support; suite bodies
 * call `test_if(capabilities.X, ...)` to skip cases the backend doesn't
 * implement. No `if (config.name === 'rust')` branches anywhere — name-
 * checking is a code smell that says capability vocabulary is missing.
 *
 * In-process Hono via `default_in_process_setup` declares every
 * capability `true` (see `in_process_capabilities`). Cross-process
 * backends opt in per-flag on their `BackendConfig`.
 *
 * @module
 */

import {test} from 'vitest';

/**
 * Optional behaviors a backend may support. Each flag's TSDoc names the
 * tests that gate on it; add a new flag here before referencing it from
 * a suite body, and document the gating tests inline.
 */
export interface BackendCapabilities {
	/**
	 * Bearer token auth (`Authorization: Bearer <token>`) is wired through
	 * the backend's middleware stack. Gates the bearer-token cases in
	 * `describe_standard_integration_tests` and `describe_rate_limiting_tests`.
	 */
	readonly bearer_auth: boolean;
	/**
	 * Trusted-proxy XFF parsing is wired (`X-Forwarded-For` etc.). Gates
	 * the proxy-resolution cases in `describe_standard_integration_tests`
	 * and the future cross-process proxy integration suite.
	 */
	readonly trusted_proxy: boolean;
	/**
	 * Per-account login rate limiting is wired. Gates the per-account
	 * rate-limit cases in `describe_rate_limiting_tests`.
	 */
	readonly login_rate_limit: boolean;
	/**
	 * WebSocket transport is reachable end-to-end. Gates the cross-process
	 * WS round-trip suite; the in-process `describe_ws_round_trip_tests`
	 * runs against `register_action_ws` directly and ignores this flag.
	 */
	readonly ws: boolean;
	/**
	 * SSE transport is reachable end-to-end. Gates the cross-process SSE
	 * suite (`describe_cross_process_sse_tests` — connect, audit data frame,
	 * close-on-revoke); in-process SSE uses the `on_audit_event` hook and
	 * ignores this flag.
	 */
	readonly sse: boolean;
	/**
	 * Test has direct access to backend-internal state (keyring for
	 * signing cookies, DB pool for FK-structural raw queries). Always
	 * `true` for in-process Hono via `default_in_process_setup`; always
	 * `false` cross-process. Gates the 3 keyring reads in
	 * `describe_standard_integration_tests` (expired-cookie generation)
	 * and the FK-structural raw query in `describe_audit_completeness_tests`.
	 */
	readonly in_process_only: boolean;
}

/**
 * Capability declarations for the in-process Hono transport. Every flag
 * is `true` because in-process testing exercises the full backend with
 * no missing optional behaviors. Cross-process consumers
 * declare each flag explicitly per backend.
 */
export const in_process_capabilities: BackendCapabilities = Object.freeze({
	bearer_auth: true,
	trusted_proxy: true,
	login_rate_limit: true,
	ws: true,
	sse: true,
	in_process_only: true,
});

/**
 * Conditional `test()` wrapper — registers a vitest case only when
 * `cond` is true; otherwise registers it as `.skip` so the run still
 * surfaces the gated coverage in the report.
 *
 * Thin wrapper around vitest's `test.skipIf(!cond)` with the argument
 * order flipped to match the more readable `test_if(capabilities.bearer_auth, ...)`
 * call pattern.
 */
export const test_if = (cond: boolean, name: string, fn: () => void | Promise<void>): void => {
	if (cond) {
		test(name, fn);
	} else {
		test.skip(name, fn);
	}
};
