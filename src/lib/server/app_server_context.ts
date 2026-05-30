/**
 * The context threaded to route / RPC / WS endpoint factories.
 *
 * Lives in its own module — separate from `server/app_server.ts` — so it can
 * be consumed as a **pure type** without dragging in the server-assembly
 * machinery. `app_server.ts` value-imports `hono` (it builds the `Hono` app),
 * so importing anything from it forces `hono` to be installed. Contract-only
 * consumers — cross-process test surfaces, Rust-backed servers that reuse the
 * route/RPC spec factories without running the TS server — need
 * `AppServerContext` but not `hono`. Keeping the type here (only `import type`
 * dependencies, none of which value-import `hono`) lets them import it
 * framework-free.
 *
 * @module
 */

import type {AppDeps} from '../auth/deps.js';
import type {AppBackend} from './app_backend.js';
import type {BootstrapStatus} from '../auth/bootstrap_routes.js';
import type {SessionOptions} from '../auth/session_cookie.js';
import type {RateLimiter} from '../rate_limiter.js';
import type {AuditLogSse} from '../realtime/sse_auth_guard.js';

/** Context passed to `create_route_specs`. */
export interface AppServerContext {
	deps: AppDeps;
	backend: AppBackend;
	bootstrap_status: BootstrapStatus;
	session_options: SessionOptions<string>;
	/** Shared IP rate limiter (from options). `null` when not configured. */
	ip_rate_limiter: RateLimiter | null;
	/** Per-account login rate limiter (from options). `null` when not configured. */
	login_account_rate_limiter: RateLimiter | null;
	/** Per-account signup rate limiter (from options). `null` when not configured. */
	signup_account_rate_limiter: RateLimiter | null;
	/** Per-IP action-dispatcher rate limiter — shared across HTTP RPC + WS. `null` when not configured. */
	action_ip_rate_limiter: RateLimiter | null;
	/** Per-actor action-dispatcher rate limiter — shared across HTTP RPC + WS. `null` when not configured. */
	action_account_rate_limiter: RateLimiter | null;
	/**
	 * Factory-managed audit log SSE. Non-null when the `audit_log_sse`
	 * option was passed to `create_app_server`, `null` when omitted.
	 * Use `require_audit_sse(ctx)` to assert the invariant.
	 */
	audit_sse: AuditLogSse | null;
}
