/**
 * WebSocket auth guard — bridges audit events to `BackendWebsocketTransport`.
 *
 * Mirror of `realtime/sse_auth_guard.ts` for the backend WebSocket transport.
 * Dispatches audit events to the right `close_sockets_for_*` method so
 * consumers do not re-implement the switch themselves.
 *
 * Consumers wire it as `on_audit_event` on their `AppBackend` (or compose
 * it with other callbacks via `create_app_server`'s `audit_log_sse` path).
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.js';

import type {AuditLogEvent} from '../auth/audit_log_schema.js';
import type {BackendWebsocketTransport} from './transports_ws_backend.js';

/**
 * Audit-event callback shape — the function `CreateAppBackendOptions.on_audit_event`
 * accepts and that the helpers in this module return.
 *
 * Exported so consumers composing multiple handlers (typically
 * `create_ws_auth_guard` + `create_ws_logout_closer` + their own
 * pre-existing `on_audit_event`) can annotate their composed callback
 * without reaching for `Parameters<typeof create_ws_auth_guard>[0]`.
 */
export type AuditEventHandler = (event: AuditLogEvent) => void;

/**
 * Audit event types that trigger WebSocket socket closure.
 *
 * - `session_revoke` — close only the socket tied to the revoked session hash.
 * - `token_revoke` — close only the socket(s) authenticated with the revoked `api_token.id`.
 * - `session_revoke_all` / `token_revoke_all` / `password_change` — close every socket
 *   for the affected account (all credentials invalidated).
 *
 * `role_grant_revoke` is intentionally omitted: the WS transport does not track
 * per-connection role requirements, so role-scoped disconnection would
 * require either closing all sockets (too aggressive) or new tracking
 * (out of scope). Consumers that need it compose their own callback.
 */
export const ws_disconnect_event_types: ReadonlySet<string> = new Set([
	'session_revoke',
	'token_revoke',
	'session_revoke_all',
	'token_revoke_all',
	'password_change',
]);

/**
 * Create an audit event handler that closes WebSocket connections on auth changes.
 *
 * Ignores `outcome === 'failure'` events — they carry attacker-controlled
 * identifiers (e.g. a `session_revoke` that the DB rejected still records
 * the submitted session_id), so reacting to them would let any authenticated
 * user close another user's socket by guessing a session hash or token id.
 *
 * @param log - logger for disconnect events (info level on non-zero closures)
 * @returns an `on_audit_event` callback suitable for `CreateAppBackendOptions`.
 *   The returned callback mutates `transport` (closing matching sockets via
 *   `close_sockets_for_session` / `_token` / `_account`) on every relevant event.
 */
export const create_ws_auth_guard = (
	transport: BackendWebsocketTransport,
	log: Logger,
): AuditEventHandler => {
	return (event: AuditLogEvent): void => {
		if (!ws_disconnect_event_types.has(event.event_type)) return;

		// Failed mutations carry attacker-controlled metadata — never act on them.
		if (event.outcome === 'failure') return;

		if (event.event_type === 'session_revoke') {
			const session_id = event.metadata?.session_id;
			if (typeof session_id !== 'string' || session_id.length === 0) return;
			const closed = transport.close_sockets_for_session(session_id);
			if (closed > 0) {
				log.info(
					`WS auth guard: closed ${closed} socket(s) for session ${session_id} (session_revoke)`,
				);
			}
			return;
		}

		if (event.event_type === 'token_revoke') {
			const token_id = event.metadata?.token_id;
			if (typeof token_id !== 'string' || token_id.length === 0) return;
			const closed = transport.close_sockets_for_token(token_id);
			if (closed > 0) {
				log.info(`WS auth guard: closed ${closed} socket(s) for token ${token_id} (token_revoke)`);
			}
			return;
		}

		// session_revoke_all / token_revoke_all / password_change — all of the
		// account's credentials are invalidated; close every socket on the account.
		// Admin actions set `target_account_id`; self-service actions only set `account_id`.
		const target = event.target_account_id ?? event.account_id;
		if (!target) return;

		// `target` is a DB account id (string); the transport's account map is
		// keyed by the branded `Uuid` used elsewhere in fuz_app. Same value,
		// differing type disciplines across the audit-log and transport layers.
		const closed = transport.close_sockets_for_account(target);
		if (closed > 0) {
			log.info(
				`WS auth guard: closed ${closed} socket(s) for account ${target} (${event.event_type})`,
			);
		}
	};
};

/**
 * Create an audit event handler that closes WebSocket connections on
 * user-initiated logout.
 *
 * Sibling helper to `create_ws_auth_guard` — kept separate because
 * `ws_disconnect_event_types` deliberately omits `logout` (admin-initiated
 * revocations use `session_revoke`, while `logout` is the user-initiated
 * case). Three consumers (tx, undying, zzz) hand-rolled this same branch
 * before extraction.
 *
 * Compose with `create_ws_auth_guard` to handle both kinds of disconnect:
 *
 * ```ts
 * const ws_guard = create_ws_auth_guard(transport, log);
 * const ws_logout_closer = create_ws_logout_closer(transport, log);
 * const on_audit_event = (event: AuditLogEvent): void => {
 *   ws_guard(event);
 *   ws_logout_closer(event);
 * };
 * ```
 *
 * Ignores `outcome === 'failure'` events — failed logouts carry
 * unauthenticated identifiers (no session to close anyway), and reacting
 * to them would let an unauthenticated probe close the targeted account's
 * sockets by submitting a logout for an arbitrary `account_id`.
 *
 * @param log - logger for disconnect events (info level on non-zero closures)
 * @returns an `on_audit_event` callback wireable alongside `create_ws_auth_guard`.
 *   The returned callback mutates `transport` via `close_sockets_for_account`
 *   on every successful `logout` event with a non-empty `account_id`.
 */
export const create_ws_logout_closer = (
	transport: BackendWebsocketTransport,
	log: Logger,
): AuditEventHandler => {
	return (event: AuditLogEvent): void => {
		if (event.event_type !== 'logout') return;
		if (event.outcome === 'failure') return;

		const account_id = event.account_id;
		if (!account_id) return;

		const closed = transport.close_sockets_for_account(account_id);
		if (closed > 0) {
			log.info(`WS logout closer: closed ${closed} socket(s) for account ${account_id} (logout)`);
		}
	};
};
