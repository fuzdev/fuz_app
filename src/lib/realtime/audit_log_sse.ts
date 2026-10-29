/**
 * The audit log SSE stream's registry, its connection closer, and the
 * convenience factory that wires them.
 *
 * An SSE stream is authorized once, at open, and then only emits — nothing
 * re-reads its credential or its role. `create_sse_connection_closer` adapts a
 * `SseRegistry` to `ConnectionCloser`, and a registry added to the
 * backend's `deps.connection_closer` is closed by every revocation: the
 * handlers' own post-commit closes (`queue_connection_close`), and the one
 * audit listener on that closer (`create_revocation_guard`), which is also the
 * only closer for a role revocation.
 *
 * `create_audit_log_sse` builds the registry and its broadcaster and adds the
 * registry to the closer — making the secure path the easy path for consumers.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { UnreachableError } from '@fuzdev/fuz_util/error.ts';

import {
	AUDIT_EVENT_TYPES,
	AuditLogEventJson,
	type AuditLogEvent
} from '../auth/audit_log_schema.ts';
import type { ConnectionCloser, RealtimeCloser } from '../actions/connection_closer.ts';
import { SseRegistry } from './sse_registry.ts';
import type { SseNotification, EventSpec } from './sse.ts';
import { validate_sse_keep_alive_ms } from './sse_constants.ts';

/** SSE channel the audit-log stream route publishes on. */
export const AUDIT_LOG_CHANNEL = 'audit_log';

/**
 * Adapt an `SseRegistry` to `ConnectionCloser`, so a revocation handler's
 * close reaches its streams.
 *
 * `close_connections` is `SseRegistry.close_by_identity` on the id its
 * target carries, so it closes the streams registered under that id as their
 * `scope` or in their `groups` — pending registrations included. The audit
 * stream route registers `scope = session hash` and `groups = [account id]`; a
 * route that admits bearer tokens registers the API token id too, and a
 * `token` target then reaches it. A `role` target closes the account's
 * streams when its `role` is the one the registry's streams are gated on — the
 * registry keeps one gating role for all its streams, not one per stream.
 * `close_all_connections` is `SseRegistry.close_all` — every stream,
 * for shutdown.
 *
 * Twin of the Rust spine's `ConnectionCloser` impl on `SseRegistry`.
 *
 * @param registry - the registry to close streams on
 * @param required_role - the role every stream of `registry` was gated on,
 *   or `null` when they are not role-gated (a `role` target then closes
 *   nothing)
 */
export const create_sse_connection_closer = <T>(
	registry: SseRegistry<T>,
	required_role: string | null
): ConnectionCloser => ({
	close_connections: (target) => {
		switch (target.kind) {
			case 'session':
				return registry.close_by_identity(target.session_hash);
			case 'token':
				return registry.close_by_identity(target.api_token_id);
			case 'account':
				return registry.close_by_identity(target.account_id);
			case 'role':
				return required_role !== null && target.role === required_role
					? registry.close_by_identity(target.account_id)
					: 0;
			default:
				throw new UnreachableError(target);
		}
	},
	close_all_connections: () => registry.close_all()
});

/**
 * Convenience factory result for audit log SSE.
 *
 * Satisfies `AuditLogRouteOptions['stream']` and provides the `on_audit_event`
 * callback that broadcasts each row to the stream.
 */
export interface AuditLogSse {
	/**
	 * The SSE registry the audit stream route registers each stream on
	 * (two-phase: `subscribe_pending` then `admit`) — pass as part of the
	 * `stream` option to `create_audit_log_route_specs`. Also exposed for
	 * subscriber count monitoring.
	 */
	registry: SseRegistry<SseNotification>;
	/** Logger — pass as part of `stream` option to `create_audit_log_route_specs`. */
	log: Logger;
	/**
	 * Broadcasts each audit row to the stream's subscribers. Wired by
	 * `create_app_server`'s `audit_log_sse` option, or compose inside the
	 * consumer's `audit_factory` body. Closes nothing: revocations reach the
	 * streams through the registry's membership in the backend's closer.
	 */
	on_audit_event: (event: AuditLogEvent) => void;
	/**
	 * The role the stream requires — what a caller adapting `registry` passes
	 * `create_sse_connection_closer`, so a role revocation closes its streams.
	 */
	required_role: string;
	/**
	 * Each stream's keep-alive interval, read by the audit stream route
	 * (`AuditLogRouteOptions['stream']`); `undefined` keeps the default.
	 */
	keep_alive_ms?: number | null;
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
 * Create a complete audit log SSE setup: the registry, its broadcaster, and its
 * connection closer.
 *
 * Builds the `SseRegistry` and the broadcast callback, and adds the
 * registry to `connection_closer` for good — the remover `add` returns is
 * dropped, so a caller that must take the registry out again passes `null` and
 * adds it itself. Revocations close the streams through that closer: the
 * handlers' post-commit closes, and the `create_revocation_guard` listener on
 * it (which `create_app_server` registers; a hand wiring registers its own).
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
 * // On CreateAppBackendOptions — the same closer, and the listeners inside
 * // the audit_factory body:
 * connection_closer,
 * audit_factory: ({db, log}) => {
 *   const guard = create_revocation_guard(connection_closer, log);
 *   return create_audit_emitter({
 *     db,
 *     log,
 *     on_audit_event: (event) => {
 *       audit_sse.on_audit_event(event);
 *       guard(event);
 *     },
 *   });
 * },
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
	 * Required so it can't be forgotten: without it no revocation closes these
	 * streams — neither the handlers' closes nor the revocation guard, which
	 * closes through the same closer. Pass `null` only for a registry no
	 * revocation has to reach (tests of the registry itself), or when the
	 * caller adds `create_sse_connection_closer(registry, required_role)` itself — as
	 * `create_app_server` does, to hold the remover `add` returns.
	 */
	connection_closer: RealtimeCloser | null;
	/**
	 * Max concurrent SSE subscribers per session scope. On overflow, the oldest
	 * matching subscriber is closed. Default `AUDIT_LOG_SSE_MAX_PER_SCOPE`.
	 * Pass `null` to disable the cap.
	 */
	max_per_scope?: number | null;
	/**
	 * Each stream's keep-alive interval (`SseResponseOptions.keep_alive_ms`), in
	 * ms; `null` turns keep-alives off. A test server shortens it.
	 *
	 * @default SSE_KEEP_ALIVE_INTERVAL_MS
	 */
	keep_alive_ms?: number | null;
}): AuditLogSse => {
	validate_sse_keep_alive_ms(options.keep_alive_ms);
	const role = options.role ?? 'admin';
	const max_per_scope =
		options.max_per_scope === undefined ? AUDIT_LOG_SSE_MAX_PER_SCOPE : options.max_per_scope;
	const registry = new SseRegistry<SseNotification>({ max_per_scope, log: options.log });
	options.connection_closer?.add(create_sse_connection_closer(registry, role));

	return {
		log: options.log,
		required_role: role,
		keep_alive_ms: options.keep_alive_ms,
		on_audit_event: (event: AuditLogEvent): void => {
			registry.broadcast(AUDIT_LOG_CHANNEL, { method: event.event_type, params: event });
		},
		registry
	};
};
