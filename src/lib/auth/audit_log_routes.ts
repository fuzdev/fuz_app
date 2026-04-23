/**
 * Audit log admin observability routes that stay REST after Phase 6.
 *
 * The two list-reads (`audit_log_list`, `audit_log_permit_history`) moved to
 * RPC in `admin_actions.ts`. What remains here:
 *
 * - `GET /sessions` — admin session listing (not yet RPC; listing is a plain
 *   read, kept as REST alongside `AdminSessionsState`'s current wiring).
 * - `GET /audit-log/stream` — SSE. Streams aren't an RPC concern.
 *
 * @module
 */

import {z} from 'zod';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import {AdminSessionJson} from './audit_log_schema.js';
import type {RouteSpec} from '../http/route_spec.js';
import {query_session_list_all_active} from './session_queries.js';
import {create_sse_response, type SseStream, type SseNotification} from '../realtime/sse.js';
import type {SubscribeOptions} from '../realtime/subscriber_registry.js';
import {AUTH_SESSION_TOKEN_HASH_KEY, require_request_context} from './request_context.js';

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
		subscribe: (stream: SseStream<SseNotification>, options?: SubscribeOptions) => () => void;
		log: Logger;
	};
}

/**
 * Create audit log and admin observability route specs.
 *
 * @param options - optional options with role override
 * @returns route specs for the admin session listing and (optionally) the SSE stream
 */
export const create_audit_log_route_specs = (options?: AuditLogRouteOptions): Array<RouteSpec> => {
	const role = options?.required_role ?? 'admin';

	const routes: Array<RouteSpec> = [
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
				// scope = session hash (capped → tabs-per-session limit and
				// session-specific `session_revoke` close). groups = [account_id]
				// (uncapped → coarse close on permit_revoke / session_revoke_all
				// / password_change).
				const token_hash = c.get(AUTH_SESSION_TOKEN_HASH_KEY) ?? null;
				const {response, stream} = create_sse_response<SseNotification>(c, log);
				const unsubscribe = subscribe(stream, {
					channels: ['audit_log'],
					scope: token_hash ?? undefined,
					groups: [ctx.account.id],
				});
				stream.on_close(unsubscribe);
				return response;
			},
		});
	}

	return routes;
};
