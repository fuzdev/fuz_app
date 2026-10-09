/**
 * The context threaded to route / RPC / WS endpoint factories.
 *
 * Lives in its own module — separate from `server/app_server.ts` — so it can
 * be consumed as a **pure type** without dragging in the server-assembly
 * machinery. `server/app_server.ts` value-imports `hono` (it builds the `Hono` app),
 * so importing anything from it forces `hono` to be installed. Contract-only
 * consumers — cross-process test surfaces, Rust-backed servers that reuse the
 * route/RPC spec factories without running the TS server — need
 * `AppServerContext` but not `hono`. Keeping the type here (only `import type`
 * dependencies, none of which value-import `hono`) lets them import it
 * framework-free.
 *
 * @module
 */

import type { AppDeps } from '../auth/deps.ts';
import type { AppBackend } from './app_backend.ts';
import type { BootstrapStatus } from '../auth/bootstrap_routes.ts';
import type { SessionOptions } from '../auth/session_cookie.ts';
import type { RateLimiter } from '../rate_limiter.ts';
import type { AuditLogSse } from '../realtime/sse_auth_guard.ts';

/** Context passed to `create_route_specs`. */
export interface AppServerContext {
	deps: AppDeps;
	backend: AppBackend;
	bootstrap_status: BootstrapStatus;
	session_options: SessionOptions<string>;
	/**
	 * Per-IP login + password-change rate limiter. One instance per auth
	 * surface — see `AppServerOptions.login_ip_rate_limiter` for why these
	 * aren't shared.
	 *
	 * Each limiter here is what `create_app_server` resolved: the instance
	 * its option passed, else a default instance under
	 * `rate_limiters: 'enforced'` (the default). `null` when disabled — the
	 * option was an explicit `null`, or the mode is `'disabled_for_testing'`.
	 */
	login_ip_rate_limiter: RateLimiter | null;
	/** Per-IP signup rate limiter. `null` when disabled. */
	signup_ip_rate_limiter: RateLimiter | null;
	/** Per-IP bootstrap rate limiter. `null` when disabled. */
	bootstrap_ip_rate_limiter: RateLimiter | null;
	/** Per-account login rate limiter. `null` when disabled. */
	login_account_rate_limiter: RateLimiter | null;
	/** Per-account signup rate limiter. `null` when disabled. */
	signup_account_rate_limiter: RateLimiter | null;
	/** Per-IP action-dispatcher rate limiter — shared across HTTP RPC + WS. `null` when disabled. */
	action_ip_rate_limiter: RateLimiter | null;
	/**
	 * Per-account action-dispatcher rate limiter, keyed on the authenticated
	 * account's id — shared across HTTP RPC + WS. `null` when disabled.
	 */
	action_account_rate_limiter: RateLimiter | null;
	/**
	 * Factory-managed audit log SSE. Non-null when the `audit_log_sse`
	 * option was passed to `create_app_server`, `null` when omitted.
	 * Use `require_audit_sse(ctx)` to assert the invariant.
	 */
	audit_sse: AuditLogSse | null;
}
