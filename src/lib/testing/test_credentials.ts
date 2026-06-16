import './assert_dev_env.ts';

/**
 * Shared test credential constants — deliberately hono-free.
 *
 * `DEFAULT_TEST_PASSWORD` is the single source of truth for the password
 * the in-process and cross-process test fixtures bootstrap and log in with.
 * It lives in this leaf module (rather than `app_server.ts`) so the
 * cross-process setup helpers can import it **without** pulling in the
 * in-process Hono test app — `app_server.ts` transitively reaches
 * `create_app_server` (`new Hono()`), so any value import from it forces the
 * optional `hono` peer onto Rust-only consumers whose cross-process suites
 * never spawn the TS backend.
 *
 * Single-sourcing the constant keeps the in-process bootstrap, the
 * cross-process `mint_account` signup/login, and the integration suite's
 * hardcoded login bodies from drifting — a divergence becomes a typecheck
 * miss rather than a runtime password mismatch.
 *
 * @module
 */

/** Default password for test-bootstrapped accounts. */
export const DEFAULT_TEST_PASSWORD = 'test-password-123';
