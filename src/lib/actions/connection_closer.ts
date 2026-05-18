/**
 * Narrow structural capability for closing live WebSocket connections
 * tied to a session token hash, API token id, or account id.
 *
 * **Why this exists.** Per-message authorization phase on WebSocket
 * (`actions/perform_action.ts`) reloads role_grants from the DB on every
 * message but does NOT re-query session / token validity — that
 * trade-off keeps chatty connections fast. The cost: revocation
 * doesn't actually disconnect open sockets unless something closes
 * them. `transports_ws_auth_guard.ts` is the listener-based seam
 * (audit-event → close), but it only fires after the audit INSERT
 * succeeds — if the INSERT fails (DB error, pool exhausted, handler
 * dies mid-flight) the listener never runs and the live socket keeps
 * working with a stale `RequestContext` until disconnect.
 *
 * Used by self-service revocation handlers (`account_session_revoke` /
 * `_revoke_all`, `account_token_revoke`, `logout`, `password`) and the
 * admin revoke-all handlers (`admin_session_revoke_all`,
 * `admin_token_revoke_all`) to eagerly drop affected sockets BEFORE
 * emitting the corresponding audit event. The audit listener stays as
 * a fail-safe for out-of-band emit sites (admin tools, scheduled
 * jobs, SSE-driven flows). `close_sockets_for_*` is idempotent so the
 * second pass is a no-op.
 *
 * Mirrors `zzz_server`'s `close_sockets_for_*` calls in
 * `account.rs::logout_inner` / `_password_inner` /
 * `handlers/account.rs::handle_account_session_revoke[_all]` /
 * `_token_revoke` (landed 2026-05-16).
 *
 * `BackendWebsocketTransport` satisfies this interface structurally,
 * so consumers pass their transport instance directly (same shape as
 * `NotificationSender`). The interface stays local so handlers don't
 * couple to the concrete transport, and tests can inject a capturing
 * stub with no WS machinery.
 *
 * @module
 */

/**
 * Narrow capability — three idempotent socket-close methods, each
 * returning the number of sockets actually closed (zero when none
 * matched). Callers typically ignore the return value (used by
 * telemetry / tests).
 */
export interface ConnectionCloser {
	/**
	 * Close every connection authenticated with a session whose blake3
	 * hash matches `session_token_hash`. Idempotent — calling on an
	 * already-closed session is a no-op.
	 */
	close_sockets_for_session: (session_token_hash: string) => number;
	/**
	 * Close every connection authenticated with the given API token id.
	 * Idempotent — calling on an already-revoked token is a no-op.
	 */
	close_sockets_for_token: (api_token_id: string) => number;
	/**
	 * Close every connection bound to `account_id`, regardless of
	 * credential type (session / api_token / daemon_token). Coarse
	 * closure used when every credential on an account is invalidated
	 * — password change, session-revoke-all, token-revoke-all, logout.
	 * Idempotent.
	 */
	close_sockets_for_account: (account_id: string) => number;
}
