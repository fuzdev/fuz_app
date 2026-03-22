/**
 * SSE auth guard and convenience factory for audit log SSE.
 *
 * `create_sse_auth_guard` bridges audit events to `SubscriberRegistry.close_by_identity()`,
 * closing SSE streams when a subscriber's access is revoked (role revocation or
 * session invalidation).
 *
 * `create_audit_log_sse` is a convenience factory that combines the registry,
 * guard, and broadcaster — making the secure path the easy path for consumers.
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.js';

import {
	AUDIT_EVENT_TYPES,
	AuditLogEventJson,
	type AuditLogEvent,
} from '../auth/audit_log_schema.js';
import {SubscriberRegistry} from './subscriber_registry.js';
import type {SseStream, SseNotification, SseEventSpec} from './sse.js';

/**
 * Audit event types that trigger SSE stream disconnection.
 *
 * `permit_revoke` requires the revoked role to match the guard's `required_role`.
 * `session_revoke_all` and `password_change` close unconditionally for the target account.
 */
export const DISCONNECT_EVENT_TYPES: ReadonlySet<string> = new Set([
	'permit_revoke', // role revoked — user lost access
	'session_revoke_all', // all sessions invalidated — user should be kicked
	'password_change', // password changed — all sessions revoked implicitly
]);

/**
 * Create an audit event handler that closes SSE streams on auth changes.
 *
 * Closes streams when:
 * - `permit_revoke` fires for the `required_role` targeting a connected subscriber
 * - `session_revoke_all` targets a connected subscriber (consistent invalidation)
 * - `password_change` targets a connected subscriber (sessions revoked implicitly)
 *
 * The registry must use `account_id` as the identity key when subscribing
 * (passed as the third argument to `registry.subscribe()`).
 *
 * @param registry - the subscriber registry to guard
 * @param required_role - the role that grants access to the SSE endpoint
 * @param log - logger for disconnect events
 * @returns an `on_audit_event` callback
 */
export const create_sse_auth_guard = <T>(
	registry: SubscriberRegistry<T>,
	required_role: string,
	log: Logger,
): ((event: AuditLogEvent) => void) => {
	return (event: AuditLogEvent): void => {
		if (!DISCONNECT_EVENT_TYPES.has(event.event_type)) return;

		// permit_revoke requires matching the specific role
		if (event.event_type === 'permit_revoke') {
			if (event.metadata?.role !== required_role) return;
		}

		// resolve the affected account — admin actions set target_account_id,
		// self-service actions (password_change, own session_revoke_all) only set account_id
		const target = event.target_account_id ?? event.account_id;
		if (!target) return;

		const closed = registry.close_by_identity(target);
		if (closed > 0) {
			log.info(
				`SSE auth guard: closed ${closed} stream(s) for account ${target} (${event.event_type})`,
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
	/** Subscribe function — pass as part of `stream` option to `create_audit_log_route_specs`. */
	subscribe: (
		stream: SseStream<SseNotification>,
		channels?: Array<string>,
		identity?: string,
	) => () => void;
	/** Logger — pass as part of `stream` option to `create_audit_log_route_specs`. */
	log: Logger;
	/** Combined broadcast + guard callback. Pass as `on_audit_event` on `CreateAppBackendOptions`. */
	on_audit_event: (event: AuditLogEvent) => void;
	/** The underlying registry — exposed for subscriber count monitoring. */
	registry: SubscriberRegistry<SseNotification>;
}

/**
 * Create a complete audit log SSE setup with broadcasting and auth guard.
 *
 * Combines `SubscriberRegistry`, `create_sse_auth_guard`, and the broadcast
 * call into a single object. The result satisfies `AuditLogRouteOptions['stream']`
 * and provides the `on_audit_event` callback for `CreateAppBackendOptions`.
 *
 * @example
 * ```ts
 * const audit_sse = create_audit_log_sse({log});
 *
 * // In create_app_backend options:
 * on_audit_event: audit_sse.on_audit_event,
 *
 * // In create_route_specs:
 * create_audit_log_route_specs({stream: audit_sse});
 *
 * // In create_app_server options:
 * event_specs: AUDIT_LOG_EVENT_SPECS,
 * ```
 *
 * @param options - factory options
 * @returns audit log SSE setup (stream options + on_audit_event + registry)
 */
/**
 * SSE event specs for audit log events.
 *
 * One spec per `AUDIT_EVENT_TYPES` entry, all sharing the `AuditLogEventJson` params schema.
 * Pass to `create_app_server`'s `event_specs` for surface generation and DEV validation.
 */
export const AUDIT_LOG_EVENT_SPECS: Array<SseEventSpec> = AUDIT_EVENT_TYPES.map(
	(event_type): SseEventSpec => ({
		method: event_type,
		params: AuditLogEventJson,
		description: `Audit log: ${event_type.replaceAll('_', ' ')}`,
		channel: 'audit_log',
	}),
);

export const create_audit_log_sse = (options: {
	/** Role required to access the SSE endpoint. Default `'admin'`. */
	role?: string;
	log: Logger;
}): AuditLogSse => {
	const role = options.role ?? 'admin';
	const registry = new SubscriberRegistry<SseNotification>();
	const guard = create_sse_auth_guard(registry, role, options.log);

	return {
		subscribe: registry.subscribe.bind(registry),
		log: options.log,
		on_audit_event: (event: AuditLogEvent): void => {
			registry.broadcast('audit_log', {method: event.event_type, params: event});
			guard(event);
		},
		registry,
	};
};
