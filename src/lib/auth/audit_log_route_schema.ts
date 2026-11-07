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

import { literal, object, type Infer, type Schema } from '@fuzdev/fuz_schema/schema.ts';

import { define_route_shape, type RouteShape } from '../http/route_spec.ts';
import { ActingActor } from '../primitive_schemas.ts';

/**
 * Query schema for the audit-log SSE route, a `@fuzdev/fuz_schema` `object`
 * that refuses unknown keys — multi-actor admins pass `?acting=<uuid>`.
 */
export const AuditStreamQuery = object({ acting: ActingActor });
export type AuditStreamQuery = Infer<typeof AuditStreamQuery>;

/** Default role required to access the audit-log SSE route. */
export const DEFAULT_AUDIT_STREAM_ROLE = 'admin';

/** The audit stream's `auth`: the gates its handler may itself answer as. */
export interface AuditStreamAuth {
	account: 'required';
	actor: 'required';
	roles: ReadonlyArray<string>;
	credential_types: ReadonlyArray<string>;
	required_scope: 'surface:audit_stream';
}

/**
 * The `GET /audit/stream` SSE route shape minus its handler — pure hono-free
 * data. `create_audit_log_route_specs` attaches the live SSE handler to it
 * (`attach_route_handler`); cross-process surface builders attach a stub. The
 * output is `literal(null)` because SSE streams have no JSON response body.
 *
 * @param required_role - role gating the stream (default `DEFAULT_AUDIT_STREAM_ROLE`)
 * @returns the SSE route shape minus its handler
 */
export const create_audit_log_route_shape = (
	required_role: string = DEFAULT_AUDIT_STREAM_ROLE
): RouteShape<[], Schema<null, null, 'literal', null>, AuditStreamAuth, undefined> =>
	define_route_shape({
		method: 'GET',
		path: '/audit/stream',
		auth: {
			account: 'required',
			actor: 'required',
			roles: [required_role],
			// The stream is a session channel: a long-lived, instance-wide admin
			// feed is not handed to a credential channel the deployment never
			// chose. Widening the gate loses no close — the handler registers a
			// bearer's stream under its API token id, and a token revocation closes
			// by that id (`create_sse_connection_closer`, which the handlers and the
			// `token` scope of `create_revocation_guard` both close through) — so
			// widening is a consumer's explicit
			// choice about the channel, not a hole in revocation.
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
		input: literal(null),
		output: literal(null) // SSE — no JSON response
	});
