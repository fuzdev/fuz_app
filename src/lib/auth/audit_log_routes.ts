/**
 * Audit log and admin observability route specs.
 *
 * All routes require admin role by default. Provides audit event listing,
 * permit history shortcut, and active session overview.
 *
 * @module
 */

import {z} from 'zod';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import {
	AuditLogEventWithUsernamesJson,
	AdminSessionJson,
	AuditEventType,
	PermitHistoryEventJson,
} from './audit_log_schema.js';
import type {RouteSpec} from '../http/route_spec.js';
import {
	AUDIT_LOG_DEFAULT_LIMIT,
	query_audit_log_list_with_usernames,
	query_audit_log_list_permit_history,
} from './audit_log_queries.js';
import {query_session_list_all_active} from './session_queries.js';
import {ERROR_INVALID_EVENT_TYPE} from '../http/error_schemas.js';
import {create_sse_response, type SseStream, type SseNotification} from '../realtime/sse.js';
import {require_request_context} from './request_context.js';

// TODO upstream to fuz_util
/** Parse a string to an integer, returning `undefined` for non-numeric input (including `NaN`). */
const parse_int_or_undefined = (value: string): number | undefined => {
	const n = parseInt(value, 10);
	return Number.isFinite(n) ? n : undefined;
};

/** Options for audit log route specs. */
export interface AuditLogRouteOptions {
	/** Role required to access audit routes. Default `'admin'`. */
	required_role?: string;
	/**
	 * When provided, includes an SSE route at `/audit-log/stream` for realtime audit events.
	 * The `subscribe` function receives the stream, channels, and the subscriber's `account_id`
	 * as an identity key — enabling `close_by_identity()` for auth revocation.
	 */
	stream?: {
		subscribe: (
			stream: SseStream<SseNotification>,
			channels?: Array<string>,
			identity?: string,
		) => () => void;
		log: Logger;
	};
}

/**
 * Create audit log and admin observability route specs.
 *
 * @param options - optional options with role override
 * @returns route specs for audit log and admin session management
 */
export const create_audit_log_route_specs = (options?: AuditLogRouteOptions): Array<RouteSpec> => {
	const role = options?.required_role ?? 'admin';

	const routes: Array<RouteSpec> = [
		{
			method: 'GET',
			path: '/audit-log',
			auth: {type: 'role', role},
			description: 'List audit log events with optional filters',
			input: z.null(),
			output: z.strictObject({events: z.array(AuditLogEventWithUsernamesJson)}),
			errors: {400: z.looseObject({error: z.literal(ERROR_INVALID_EVENT_TYPE)})},
			handler: async (c, route) => {
				const raw_event_type = c.req.query('event_type') || undefined;
				if (raw_event_type && !AuditEventType.safeParse(raw_event_type).success) {
					return c.json({error: ERROR_INVALID_EVENT_TYPE}, 400);
				}
				const event_type = raw_event_type as AuditEventType | undefined;
				const account_id = c.req.query('account_id') || undefined;
				const limit = Math.max(
					1,
					Math.min(200, parseInt(c.req.query('limit') ?? '', 10) || AUDIT_LOG_DEFAULT_LIMIT),
				);
				const offset = Math.max(0, parseInt(c.req.query('offset') ?? '', 10) || 0);
				const raw_since_seq = c.req.query('since_seq');
				const since_seq = raw_since_seq != null ? parse_int_or_undefined(raw_since_seq) : undefined;
				const events = await query_audit_log_list_with_usernames(route, {
					event_type,
					account_id,
					limit,
					offset,
					since_seq,
				});
				return c.json({events});
			},
		},
		{
			method: 'GET',
			path: '/audit-log/permit-history',
			auth: {type: 'role', role},
			description: 'List permit grant and revoke events with usernames',
			input: z.null(),
			output: z.strictObject({events: z.array(PermitHistoryEventJson)}),
			handler: async (c, route) => {
				const limit = Math.max(
					1,
					Math.min(200, parseInt(c.req.query('limit') ?? '', 10) || AUDIT_LOG_DEFAULT_LIMIT),
				);
				const offset = Math.max(0, parseInt(c.req.query('offset') ?? '', 10) || 0);
				const events = await query_audit_log_list_permit_history(route, limit, offset);
				return c.json({events});
			},
		},
		{
			method: 'GET',
			path: '/sessions',
			auth: {type: 'role', role},
			description: 'List all active sessions across all accounts',
			input: z.null(),
			output: z.strictObject({sessions: z.array(AdminSessionJson)}),
			handler: async (c, route) => {
				const sessions = await query_session_list_all_active(route);
				return c.json({sessions});
			},
		},
	];

	if (options?.stream) {
		const {subscribe, log} = options.stream;
		routes.push({
			method: 'GET',
			path: '/audit-log/stream',
			auth: {type: 'role', role},
			description: 'Subscribe to realtime audit log events',
			input: z.null(),
			output: z.null(), // SSE — no JSON response
			handler: (c) => {
				const ctx = require_request_context(c);
				const {response, stream} = create_sse_response<SseNotification>(c, log);
				const unsubscribe = subscribe(stream, ['audit_log'], ctx.account.id);
				stream.on_close(unsubscribe);
				return response;
			},
		});
	}

	return routes;
};
