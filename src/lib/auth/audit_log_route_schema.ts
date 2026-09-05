/**
 * Hono-free wire schemas + route shape for the audit-log SSE stream.
 *
 * Split from `audit_log_routes.ts` (whose handler pulls `hono/streaming` via
 * `realtime/sse`) so cross-process test suites can build the audit-stream
 * route shape without dragging the in-process SSE handler, and its optional
 * `hono` peer, onto a backend-spawning consumer. `audit_log_routes.ts` imports
 * these back and attaches the live SSE handler; single source of truth for the
 * wire shape.
 *
 * @module
 */

import { z } from 'zod';

import type { RouteSpec } from '../http/route_spec.ts';
import { ActingActor } from '../http/auth_shape.ts';

/** Query schema for the audit-log SSE route — multi-actor admins pass `?acting=<uuid>`. */
export const AuditStreamQuery = z.strictObject({ acting: ActingActor });
export type AuditStreamQuery = z.infer<typeof AuditStreamQuery>;

/** Default role required to access the audit-log SSE route. */
export const DEFAULT_AUDIT_STREAM_ROLE = 'admin';

/**
 * The `GET /audit/stream` SSE route shape minus its handler — pure hono-free
 * data. `create_audit_log_route_specs` spreads this and attaches the live SSE
 * handler; cross-process surface builders spread it with a stub handler. The
 * output is `z.null()` because SSE streams have no JSON response body.
 *
 * @param required_role - role gating the stream (default `DEFAULT_AUDIT_STREAM_ROLE`)
 * @returns the SSE route shape minus its handler
 */
export const create_audit_log_route_shape = (
	required_role: string = DEFAULT_AUDIT_STREAM_ROLE
): Omit<RouteSpec, 'handler'> => ({
	method: 'GET',
	path: '/audit/stream',
	auth: {
		account: 'required',
		actor: 'required',
		roles: [required_role],
		// The stream is a session channel. A bearer that opens one cannot be
		// closed when it is revoked: `token_revoke` closes WS sockets keyed by
		// token, and SSE subscribers are not keyed that way, so a revoked
		// token would keep receiving audit rows for the life of the
		// connection. Gating the channel is what makes
		// `realtime/sse_auth_guard.ts`'s omission of `token_revoke` correct
		// rather than merely asserted.
		credential_types: ['session'],
		// Rule 3 — a narrowed token holds no audit feed. Same reasoning as the
		// WS upgrade: this is a long-lived server→client stream whose contents
		// are decided by the account's role, not by any per-message scope
		// check, so there is no point after open at which a narrowing could
		// apply. Unreachable behind the credential gate above on the default
		// mount, and kept deliberately: it is the rule-3 declaration the
		// surface census matches on, and it still governs a consumer that
		// widens the channel gate.
		required_scope: 'surface:audit_stream'
	},
	description: 'Subscribe to realtime audit log events',
	query: AuditStreamQuery,
	input: z.null(),
	output: z.null() // SSE — no JSON response
});
