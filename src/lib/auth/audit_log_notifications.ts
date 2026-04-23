/**
 * Audit log event SSE notification spec.
 *
 * The `GET /audit-log/stream` SSE route stays REST (streaming is not an
 * action kind), but the event payload it broadcasts is a declarative
 * `remote_notification` surface item so `generate_app_surface()` reflects
 * it and DEV-mode `create_validated_broadcaster` catches payload drift.
 *
 * Consumers append `AUDIT_LOG_NOTIFICATION_SPECS` to `create_app_server`'s
 * `event_specs` alongside `PERMIT_OFFER_NOTIFICATION_SPECS`.
 *
 * @module
 */

import {z} from 'zod';

import {RemoteNotificationActionSpec} from '../actions/action_spec.js';
import {create_action_event_spec} from '../actions/action_bridge.js';
import type {EventSpec} from '../realtime/sse.js';
import {AuditLogEventJson} from './audit_log_schema.js';

/** SSE channel the audit-log stream route publishes on. */
export const AUDIT_LOG_CHANNEL = 'audit_log';

/** Notification method name delivered on the audit-log SSE channel. */
export const AUDIT_LOG_EVENT_NOTIFICATION_METHOD = 'audit_log_event';

export const audit_log_event_notification_spec = RemoteNotificationActionSpec.parse({
	method: AUDIT_LOG_EVENT_NOTIFICATION_METHOD,
	initiator: 'backend',
	input: AuditLogEventJson,
	output: z.void(),
	description: 'An audit log row was written; broadcast to admin audit-log subscribers.',
});

/**
 * Audit log event specs for the SSE surface.
 *
 * Pass to `create_app_server`'s `event_specs` so the attack surface reflects
 * them and DEV-mode broadcast validation catches payload drift.
 */
export const AUDIT_LOG_NOTIFICATION_SPECS: Array<EventSpec> = [
	create_action_event_spec(audit_log_event_notification_spec, {channel: AUDIT_LOG_CHANNEL}),
];
