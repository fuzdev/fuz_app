/**
 * SSE auth guard, connection closer, and convenience factory for audit log SSE.
 *
 * An SSE stream is authorized once, at open, and then only emits — nothing
 * re-reads its credential or its role. Two things close it when its access is
 * revoked:
 *
 * - `create_sse_connection_closer` adapts a `SubscriberRegistry` to
 *   `ConnectionCloser`, so the revocation handlers close streams directly
 *   after their transaction commits (`queue_connection_close`), whatever
 *   happens to the audit write.
 * - `create_sse_auth_guard` is the audit-event listener: it repeats those
 *   closes when the row is announced, and it is the only closer for a role
 *   revocation.
 *
 * `create_audit_log_sse` is a convenience factory that combines the registry,
 * guard, closer, and broadcaster — making the secure path the easy path for
 * consumers.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { UnreachableError } from '@fuzdev/fuz_util/error.ts';

import {
	AUDIT_EVENT_TYPES,
	AuditLogEventJson,
	to_revocation_scope,
	type AuditLogEvent
} from '../auth/audit_log_schema.ts';
import type { ConnectionCloser, RealtimeCloser } from '../actions/connection_closer.ts';
import { SubscriberRegistry } from './subscriber_registry.ts';
import type { SseNotification, EventSpec } from './sse.ts';

/** SSE channel the audit-log stream route publishes on. */
export const AUDIT_LOG_CHANNEL = 'audit_log';

/**
 * Adapt a `SubscriberRegistry` to `ConnectionCloser`, so a revocation handler's
 * close reaches its streams.
 *
 * Each method is `SubscriberRegistry.close_by_identity` on the id it is given,
 * so it closes the streams registered under that id as their `scope` or in
 * their `groups` — pending registrations included. The audit stream route
 * registers `scope = session hash` and `groups = [account id]`; a route that
 * admits bearer tokens registers the API token id too, and
 * `close_sockets_for_token` then reaches it. `close_all_sockets` is
 * `SubscriberRegistry.close_all` — every stream, for shutdown.
 *
 * Twin of the Rust spine's `SocketRevoker` impl on `SseRegistry`.
 */
export const create_sse_connection_closer = <T>(
	registry: SubscriberRegistry<T>
): ConnectionCloser => ({
	close_sockets_for_session: (session_token_hash) => registry.close_by_identity(session_token_hash),
	close_sockets_for_token: (api_token_id) => registry.close_by_identity(api_token_id),
	close_sockets_for_account: (account_id) => registry.close_by_identity(account_id),
	close_all_sockets: () => registry.close_all()
});

/**
 * Create an audit event handler that closes SSE streams on a successful
 * revocation row, dispatching on the event's `RevocationScope`
 * (`audit_event_revocation_scopes`, the table `create_ws_auth_guard` reads
 * too):
 *
 * - `session` → the stream registered under the revoked session's hash
 *   (`metadata.session_id`). Closing all of an account's streams for a
 *   single-session revoke would be over-aggressive.
 * - `token` → the stream registered under the revoked API token's id
 *   (`metadata.token_id`). The audit stream route admits sessions only, so no
 *   stream of its own is keyed that way; a consumer route that admits bearers
 *   registers the token id and is closed here.
 * - `account` → every stream of `target_account_id ?? account_id`.
 * - `role` → every stream of the target account, when the revoked role
 *   (`metadata.role`) is `required_role`. The WebSocket guard does not act on
 *   this scope — per-message dispatch re-authorizes there — but a one-way
 *   stream has no later check, so it must close here.
 * - `none` → nothing.
 *
 * Over-closing a one-way feed is cheap: the client reconnects if it is still
 * authorized.
 *
 * The registry's subscribers must carry `account_id` as an identity key (in
 * `SubscribeOptions.groups`), and the session hash as `scope` for the
 * session-scoped close.
 *
 * @param registry - the subscriber registry to guard
 * @param required_role - the role that grants access to the SSE endpoint,
 *   or `null` to skip `role_grant_revoke` handling entirely (for streams not gated
 *   by a specific role_grant)
 * @param log - logger for disconnect events
 * @returns an `on_audit_event` callback
 */
export const create_sse_auth_guard = <T>(
	registry: SubscriberRegistry<T>,
	required_role: string | null,
	log: Logger
): ((event: AuditLogEvent) => void) => {
	return (event: AuditLogEvent): void => {
		// Only act on successful revocations. Failed attempts carry
		// attacker-controlled identifiers (e.g., session_revoke with outcome=failure
		// carries the submitted session_id even when the DB rejected the cross-account
		// mutation) — reacting to them lets any authenticated user close another
		// user's SSE stream by guessing or leaking a session hash.
		if (event.outcome === 'failure') return;

		const scope = to_revocation_scope(event.event_type);
		switch (scope) {
			case 'none':
				return;
			case 'session': {
				const session_id = event.metadata?.session_id;
				if (typeof session_id !== 'string' || session_id.length === 0) return;
				const closed = registry.close_by_identity(session_id);
				if (closed > 0) {
					log.info(
						`SSE auth guard: closed ${closed} stream(s) for session ${session_id} (${event.event_type})`
					);
				}
				return;
			}
			case 'token': {
				const token_id = event.metadata?.token_id;
				if (typeof token_id !== 'string' || token_id.length === 0) return;
				const closed = registry.close_by_identity(token_id);
				if (closed > 0) {
					log.info(
						`SSE auth guard: closed ${closed} stream(s) for token ${token_id} (${event.event_type})`
					);
				}
				return;
			}
			case 'role':
				// `null` means the stream isn't gated by a specific role_grant, so
				// a role revocation closes nothing.
				if (required_role === null) return;
				if (event.metadata?.role !== required_role) return;
				break;
			case 'account':
				break;
			default:
				throw new UnreachableError(scope);
		}

		// `role` and `account` both close the affected account's streams —
		// admin actions set target_account_id, self-service actions only set
		// account_id
		const target = event.target_account_id ?? event.account_id;
		if (!target) return;

		const closed = registry.close_by_identity(target);
		if (closed > 0) {
			log.info(
				`SSE auth guard: closed ${closed} stream(s) for account ${target} (${event.event_type})`
			);
		}
	};
};

/**
 * Convenience factory result for audit log SSE.
 *
 * Satisfies `AuditLogRouteOptions['stream']` and provides the combined
 * `on_audit_event` callback (broadcast + guard).
 */
export interface AuditLogSse {
	/**
	 * The subscriber registry the audit stream route registers each stream on
	 * (two-phase: `subscribe_pending` then `admit`) — pass as part of the
	 * `stream` option to `create_audit_log_route_specs`. Also exposed for
	 * subscriber count monitoring.
	 */
	registry: SubscriberRegistry<SseNotification>;
	/** Logger — pass as part of `stream` option to `create_audit_log_route_specs`. */
	log: Logger;
	/** Combined broadcast + guard callback. Wired by `create_app_server`'s `audit_log_sse` option, or compose inside the consumer's `audit_factory` body. */
	on_audit_event: (event: AuditLogEvent) => void;
}

/**
 * SSE event specs for audit log events.
 *
 * One spec per `AUDIT_EVENT_TYPES` entry, all sharing the `AuditLogEventJson` params schema.
 * Pass to `create_app_server`'s `event_specs` for surface generation and DEV validation.
 */
export const audit_log_event_specs: Array<EventSpec> = AUDIT_EVENT_TYPES.map(
	(event_type): EventSpec => ({
		method: event_type,
		params: AuditLogEventJson,
		description: `Audit log: ${event_type.replaceAll('_', ' ')}`,
		channel: AUDIT_LOG_CHANNEL
	})
);

/**
 * Default max concurrent SSE subscribers per session scope for the audit log.
 *
 * The audit log SSE subscribes with `scope = session_hash` and
 * `groups = [account_id]`. Only `scope` is capped — so this limits tabs
 * per session. An account's total streams across all sessions is bounded
 * transitively by `max_sessions × AUDIT_LOG_SSE_MAX_PER_SCOPE`. 10 tabs
 * per session is a comfortable ceiling for normal use; consumers raising
 * it above ~50 should consider server-side connection limits.
 */
export const AUDIT_LOG_SSE_MAX_PER_SCOPE = 10;

/**
 * Create a complete audit log SSE setup with broadcasting, auth guard, and
 * connection closer.
 *
 * Combines `SubscriberRegistry`, `create_sse_auth_guard`, and the broadcast
 * call into a single object, and adds the registry to `connection_closer` for
 * good — the remover `add` returns is dropped, so a caller that must take the
 * registry out again passes `null` and adds it itself.
 * The result satisfies `AuditLogRouteOptions['stream']`
 * and provides the `on_audit_event` listener for the audit emitter.
 *
 * Most consumers pass `audit_log_sse: true` to `create_app_server` and never
 * touch this directly — the factory builds an `AuditLogSse`, registers
 * `audit_sse.on_audit_event` via `backend.deps.audit.add_listener`, and
 * exposes it via `AppServerContext.audit_sse`. Reach for the manual path
 * (compose inside `audit_factory` body, or
 * `audit.add_listener(audit_sse.on_audit_event)` post-assembly) only
 * when wiring outside `create_app_server`.
 *
 * @param options - factory options
 * @returns audit log SSE setup (stream options + `on_audit_event` + registry)
 *
 * @example
 * ```ts
 * const connection_closer = create_realtime_closer();
 * const audit_sse = create_audit_log_sse({log, connection_closer});
 *
 * // On CreateAppBackendOptions — the same closer, and the listener inside
 * // the audit_factory body:
 * connection_closer,
 * audit_factory: ({db, log}) => create_audit_emitter({
 *   db,
 *   log,
 *   on_audit_event: audit_sse.on_audit_event,
 * }),
 *
 * // In create_route_specs:
 * create_audit_log_route_specs({stream: audit_sse});
 *
 * // In create_app_server options:
 * event_specs: audit_log_event_specs,
 * ```
 */
export const create_audit_log_sse = (options: {
	/** Role required to access the SSE endpoint. Default `'admin'`. */
	role?: string;
	log: Logger;
	/**
	 * The backend's closer — `deps.connection_closer`. The new registry is
	 * added to it, so every revocation handler's close reaches these streams.
	 * Required so it can't be forgotten: without it a revoked credential's
	 * streams close only through the audit listener, which a failed audit write
	 * or a cap eviction never reaches. Pass `null` only for a registry no
	 * revocation has to reach (tests of the registry itself), or when the
	 * caller adds `create_sse_connection_closer(registry)` itself — as
	 * `create_app_server` does, to hold the remover `add` returns.
	 */
	connection_closer: RealtimeCloser | null;
	/**
	 * Max concurrent SSE subscribers per session scope. On overflow, the oldest
	 * matching subscriber is closed. Default `AUDIT_LOG_SSE_MAX_PER_SCOPE`.
	 * Pass `null` to disable the cap.
	 */
	max_per_scope?: number | null;
}): AuditLogSse => {
	const role = options.role ?? 'admin';
	const max_per_scope =
		options.max_per_scope === undefined ? AUDIT_LOG_SSE_MAX_PER_SCOPE : options.max_per_scope;
	const registry = new SubscriberRegistry<SseNotification>({ max_per_scope, log: options.log });
	const guard = create_sse_auth_guard(registry, role, options.log);
	options.connection_closer?.add(create_sse_connection_closer(registry));

	return {
		log: options.log,
		on_audit_event: (event: AuditLogEvent): void => {
			registry.broadcast(AUDIT_LOG_CHANNEL, { method: event.event_type, params: event });
			guard(event);
		},
		registry
	};
};
