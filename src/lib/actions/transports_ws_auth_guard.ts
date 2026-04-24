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
 * Audit event types that trigger WebSocket socket closure.
 *
 * - `session_revoke` — close only the socket tied to the revoked session hash.
 * - `token_revoke` — close only the socket(s) authenticated with the revoked `api_token.id`.
 * - `session_revoke_all` / `token_revoke_all` / `password_change` — close every socket
 *   for the affected account (all credentials invalidated).
 *
 * `permit_revoke` is intentionally omitted: the WS transport does not track
 * per-connection role requirements, so role-scoped disconnection would
 * require either closing all sockets (too aggressive) or new tracking
 * (out of scope). Consumers that need it compose their own callback.
 */
export const WS_DISCONNECT_EVENT_TYPES: ReadonlySet<string> = new Set([
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
 * @param transport - the backend WebSocket transport to guard
 * @param log - logger for disconnect events (info level on non-zero closures)
 * @returns an `on_audit_event` callback suitable for `CreateAppBackendOptions`
 */
export const create_ws_auth_guard = (
	transport: BackendWebsocketTransport,
	log: Logger,
): ((event: AuditLogEvent) => void) => {
	return (event: AuditLogEvent): void => {
		if (!WS_DISCONNECT_EVENT_TYPES.has(event.event_type)) return;

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
