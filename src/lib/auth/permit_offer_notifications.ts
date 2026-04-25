/**
 * Permit offer WebSocket notification specs, builders, and the narrow
 * `NotificationSender` interface that decouples offer/revoke send sites
 * from `BackendWebsocketTransport`.
 *
 * Six `RemoteNotificationActionSpec`s cover the consentful-permits
 * lifecycle events the server pushes to affected accounts:
 *
 * - `permit_offer_received` → recipient's sockets when an offer is created
 * - `permit_offer_retracted` → recipient's sockets when a grantor retracts
 * - `permit_offer_accepted` → grantor's sockets when the recipient accepts
 * - `permit_offer_declined` → grantor's sockets when the recipient declines
 * - `permit_offer_supersede` → grantor's sockets when a sibling accept,
 *   a revoke of the resulting permit, or destruction of the parent scope
 *   row obsoletes their pending offer
 * - `permit_revoke` → revokee's sockets when one of their active permits
 *   is revoked (companion to the `permit_revoke` audit event)
 *
 * Payloads are flat and normalized — `PermitOfferJson` for the offer-lifecycle
 * notifications (decline reason rides on `offer.decline_reason`, not a
 * sibling field), and `{permit_id, role, scope_id, reason?}` for `permit_revoke`. The
 * revokee/grantor/recipient account id travels via the send target (the
 * `NotificationSender.send_to_account` argument), not in the payload.
 *
 * The specs surface as `EventSpec`s via `create_action_event_spec` — callers
 * append `PERMIT_OFFER_NOTIFICATION_SPECS` to their `event_specs` on
 * `create_app_server` so the surface reflects them and DEV-mode broadcast
 * validation catches payload drift.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid as UuidSchema, type Uuid} from '@fuzdev/fuz_util/id.js';

import type {RemoteNotificationActionSpec} from '../actions/action_spec.js';
import {create_action_event_spec} from '../actions/action_bridge.js';
import type {EventSpec} from '../realtime/sse.js';
import type {JsonrpcNotification} from '../http/jsonrpc.js';
import {create_jsonrpc_notification} from '../http/jsonrpc_helpers.js';
import {RoleName} from './role_schema.js';
import {PermitOfferJson} from './permit_offer_schema.js';
import {PERMIT_REVOKED_REASON_LENGTH_MAX} from './account_schema.js';

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

export const PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD = 'permit_offer_received';
export const PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD = 'permit_offer_retracted';
export const PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD = 'permit_offer_accepted';
export const PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD = 'permit_offer_declined';
export const PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD = 'permit_offer_supersede';
export const PERMIT_REVOKE_NOTIFICATION_METHOD = 'permit_revoke';

// -- Params schemas ---------------------------------------------------------

/** Params for `permit_offer_received` — offer delivered to its recipient. */
export const PermitOfferReceivedParams = z.strictObject({
	offer: PermitOfferJson,
});
export type PermitOfferReceivedParams = z.infer<typeof PermitOfferReceivedParams>;

/** Params for `permit_offer_retracted` — grantor-side retraction. */
export const PermitOfferRetractedParams = z.strictObject({
	offer: PermitOfferJson,
});
export type PermitOfferRetractedParams = z.infer<typeof PermitOfferRetractedParams>;

/** Params for `permit_offer_accepted` — recipient accepted the offer. */
export const PermitOfferAcceptedParams = z.strictObject({
	offer: PermitOfferJson,
});
export type PermitOfferAcceptedParams = z.infer<typeof PermitOfferAcceptedParams>;

/**
 * Params for `permit_offer_declined`. The decline reason (if any) rides along
 * inside `offer.decline_reason` — the DB stamps it on the offer row during
 * decline, so a sibling `reason` field would just duplicate it.
 */
export const PermitOfferDeclinedParams = z.strictObject({
	offer: PermitOfferJson,
});
export type PermitOfferDeclinedParams = z.infer<typeof PermitOfferDeclinedParams>;

/**
 * Params for `permit_offer_supersede`. Fires to the grantor's sockets when
 * their pending offer is obsoleted — either by a sibling accept
 * (`reason: 'sibling_accepted'`), by revoke of the resulting permit
 * (`reason: 'permit_revoked'`), or by deletion of the parent scope row
 * the offer was bound to (`reason: 'scope_destroyed'`). `cause_id` points
 * at the accepted offer id, the revoked permit id, or the destroyed scope
 * row id respectively.
 */
export const PermitOfferSupersedeParams = z.strictObject({
	offer: PermitOfferJson,
	reason: z.enum(['sibling_accepted', 'permit_revoked', 'scope_destroyed']),
	cause_id: UuidSchema,
});
export type PermitOfferSupersedeParams = z.infer<typeof PermitOfferSupersedeParams>;

/**
 * Params for `permit_revoke`. Delivered to the revokee's sockets when one
 * of their active permits is revoked. Flat wire shape — `revoked_by` is
 * admin-UI-visible but deliberately omitted here (the revokee doesn't need
 * to learn the admin's identity). Target account is implicit in the send
 * target.
 */
export const PermitRevokeParams = z.strictObject({
	permit_id: UuidSchema,
	role: RoleName,
	scope_id: UuidSchema.nullable(),
	reason: z.string().max(PERMIT_REVOKED_REASON_LENGTH_MAX).nullable(),
});
export type PermitRevokeParams = z.infer<typeof PermitRevokeParams>;

// -- Action specs -----------------------------------------------------------

export const permit_offer_received_notification_spec = {
	method: PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: PermitOfferReceivedParams,
	output: z.void(),
	async: true,
	description: 'A new permit offer arrived in the recipient’s inbox.',
} satisfies RemoteNotificationActionSpec;

export const permit_offer_retracted_notification_spec = {
	method: PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: PermitOfferRetractedParams,
	output: z.void(),
	async: true,
	description: 'A pending permit offer was retracted by its grantor.',
} satisfies RemoteNotificationActionSpec;

export const permit_offer_accepted_notification_spec = {
	method: PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: PermitOfferAcceptedParams,
	output: z.void(),
	async: true,
	description: 'A pending permit offer was accepted by its recipient.',
} satisfies RemoteNotificationActionSpec;

export const permit_offer_declined_notification_spec = {
	method: PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: PermitOfferDeclinedParams,
	output: z.void(),
	async: true,
	description: 'A pending permit offer was declined by its recipient.',
} satisfies RemoteNotificationActionSpec;

export const permit_offer_supersede_notification_spec = {
	method: PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: PermitOfferSupersedeParams,
	output: z.void(),
	async: true,
	description:
		'A grantor’s pending permit offer was obsoleted by a sibling accept, by revoke of the resulting permit, or by destruction of the parent scope row.',
} satisfies RemoteNotificationActionSpec;

export const permit_revoke_notification_spec = {
	method: PERMIT_REVOKE_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: PermitRevokeParams,
	output: z.void(),
	async: true,
	description: 'An active permit on the revokee’s account was revoked.',
} satisfies RemoteNotificationActionSpec;

// -- EventSpec surface ------------------------------------------------------

/**
 * SSE/WS event specs for the consentful-permits notification surface.
 *
 * Pass to `create_app_server`'s `event_specs` so the attack surface reflects
 * them and DEV-mode `create_validated_broadcaster` catches payload drift.
 */
export const PERMIT_OFFER_NOTIFICATION_SPECS: Array<EventSpec> = [
	create_action_event_spec(permit_offer_received_notification_spec),
	create_action_event_spec(permit_offer_retracted_notification_spec),
	create_action_event_spec(permit_offer_accepted_notification_spec),
	create_action_event_spec(permit_offer_declined_notification_spec),
	create_action_event_spec(permit_offer_supersede_notification_spec),
	create_action_event_spec(permit_revoke_notification_spec),
];

// -- Notification builders --------------------------------------------------

export const build_permit_offer_received_notification = (
	params: PermitOfferReceivedParams,
): JsonrpcNotification =>
	create_jsonrpc_notification(PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD, params);

export const build_permit_offer_retracted_notification = (
	params: PermitOfferRetractedParams,
): JsonrpcNotification =>
	create_jsonrpc_notification(PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD, params);

export const build_permit_offer_accepted_notification = (
	params: PermitOfferAcceptedParams,
): JsonrpcNotification =>
	create_jsonrpc_notification(PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD, params);

export const build_permit_offer_declined_notification = (
	params: PermitOfferDeclinedParams,
): JsonrpcNotification =>
	create_jsonrpc_notification(PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD, params);

export const build_permit_offer_supersede_notification = (
	params: PermitOfferSupersedeParams,
): JsonrpcNotification =>
	create_jsonrpc_notification(PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD, params);

export const build_permit_revoke_notification = (params: PermitRevokeParams): JsonrpcNotification =>
	create_jsonrpc_notification(PERMIT_REVOKE_NOTIFICATION_METHOD, params);
