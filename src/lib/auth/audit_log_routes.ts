/**
 * Audit log SSE stream route.
 *
 * The two list-reads (`audit_log_list`, `audit_log_role_grant_history`) moved to
 * RPC in `auth/admin_actions.ts`, and the admin session listing moved to
 * `admin_session_list` on the same file. What remains here is the optional
 * `GET /audit/stream` SSE route — streams aren't an action-kind, so they
 * stay on REST. The event payload broadcast on the stream surfaces via
 * `audit_log_event_specs` (one `EventSpec` per audit event type) declared
 * alongside the broadcaster in `realtime/sse_auth_guard.ts`.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { RouteSpec } from '../http/route_spec.ts';
import { create_audit_log_route_shape } from './audit_log_route_schema.ts';
import { create_sse_response, type SseStream, type SseNotification } from '../realtime/sse.ts';
import type { SubscribeOptions } from '../realtime/subscriber_registry.ts';
import { AUTH_SESSION_TOKEN_HASH_KEY, require_request_context } from './request_context.ts';
import { AUDIT_LOG_CHANNEL } from '../realtime/sse_auth_guard.ts';

/** Options for audit log route specs. */
export interface AuditLogRouteOptions {
	/** Role required to access audit routes. Default `'admin'`. */
	required_role?: string;
	/**
	 * When provided, includes an SSE route at `/audit/stream` for realtime audit events.
	 * The `subscribe` function receives the stream, channels, and the subscriber's `account_id`
	 * as an identity key — enabling `close_by_identity()` for auth revocation.
	 */
	stream?: {
		subscribe: (stream: SseStream<SseNotification>, options?: SubscribeOptions) => () => void;
		log: Logger;
	};
}

/**
 * Create the optional audit-log SSE route spec.
 *
 * Returns an empty array when `options.stream` is not set — no REST routes
 * live here apart from the stream.
 *
 * @param options - optional stream wiring + role override
 * @returns the SSE route spec (when `options.stream` is provided) or an empty array
 */
export const create_audit_log_route_specs = (options?: AuditLogRouteOptions): Array<RouteSpec> => {
	if (!options?.stream) return [];

	const { subscribe, log } = options.stream;
	return [
		{
			...create_audit_log_route_shape(options.required_role),
			handler: (c) => {
				const ctx = require_request_context(c);
				// scope = session hash (capped → tabs-per-session limit and
				// session-specific `session_revoke` close). groups = [account_id]
				// (uncapped → coarse close on role_grant_revoke / session_revoke_all
				// / password_change).
				const token_hash = c.get(AUTH_SESSION_TOKEN_HASH_KEY) ?? null;
				const { response, stream } = create_sse_response<SseNotification>(c, log);
				const unsubscribe = subscribe(stream, {
					channels: [AUDIT_LOG_CHANNEL],
					scope: token_hash ?? undefined,
					groups: [ctx.account.id]
				});
				stream.on_close(unsubscribe);
				return response;
			}
		}
	];
};
