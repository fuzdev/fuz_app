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

import type { Context } from 'hono';

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
 * Hono context variable name for the session token — set by the session
 * middleware (`create_session_middleware`) to the token a verified, unexpired
 * session cookie carries, `null` otherwise, and read by the session leg of the
 * auth middleware (`create_request_context_middleware`), which hashes it to
 * find the `auth_session` row. Fixed rather than configurable: the session
 * middleware and the session leg must agree on it, and no other spine key may
 * share it.
 */
export const SESSION_TOKEN_KEY = 'auth_session_id';

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
 * pre-populates `REQUEST_CONTEXT_KEY`) set it to `TEST_CONTEXT_PRESET` so
 * `apply_authorization_phase` skips its DB-backed actor resolution and
 * trusts the supplied `RequestContext`. Production middleware never sets
 * this key — only test code does. The flag is the explicit escape hatch
 * that replaced the implicit "is `REQUEST_CONTEXT_KEY` already set?" probe,
 * so that future production code consulting `REQUEST_CONTEXT_KEY` cannot
 * silently bypass the live build. Read it with `has_test_context_preset`.
 */
export const TEST_CONTEXT_PRESET_KEY = 'test_context_preset';

/**
 * The one value that sets the test-harness preset (`TEST_CONTEXT_PRESET_KEY`).
 * A symbol, so only code that imports it can set the flag: a string, a
 * `true`, or any other value a misconfiguration or a request could put under
 * the key reads as unset. Testing only — no module outside `testing/` writes
 * it.
 */
export const TEST_CONTEXT_PRESET: unique symbol = Symbol('test_context_preset');

/**
 * Whether a test harness pre-baked this request's context — the key holds
 * `TEST_CONTEXT_PRESET` itself. The skip every transport makes of the live
 * authorization phase and the admission re-reads.
 *
 * @param c - the Hono context
 * @returns `true` only when the key holds the `TEST_CONTEXT_PRESET` symbol
 */
export const has_test_context_preset = (c: Context): boolean =>
	c.get(TEST_CONTEXT_PRESET_KEY) === TEST_CONTEXT_PRESET;

declare module 'hono' {
	interface ContextVariableMap {
		/** Resolved client IP, set by the trusted proxy middleware. */
		client_ip: string;
		/** The session token (`SESSION_TOKEN_KEY`), set by the session middleware. */
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
		 * Set to `TEST_CONTEXT_PRESET` by test harnesses that pre-populate
		 * `request_context` to bypass the dispatcher's DB-backed actor
		 * resolution. Read with `has_test_context_preset`. Production
		 * middleware never sets this.
		 */
		test_context_preset: typeof TEST_CONTEXT_PRESET;
	}
}
