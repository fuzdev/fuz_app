/**
 * WebSocket auth guard — the audit-event listener that closes live
 * connections when a row reports a revocation.
 *
 * **Why this exists.** `register_action_ws` captures `account_id` and
 * `credential_type` at upgrade time and reuses them for every message.
 * `perform_action`'s per-message authorization phase reloads role_grants
 * from the DB, but session and token VALIDITY are not re-queried per message
 * — they are re-read once, at admission (`revalidate_resolved_auth`) — a
 * trade-off that keeps chatty WS connections fast. The cost: nothing in the
 * dispatch path notices when a session is revoked or a token is rotated, so a
 * revocation reaches an open connection only when something closes it.
 *
 * Two things do. The revocation handlers close directly, after their
 * transaction commits (`queue_connection_close` in
 * `actions/connection_closer.ts`) — that close does not depend on the audit
 * write. This guard repeats it when the audit row is announced, which covers
 * a revocation emitted by code that holds no closer. Closing is idempotent, so
 * the overlap is a repeat, not a conflict. A success row is announced only
 * after its request's transaction commits (`auth/audit_emitter.ts`), so the
 * guard's close is post-commit too.
 *
 * ## Which rows close
 *
 * The guard dispatches on the `RevocationScope` each audit event declares in
 * `audit_event_revocation_scopes` (`auth/audit_log_schema.ts`), the table the
 * SSE guard (`realtime/sse_auth_guard.ts`) reads too — one declaration, so the
 * two cannot drift into closing a revoked token's socket while leaving its
 * stream open.
 *
 * `role` is the one scope this guard deliberately does not act on:
 * `perform_action` re-authorizes every message, so a socket whose account just
 * lost the gating role is refused at its next message, and closing it would
 * only change when the caller learns. A stream has no later check, so the SSE
 * guard closes there.
 *
 * For standard WS endpoints mounted via `AppServerOptions.ws_endpoints`,
 * `create_app_server` registers the guard automatically per
 * `WsEndpointSpec.auth_guard`. For custom wiring, register the handler
 * inside the consumer's `audit_factory` body (or via
 * `audit.add_listener(...)` post-assembly).
 *
 * Twin of the Rust spine's `register_socket_revocation_listeners`.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { UnreachableError } from '@fuzdev/fuz_util/error.ts';

import { to_revocation_scope, type AuditLogEvent } from '../auth/audit_log_schema.ts';
import type { ConnectionCloser } from './connection_closer.ts';

/**
 * Audit-event callback shape — the function `CreateAuditEmitterOptions.on_audit_event`
 * accepts and that `create_ws_auth_guard` returns.
 *
 * Exported so consumers composing multiple handlers (typically
 * `create_ws_auth_guard` + their own pre-existing `on_audit_event`) can
 * annotate their composed callback without reaching for
 * `Parameters<typeof create_ws_auth_guard>[0]`.
 */
export type AuditEventHandler = (event: AuditLogEvent) => void;

/**
 * Create an audit event handler that closes connections on a successful
 * revocation row, dispatching on the event's `RevocationScope`:
 *
 * - `session` → `close_sockets_for_session(metadata.session_id)`
 * - `token` → `close_sockets_for_token(metadata.token_id)`
 * - `account` → `close_sockets_for_account(target_account_id ?? account_id)`
 *   — `logout`, `password_change`, `session_revoke_all`, `token_revoke_all`,
 *   `account_delete`, `account_purge`
 * - `role` → nothing, deliberately (module doc)
 * - `none` → nothing — every other event, and any event type fuz_app does not
 *   define
 *
 * Ignores `outcome === 'failure'` events — they carry attacker-controlled
 * identifiers (e.g. a `session_revoke` that the DB rejected still records
 * the submitted session_id), so reacting to them would let any authenticated
 * user close another user's socket by guessing a session hash or token id.
 *
 * @param closer - what to close on — a `BackendWebsocketTransport`, or a
 *   `RealtimeCloser` to reach every transport from one listener
 * @param log - logger for disconnect events (info level on non-zero closures)
 * @returns an `on_audit_event` callback suitable for `create_audit_emitter`'s
 *   `on_audit_event` slot, or for registering via
 *   `audit.add_listener` post-assembly. The returned callback closes matching
 *   connections on `closer` on every relevant event.
 */
export const create_ws_auth_guard = (closer: ConnectionCloser, log: Logger): AuditEventHandler => {
	return (event: AuditLogEvent): void => {
		// Failed mutations carry attacker-controlled metadata — never act on them.
		if (event.outcome === 'failure') return;

		const scope = to_revocation_scope(event.event_type);
		switch (scope) {
			case 'none':
				return;
			// A decision, not a fallthrough: per-message dispatch re-authorizes,
			// so the next message is refused. The SSE guard closes on this scope.
			case 'role':
				return;
			case 'session': {
				const session_id = event.metadata?.session_id;
				if (typeof session_id !== 'string' || session_id.length === 0) return;
				const closed = closer.close_sockets_for_session(session_id);
				if (closed > 0) {
					log.info(
						`WS auth guard: closed ${closed} socket(s) for session ${session_id} (${event.event_type})`
					);
				}
				return;
			}
			case 'token': {
				const token_id = event.metadata?.token_id;
				if (typeof token_id !== 'string' || token_id.length === 0) return;
				const closed = closer.close_sockets_for_token(token_id);
				if (closed > 0) {
					log.info(
						`WS auth guard: closed ${closed} socket(s) for token ${token_id} (${event.event_type})`
					);
				}
				return;
			}
			case 'account': {
				// Admin actions set `target_account_id`; self-service actions only
				// set `account_id`.
				const target = event.target_account_id ?? event.account_id;
				if (!target) return;
				const closed = closer.close_sockets_for_account(target);
				if (closed > 0) {
					log.info(
						`WS auth guard: closed ${closed} socket(s) for account ${target} (${event.event_type})`
					);
				}
				return;
			}
			default:
				throw new UnreachableError(scope);
		}
	};
};
