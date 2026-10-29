/**
 * Hono context variable augmentation for fuz_app.
 *
 * Cross-cutting shared vocabulary — defines the Hono `ContextVariableMap`
 * variables used by auth, http, server, and testing modules.
 *
 * Auto-loaded by `server/app_server.ts` (side-effect import) and
 * transitively by auth middleware modules that import `RESOLVED_AUTH_KEY`.
 * Consumers don't need a manual import unless bypassing the standard server assembly.
 *
 * @module
 */

import type { RequestContext } from './auth/request_context.ts';
import type { ResolvedAuth } from './auth/resolved_auth.ts';

/**
 * Hono context variable name for the request's resolved credential
 * (`ResolvedAuth`) — the one value every auth middleware leg writes, read
 * through `get_resolved_auth`.
 *
 * The daemon-token, session, and bearer legs run in that order, and the first
 * that authenticates sets it; the legs after it see it set and skip. Unset
 * (read as `null`) for an unauthenticated request.
 */
export const RESOLVED_AUTH_KEY = 'resolved_auth';

/**
 * Hono context variable name for the session cookie's signed expiry, in
 * seconds since the Unix epoch — set by the session middleware on a cookie
 * that verified and has not expired, `null` otherwise. The request-context
 * middleware folds it into the session's `ResolvedAuth.credential_deadline`.
 */
export const SESSION_COOKIE_EXPIRES_AT_KEY = 'auth_session_cookie_expires_at';

/**
 * Hono context variable name for the test-harness pre-baked context flag.
 *
 * Test harnesses (`create_test_app_from_specs`, `create_fake_hono_context`,
 * the WS round-trip `connect()` helper, plus per-test middleware that
 * pre-populates `REQUEST_CONTEXT_KEY`) set this to `true` so
 * `apply_authorization_phase` skips its DB-backed actor resolution and
 * trusts the supplied `RequestContext`. Production middleware never sets
 * this key — only test code does. The flag is the explicit escape hatch
 * that replaced the implicit "is `REQUEST_CONTEXT_KEY` already set?" probe,
 * so that future production code consulting `REQUEST_CONTEXT_KEY` cannot
 * silently bypass the live build.
 */
export const TEST_CONTEXT_PRESET_KEY = 'test_context_preset';

declare module 'hono' {
	interface ContextVariableMap {
		/** Resolved client IP, set by the trusted proxy middleware. */
		client_ip: string;
		auth_session_id: string | null;
		request_context: RequestContext | null;
		validated_input: unknown;
		validated_params: unknown;
		validated_query: unknown;
		/**
		 * The credential the auth middleware resolved (`RESOLVED_AUTH_KEY`);
		 * `null` or unset for an unauthenticated request. Read it with
		 * `get_resolved_auth`.
		 */
		resolved_auth: ResolvedAuth | null;
		/** The session cookie's signed expiry, epoch seconds (`SESSION_COOKIE_EXPIRES_AT_KEY`). */
		auth_session_cookie_expires_at: number | null;
		/**
		 * Eager fire-and-forget pool writes for this request — audit emits,
		 * api-token usage tracking. Producers push the
		 * in-flight `Promise<void>` directly. The flush middleware drains via
		 * `flush_pending_effects` after the handler returns. Initialized by
		 * `create_app_server`. In test mode (`await_pending_effects: true`),
		 * every promise resolves before the response returns.
		 */
		pending_effects: Array<Promise<void>>;
		/**
		 * Post-commit thunks pushed via `emit_after_commit(ctx, fn)`. The flush
		 * middleware invokes each thunk after the handler returns — never inline
		 * — so notifications (WS sends, etc.) cannot fire mid-transaction; the
		 * queue is also discarded when the handler's transaction rolls back, so a
		 * thunk never fires for state that never committed. Full contract (the
		 * eager-`pending_effects` contrast, the discard mechanism, the flush
		 * safety net) lives on `dispatch_with_post_commit_rollback` /
		 * `emit_after_commit` in `http/pending_effects.ts`. Producers do not push
		 * raw thunks directly. Initialized by `create_app_server`; in test mode
		 * (`await_pending_effects: true`), every thunk completes before the
		 * response returns.
		 */
		post_commit_effects: Array<() => void | Promise<void>>;
		/**
		 * Set to `true` by test harnesses that pre-populate `request_context`
		 * to bypass the dispatcher's DB-backed actor resolution. Read by
		 * `apply_authorization_phase`. Production middleware never sets this.
		 */
		test_context_preset: boolean;
	}
}
