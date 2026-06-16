/**
 * Role grant offer WebSocket notification specs, builders, and the narrow
 * `NotificationSender` interface that decouples offer/revoke send sites
 * from `BackendWebsocketTransport`.
 *
 * Six `RemoteNotificationActionSpec`s cover the consentful-role-grants
 * lifecycle events the server pushes to affected accounts:
 *
 * - `role_grant_offer_received` → recipient's sockets when an offer is created
 * - `role_grant_offer_retracted` → recipient's sockets when a grantor retracts
 * - `role_grant_offer_accepted` → grantor's sockets when the recipient accepts
 * - `role_grant_offer_declined` → grantor's sockets when the recipient declines
 * - `role_grant_offer_supersede` → grantor's sockets when a sibling accept,
 *   a revoke of the resulting role_grant, or destruction of the parent scope
 *   row obsoletes their pending offer
 * - `role_grant_revoke` → revokee's sockets when one of their active role_grants
 *   is revoked (companion to the `role_grant_revoke` audit event)
 *
 * Payloads are flat and normalized — `RoleGrantOfferJson` for the offer-lifecycle
 * notifications (decline reason rides on `offer.decline_reason`, not a
 * sibling field), and `{role_grant_id, role, scope_id, reason?}` for `role_grant_revoke`. The
 * revokee/grantor/recipient account id travels via the send target (the
 * `NotificationSender.send_to_account` argument), not in the payload.
 *
 * The specs surface as `EventSpec`s via `create_action_event_spec` — callers
 * append `role_grant_offer_notification_specs` to their `event_specs` on
 * `create_app_server` so the surface reflects them and DEV-mode broadcast
 * validation catches payload drift.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid as UuidSchema, type Uuid} from '@fuzdev/fuz_util/id.ts';

import type {RemoteNotificationActionSpec} from '../actions/action_spec.ts';
import {create_action_event_spec} from '../actions/action_bridge.ts';
import type {EventSpec} from '../realtime/sse.ts';
import type {JsonrpcNotification} from '../http/jsonrpc.ts';
import {create_jsonrpc_notification} from '../http/jsonrpc_helpers.ts';
import {RoleName} from './role_schema.ts';
import {RoleGrantOfferJson} from './role_grant_offer_schema.ts';
import {ROLE_GRANT_REVOKED_REASON_LENGTH_MAX} from './account_schema.ts';

/**
 * Narrow structural capability for sending a JSON-RPC notification to every
 * socket bound to an account.
 *
 * `BackendWebsocketTransport` satisfies this interface — its
 * `send_to_account(account_id, message)` signature accepts the broader
 * `JsonrpcMessageFromServerToClient` type, which is contravariantly
 * compatible with `JsonrpcNotification` here. The interface stays local so
 * handlers don't couple to the concrete transport, and tests can inject a
 * capturing stub with no WS machinery.
 *
 * Returns the number of sockets the notification was sent to — callers
 * typically ignore it (used by telemetry / tests).
 */
export interface NotificationSender {
	send_to_account: (account_id: Uuid, message: JsonrpcNotification) => number;
}

// -- Method constants -------------------------------------------------------

export const ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD = 'role_grant_offer_received';
export const ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD = 'role_grant_offer_retracted';
export const ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD = 'role_grant_offer_accepted';
export const ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD = 'role_grant_offer_declined';
export const ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD = 'role_grant_offer_supersede';
export const ROLE_GRANT_REVOKE_NOTIFICATION_METHOD = 'role_grant_revoke';

// -- Params schemas ---------------------------------------------------------

/** Params for `role_grant_offer_received` — offer delivered to its recipient. */
export const RoleGrantOfferReceivedParams = z.strictObject({
	offer: RoleGrantOfferJson,
});
export type RoleGrantOfferReceivedParams = z.infer<typeof RoleGrantOfferReceivedParams>;

/** Params for `role_grant_offer_retracted` — grantor-side retraction. */
export const RoleGrantOfferRetractedParams = z.strictObject({
	offer: RoleGrantOfferJson,
});
export type RoleGrantOfferRetractedParams = z.infer<typeof RoleGrantOfferRetractedParams>;

/** Params for `role_grant_offer_accepted` — recipient accepted the offer. */
export const RoleGrantOfferAcceptedParams = z.strictObject({
	offer: RoleGrantOfferJson,
});
export type RoleGrantOfferAcceptedParams = z.infer<typeof RoleGrantOfferAcceptedParams>;

/**
 * Params for `role_grant_offer_declined`. The decline reason (if any) rides along
 * inside `offer.decline_reason` — the DB stamps it on the offer row during
 * decline, so a sibling `reason` field would just duplicate it.
 */
export const RoleGrantOfferDeclinedParams = z.strictObject({
	offer: RoleGrantOfferJson,
});
export type RoleGrantOfferDeclinedParams = z.infer<typeof RoleGrantOfferDeclinedParams>;

/**
 * Params for `role_grant_offer_supersede`. Fires to the grantor's sockets when
 * their pending offer is obsoleted — either by a sibling accept
 * (`reason: 'sibling_accepted'`), by revoke of the resulting role_grant
 * (`reason: 'role_grant_revoked'`), or by deletion of the parent scope row
 * the offer was bound to (`reason: 'scope_destroyed'`). `cause_id` points
 * at the accepted offer id, the revoked role_grant id, or the destroyed scope
 * row id respectively.
 */
export const RoleGrantOfferSupersedeParams = z.strictObject({
	offer: RoleGrantOfferJson,
	reason: z.enum(['sibling_accepted', 'role_grant_revoked', 'scope_destroyed']),
	cause_id: UuidSchema,
});
export type RoleGrantOfferSupersedeParams = z.infer<typeof RoleGrantOfferSupersedeParams>;

/**
 * Params for `role_grant_revoke`. Delivered to the revokee's sockets when one
 * of their active role_grants is revoked. Flat wire shape — `revoked_by` is
 * admin-UI-visible but deliberately omitted here (the revokee doesn't need
 * to learn the admin's identity). Target account is implicit in the send
 * target.
 */
export const RoleGrantRevokeParams = z.strictObject({
	role_grant_id: UuidSchema,
	role: RoleName,
	scope_id: UuidSchema.nullable(),
	reason: z.string().max(ROLE_GRANT_REVOKED_REASON_LENGTH_MAX).nullable(),
});
export type RoleGrantRevokeParams = z.infer<typeof RoleGrantRevokeParams>;

// -- Action specs -----------------------------------------------------------

export const role_grant_offer_received_notification_spec = {
	method: ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantOfferReceivedParams,
	output: z.void(),
	async: true,
	description: 'A new role_grant offer arrived in the recipient’s inbox.',
} satisfies RemoteNotificationActionSpec;

export const role_grant_offer_retracted_notification_spec = {
	method: ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantOfferRetractedParams,
	output: z.void(),
	async: true,
	description: 'A pending role_grant offer was retracted by its grantor.',
} satisfies RemoteNotificationActionSpec;

export const role_grant_offer_accepted_notification_spec = {
	method: ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantOfferAcceptedParams,
	output: z.void(),
	async: true,
	description: 'A pending role_grant offer was accepted by its recipient.',
} satisfies RemoteNotificationActionSpec;

export const role_grant_offer_declined_notification_spec = {
	method: ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantOfferDeclinedParams,
	output: z.void(),
	async: true,
	description: 'A pending role_grant offer was declined by its recipient.',
} satisfies RemoteNotificationActionSpec;

export const role_grant_offer_supersede_notification_spec = {
	method: ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantOfferSupersedeParams,
	output: z.void(),
	async: true,
	description:
		'A grantor’s pending role_grant offer was obsoleted by a sibling accept, by revoke of the resulting role_grant, or by destruction of the parent scope row.',
} satisfies RemoteNotificationActionSpec;

export const role_grant_revoke_notification_spec = {
	method: ROLE_GRANT_REVOKE_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantRevokeParams,
	output: z.void(),
	async: true,
	description: 'An active role_grant on the revokee’s account was revoked.',
} satisfies RemoteNotificationActionSpec;

// -- EventSpec surface ------------------------------------------------------

/**
 * SSE/WS event specs for the consentful-role-grants notification surface.
 *
 * Pass to `create_app_server`'s `event_specs` so the attack surface reflects
 * them and DEV-mode `create_validated_broadcaster` catches payload drift.
 */
export const role_grant_offer_notification_specs: Array<EventSpec> = [
	create_action_event_spec(role_grant_offer_received_notification_spec),
	create_action_event_spec(role_grant_offer_retracted_notification_spec),
	create_action_event_spec(role_grant_offer_accepted_notification_spec),
	create_action_event_spec(role_grant_offer_declined_notification_spec),
	create_action_event_spec(role_grant_offer_supersede_notification_spec),
	create_action_event_spec(role_grant_revoke_notification_spec),
];

// -- Notification builders --------------------------------------------------

export const build_role_grant_offer_received_notification = (
	params: RoleGrantOfferReceivedParams,
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD, params);

export const build_role_grant_offer_retracted_notification = (
	params: RoleGrantOfferRetractedParams,
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD, params);

export const build_role_grant_offer_accepted_notification = (
	params: RoleGrantOfferAcceptedParams,
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD, params);

export const build_role_grant_offer_declined_notification = (
	params: RoleGrantOfferDeclinedParams,
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD, params);

export const build_role_grant_offer_supersede_notification = (
	params: RoleGrantOfferSupersedeParams,
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD, params);

export const build_role_grant_revoke_notification = (
	params: RoleGrantRevokeParams,
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_REVOKE_NOTIFICATION_METHOD, params);
