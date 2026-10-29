/**
 * Audit log SSE stream route.
 *
 * The two list-reads (`audit_log_list`, `audit_log_role_grant_history`) moved to
 * RPC in `auth/admin_actions.ts`, and the admin session listing moved to
 * `admin_session_list` on the same file. What remains here is the optional
 * `GET /audit/stream` SSE route — streams aren't an action-kind, so they
 * stay on REST. The event payload broadcast on the stream surfaces via
 * `audit_log_event_specs` (one `EventSpec` per audit event type) declared
 * alongside the broadcaster in `realtime/audit_log_sse.ts`.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { UnreachableError } from '@fuzdev/fuz_util/error.ts';

import type { RouteSpec } from '../http/route_spec.ts';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS
} from '../http/error_schemas.ts';
import { TEST_CONTEXT_PRESET_KEY } from '../hono_context.ts';
import {
	create_audit_log_route_shape,
	DEFAULT_AUDIT_STREAM_ROLE
} from './audit_log_route_schema.ts';
import { create_sse_response, type SseNotification } from '../realtime/sse.ts';
import { validate_sse_keep_alive_ms } from '../realtime/sse_constants.ts';
import type { SseRegistry } from '../realtime/sse_registry.ts';
import { require_request_context } from './request_context.ts';
import {
	get_resolved_auth,
	recheck_admission,
	resolved_auth_api_token_id,
	resolved_auth_session_hash
} from './resolved_auth.ts';
import { schedule_credential_deadline } from './credential_deadline.ts';
import { AUDIT_LOG_CHANNEL } from '../realtime/audit_log_sse.ts';

/** Options for audit log route specs. */
export interface AuditLogRouteOptions {
	/** Role required to access audit routes. Default `'admin'`. */
	required_role?: string;
	/**
	 * When provided, includes an SSE route at `/audit/stream` for realtime audit
	 * events. The route registers each stream on `registry` under the
	 * subscriber's session hash (`scope`) and account id (`groups`, with the
	 * API token id beside it for a bearer) — the keys `close_by_identity()`
	 * closes on for auth revocation. An `AuditLogSse`
	 * (`create_audit_log_sse`, or `AppServerContext.audit_sse`) satisfies it.
	 */
	stream?: {
		registry: SseRegistry<SseNotification>;
		log: Logger;
		/**
		 * Each stream's keep-alive interval (`SseResponseOptions.keep_alive_ms`)
		 * — a test server shortens it. Validated here, at route creation.
		 *
		 * @default SSE_KEEP_ALIVE_INTERVAL_MS
		 */
		keep_alive_ms?: number | null;
	};
}

/**
 * Create the optional audit-log SSE route spec.
 *
 * Returns an empty array when `options.stream` is not set — no REST routes
 * live here apart from the stream.
 *
 * ## Admission
 *
 * A stream is authorized once, so the handler must not open one on a
 * credential or role revoked while the request was in flight. The route's
 * gates (401, credential channel, token scope, acting actor, role) run in the
 * route-spec pipeline, before the handler and so before any stream is
 * registered — a revocation landing after them would close nothing. So the
 * handler registers the stream **pending**
 * (`SseRegistry.subscribe_pending`), then re-reads the credential, the
 * acting actor, and its role grants (`recheck_admission`, which the WebSocket
 * upgrade shares), and only then admits (`SseRegistry.admit`). A
 * revocation that committed before those reads is seen by them —
 * `401 authentication_required` for a dead credential or an acting actor
 * deleted since the gates ran, `403 insufficient_permissions` for a lost
 * role — and one whose
 * close ran after the registration found the pending entry: admission then
 * fails, and the response is a `200` whose body is the connect comment and
 * nothing else — to an `EventSource`, a stream closed an instant after it
 * opened (the client's reconnect is answered by the gates, with the precise
 * status). A pending registration receives no audit row, counts toward no cap,
 * and is removed when a re-read refuses the request. Once the server is
 * shutting down (`SseRegistry` class doc, "Shutdown") the registration
 * is born closed, the re-reads are skipped, and the answer is that same
 * connect comment alone — as it is when the shutdown closes a registration
 * whose re-read is in flight, even if the re-read then fails. The twin of the
 * Rust spine's `audit_stream_router`, which runs the same order through its
 * `recheck_admission`.
 *
 * ## Credential deadline
 *
 * Expiry writes nothing a revocation listener could hear, so an admitted
 * stream watches its own credential's expiry
 * (`ResolvedAuth.credential_deadline` — for the session-only stock route, the
 * earlier of the cookie's and the row's) and is closed at it, as a revoked
 * stream is: the body ends with no final frame, and the client's reconnect
 * meets the gates. The wait is `schedule_credential_deadline`'s chain of
 * bounded timers, cancelled when the stream closes.
 *
 * @param options - optional stream wiring + role override
 * @returns the SSE route spec (when `options.stream` is provided) or an empty array
 */
export const create_audit_log_route_specs = (options?: AuditLogRouteOptions): Array<RouteSpec> => {
	if (!options?.stream) return [];

	const { registry, log, keep_alive_ms } = options.stream;
	validate_sse_keep_alive_ms(keep_alive_ms);
	const required_role = options.required_role ?? DEFAULT_AUDIT_STREAM_ROLE;
	return [
		{
			...create_audit_log_route_shape(required_role),
			handler: async (c, route) => {
				// Rule 3 is declared on the route shape's `auth.required_scope`,
				// so a narrowed token is refused ahead of the role gate rather
				// than here.
				const ctx = require_request_context(c);
				// scope = session hash (capped → tabs-per-session limit and
				// session-specific `session_revoke` close). groups = [account_id]
				// (uncapped → coarse close on role_grant_revoke / session_revoke_all
				// / password_change / account delete). The route shape admits
				// sessions only, so `api_token_id` is null here; it is registered
				// when present so that a consumer widening the credential gate
				// still has a revoked token's stream closed by `token_revoke`.
				// Both come off the resolved credential, which carries each only
				// for its own credential type.
				const resolved = get_resolved_auth(c);
				const session_hash = resolved_auth_session_hash(resolved);
				const api_token_id = resolved_auth_api_token_id(resolved);

				// Register pending first: from here every revocation finds the
				// stream (TSDoc, "Admission").
				const pending = registry.subscribe_pending({
					channels: [AUDIT_LOG_CHANNEL],
					scope: session_hash ?? undefined,
					groups: api_token_id === null ? [ctx.account.id] : [ctx.account.id, api_token_id]
				});
				// The pending registration is released on every path that does not
				// admit it — a refusal, a failed re-read, a throw while building the
				// response — so none of them can leak an entry nothing delivers to.
				let admitted = false;
				try {
					// Re-read what the gates read, now that the stream is registered:
					// a revocation that closed before the registration is committed,
					// so these see it. A throw here fails closed — no stream opens
					// unchecked. Skipped under the test-preset escape hatch, whose
					// pre-baked context has no rows behind it to re-read, and for a
					// registration born closed by the shutdown, which admission
					// refuses whatever they answer.
					if (!c.get(TEST_CONTEXT_PRESET_KEY) && !registry.closing) {
						const reread = async (): Promise<Response | null> => {
							// Global grants only, like the `require_role` gate that ran in
							// the pipeline — a scoped grant must not open the instance-wide
							// stream.
							const recheck =
								resolved === null
									? 'credential_revoked'
									: await recheck_admission(route, {
											resolved,
											request_context: ctx,
											required_roles: [required_role]
										});
							switch (recheck) {
								case 'admitted':
									return null;
								case 'credential_revoked':
									log.info('audit stream: credential revoked during the request', ctx.account.id);
									return c.json({ error: ERROR_AUTHENTICATION_REQUIRED }, 401);
								case 'actor_inactive':
									log.info('audit stream: acting actor deleted during the request', ctx.account.id);
									return c.json({ error: ERROR_AUTHENTICATION_REQUIRED }, 401);
								case 'role_revoked':
									log.info('audit stream: role revoked during the request', ctx.account.id);
									return c.json(
										{ error: ERROR_INSUFFICIENT_PERMISSIONS, required_roles: [required_role] },
										403
									);
								default:
									throw new UnreachableError(recheck);
							}
						};
						const refusal = await reread().catch((error: unknown) => {
							// the shutdown closed the registration and then the database
							// under the re-read: the answer is the shutdown's — admission
							// below refuses, since a closing registry admits nothing —
							// not a failure
							if (registry.closing) {
								log.info('audit stream: re-read ended by the shutdown', ctx.account.id, error);
								return null;
							}
							throw error;
						});
						if (refusal) return refusal;
					}

					// Admit — the cap's eviction happens here, after every gate. A
					// registration a revocation or the shutdown closed while it was
					// pending, or one born closed, is not admitted: the stream is
					// closed at once, so the body is the
					// connect comment and nothing else, and the client reconnects
					// into the gates. The close listener goes on first: a client that
					// left during the re-reads gets a stream that is already closed,
					// whose listener runs at once and removes the registration, so
					// `admit` refuses it rather than evicting a live stream for it.
					const { response, stream } = create_sse_response<SseNotification>(c, log, {
						account_id: ctx.account.id,
						keep_alive_ms
					});
					stream.on_close(pending.unsubscribe);
					admitted = registry.admit(pending, stream);
					if (!admitted) {
						log.info('audit stream: closed before admission', ctx.account.id);
						stream.close();
					} else {
						// The stream ends when the credential it opened on expires —
						// closed as a revocation closes it (TSDoc, "Credential
						// deadline").
						stream.on_close(
							schedule_credential_deadline(
								get_resolved_auth(c)?.credential_deadline ?? null,
								() => {
									log.info('audit stream: credential expired', ctx.account.id);
									stream.close();
								}
							)
						);
					}
					return response;
				} finally {
					if (!admitted) pending.unsubscribe();
				}
			}
		}
	];
};
