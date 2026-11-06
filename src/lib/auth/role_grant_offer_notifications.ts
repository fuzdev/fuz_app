/**
 * Role grant offer WebSocket notification specs, builders, and the narrow
 * `NotificationSender` interface that decouples offer/revoke send sites
 * from `ConnectionRegistry`.
 *
 * These `RemoteNotificationActionSpec`s cover the consentful-role-grants
 * lifecycle events the server pushes to affected accounts:
 *
 * - `role_grant_offer_received` → recipient's sockets when an offer is created
 * - `role_grant_offer_retracted` → recipient's sockets when a grantor retracts
 * - `role_grant_offer_accepted` → grantor's sockets when the recipient accepts
 * - `role_grant_offer_declined` → grantor's sockets when the recipient declines
 * - `role_grant_offer_supersede` → grantor's sockets when a sibling accept,
 *   a revoke of the resulting role_grant, or destruction of the parent scope
 *   row obsoletes their pending offer
 * - `role_grant_revoked` → revokee's sockets when one of their active
 *   role_grants is revoked by the `role_grant_revoke` action (companion to the
 *   `role_grant_revoke` audit event)
 *
 * Payloads are flat and normalized — `RoleGrantOfferJson` for the offer-lifecycle
 * notifications (decline reason rides on `offer.decline_reason`, not a
 * sibling field), and `{role_grant_id, role, scope_kind, scope_id, reason}`
 * for `role_grant_revoked`. The revokee/grantor/recipient account id travels
 * via the send target (the `NotificationSender.send_to_account` argument),
 * not in the payload. The params schemas are `@fuzdev/fuz_schema` schemas.
 *
 * `role_grant_offer_notification_actions` holds the specs as handler-less
 * actions. `to_ws_actions` (`actions/protocol.ts`) appends them to the WS
 * action set of an RPC list that carries the role_grant_offer actions, so the
 * surface lists them on the WS endpoint as `remote_notification` methods. An
 * inbound frame for one is still answered `method_not_found`, as no handler is
 * registered. Under DEV,
 * `create_role_grant_offer_actions` checks each params object it sends
 * against its spec's `input` (`create_validated_notification_sender`);
 * production sends unchecked.
 *
 * @module
 */

import { DEV } from 'esm-env';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import {
	nullable,
	object,
	one_of,
	void as fuz_void,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import type { Uuid } from '../primitive_schemas.ts';
import { Uuid as UuidSchema, bounded_string } from '../primitive_schemas_fuz.ts';
import type { RemoteNotificationActionSpec } from '../actions/action_spec.ts';
import type { Action } from '../actions/action_types.ts';
import { create_action_event_spec } from '../actions/action_bridge.ts';
import type { EventSpec } from '../realtime/sse.ts';
import type { JsonrpcNotification } from '../http/jsonrpc.ts';
import { create_jsonrpc_notification } from '../http/jsonrpc_helpers.ts';
import { parse_any } from '../schema_issues.ts';
import { RoleName } from './role_schema.ts';
import { ScopeKindName } from './scope_kind_schema.ts';
import { RoleGrantOfferJson } from './role_grant_offer_schema.ts';
import { ROLE_GRANT_REVOKED_REASON_LENGTH_MAX } from './account_schema.ts';

/**
 * Narrow structural capability for sending a JSON-RPC notification to every
 * socket bound to an account.
 *
 * `ConnectionRegistry` satisfies this interface — its
 * `send_to_account(account_id, message)` signature accepts the broader
 * `JsonrpcMessageFromServerToClient` type, which is contravariantly
 * compatible with `JsonrpcNotification` here. The interface stays local so
 * handlers don't couple to the concrete registry, and tests can inject a
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
export const ROLE_GRANT_REVOKED_NOTIFICATION_METHOD = 'role_grant_revoked';

// -- Params schemas ---------------------------------------------------------

/** Params for `role_grant_offer_received` — offer delivered to its recipient. */
export const RoleGrantOfferReceivedParams = object({
	offer: RoleGrantOfferJson
});
export type RoleGrantOfferReceivedParams = Infer<typeof RoleGrantOfferReceivedParams>;

/** Params for `role_grant_offer_retracted` — grantor-side retraction. */
export const RoleGrantOfferRetractedParams = object({
	offer: RoleGrantOfferJson
});
export type RoleGrantOfferRetractedParams = Infer<typeof RoleGrantOfferRetractedParams>;

/** Params for `role_grant_offer_accepted` — recipient accepted the offer. */
export const RoleGrantOfferAcceptedParams = object({
	offer: RoleGrantOfferJson
});
export type RoleGrantOfferAcceptedParams = Infer<typeof RoleGrantOfferAcceptedParams>;

/**
 * Params for `role_grant_offer_declined`. The decline reason (if any) rides along
 * inside `offer.decline_reason` — the DB stamps it on the offer row during
 * decline, so a sibling `reason` field would just duplicate it.
 */
export const RoleGrantOfferDeclinedParams = object({
	offer: RoleGrantOfferJson
});
export type RoleGrantOfferDeclinedParams = Infer<typeof RoleGrantOfferDeclinedParams>;

/**
 * Params for `role_grant_offer_supersede`. Fires to the grantor's sockets when
 * their pending offer is obsoleted — either by a sibling accept
 * (`reason: 'sibling_accepted'`), by revoke of the resulting role_grant or of
 * one of the grantor's own (`reason: 'role_grant_revoked'`), or by deletion of
 * the parent scope row
 * the offer was bound to (`reason: 'scope_destroyed'`). `cause_id` points
 * at the accepted offer id, the revoked role_grant id, or the destroyed scope
 * row id respectively.
 */
export const RoleGrantOfferSupersedeParams = object({
	offer: RoleGrantOfferJson,
	reason: one_of(['sibling_accepted', 'role_grant_revoked', 'scope_destroyed']),
	cause_id: UuidSchema
});
export type RoleGrantOfferSupersedeParams = Infer<typeof RoleGrantOfferSupersedeParams>;

/**
 * Params for `role_grant_revoked`. Delivered to the revokee's sockets when one
 * of their active role_grants is revoked. Flat wire shape — `revoked_by` is
 * admin-UI-visible but deliberately omitted here (the revokee doesn't need
 * to learn the admin's identity). Target account is implicit in the send
 * target. `scope_kind` and `scope_id` are the revoked grant's pair, both
 * `null` for a global grant; both keys are required.
 */
export const RoleGrantRevokedParams = object({
	role_grant_id: UuidSchema,
	role: RoleName,
	scope_kind: nullable(ScopeKindName),
	scope_id: nullable(UuidSchema),
	reason: nullable(bounded_string({ max: ROLE_GRANT_REVOKED_REASON_LENGTH_MAX }))
});
export type RoleGrantRevokedParams = Infer<typeof RoleGrantRevokedParams>;

// -- Action specs -----------------------------------------------------------

export const role_grant_offer_received_notification_spec = {
	method: ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantOfferReceivedParams,
	output: fuz_void,
	async: true,
	description: 'A new role_grant offer arrived in the recipient’s inbox.'
} satisfies RemoteNotificationActionSpec;

export const role_grant_offer_retracted_notification_spec = {
	method: ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantOfferRetractedParams,
	output: fuz_void,
	async: true,
	description: 'A pending role_grant offer was retracted by its grantor.'
} satisfies RemoteNotificationActionSpec;

export const role_grant_offer_accepted_notification_spec = {
	method: ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantOfferAcceptedParams,
	output: fuz_void,
	async: true,
	description: 'A pending role_grant offer was accepted by its recipient.'
} satisfies RemoteNotificationActionSpec;

export const role_grant_offer_declined_notification_spec = {
	method: ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantOfferDeclinedParams,
	output: fuz_void,
	async: true,
	description: 'A pending role_grant offer was declined by its recipient.'
} satisfies RemoteNotificationActionSpec;

export const role_grant_offer_supersede_notification_spec = {
	method: ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantOfferSupersedeParams,
	output: fuz_void,
	async: true,
	description:
		'A grantor’s pending role_grant offer was obsoleted by a sibling accept, by revoke of the resulting role_grant, or by destruction of the parent scope row.'
} satisfies RemoteNotificationActionSpec;

export const role_grant_revoked_notification_spec = {
	method: ROLE_GRANT_REVOKED_NOTIFICATION_METHOD,
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: RoleGrantRevokedParams,
	output: fuz_void,
	async: true,
	description: 'An active role_grant on the revokee’s account was revoked.'
} satisfies RemoteNotificationActionSpec;

// -- Registries ------------------------------------------------------------

/** The role_grant_offer notification specs, in the order of their builders. */
const role_grant_offer_notification_action_specs: ReadonlyArray<RemoteNotificationActionSpec> = [
	role_grant_offer_received_notification_spec,
	role_grant_offer_retracted_notification_spec,
	role_grant_offer_accepted_notification_spec,
	role_grant_offer_declined_notification_spec,
	role_grant_offer_supersede_notification_spec,
	role_grant_revoked_notification_spec
];

/**
 * The role_grant_offer notifications as handler-less actions, for a WS action
 * set: `to_ws_actions` (`actions/protocol.ts`) appends them when the RPC list
 * carries the role_grant_offer actions, so the WS endpoint's surface lists
 * them as `remote_notification` methods. With no handler they never reach
 * dispatch, so an inbound frame for one is answered `method_not_found`.
 */
export const role_grant_offer_notification_actions: ReadonlyArray<Action> =
	role_grant_offer_notification_action_specs.map((spec) => ({ spec }));

/**
 * The role_grant_offer notifications as `EventSpec`s, derived through
 * `create_action_event_spec`. The notifications go to an account's WS sockets
 * through `NotificationSender`, never over SSE, and the WS surface lists them
 * through `role_grant_offer_notification_actions`; these are for a consumer
 * that wants them as event specs, as to broadcast them on an SSE channel of
 * its own.
 */
export const role_grant_offer_notification_specs: Array<EventSpec> =
	role_grant_offer_notification_action_specs.map((spec) => create_action_event_spec(spec));

const notification_spec_by_method: ReadonlyMap<string, RemoteNotificationActionSpec> = new Map(
	role_grant_offer_notification_action_specs.map((spec) => [spec.method, spec])
);

/**
 * Wrap a `NotificationSender` so that under DEV each role_grant_offer
 * notification it sends has its params checked against its spec's `input`,
 * a mismatch logged as an error the way DEV output validation logs one; the
 * notification is sent either way, unchanged. A method that is no
 * role_grant_offer notification passes unchecked. In production the sender is
 * returned as it is.
 *
 * @param sender - the sender to wrap
 * @param log - where a mismatch is logged
 * @returns `sender` in production, else a checking wrapper around it
 */
export const create_validated_notification_sender = (
	sender: NotificationSender,
	log: Logger
): NotificationSender => {
	if (!DEV) return sender;
	return {
		send_to_account: (account_id, message) => {
			const spec = notification_spec_by_method.get(message.method);
			if (spec) {
				const result = parse_any(spec.input, message.params);
				if (!result.ok) {
					log.error(`notification params schema mismatch: ${message.method}`, result.issues);
				}
			}
			return sender.send_to_account(account_id, message);
		}
	};
};

// -- Notification builders --------------------------------------------------

export const build_role_grant_offer_received_notification = (
	params: RoleGrantOfferReceivedParams
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD, params);

export const build_role_grant_offer_retracted_notification = (
	params: RoleGrantOfferRetractedParams
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD, params);

export const build_role_grant_offer_accepted_notification = (
	params: RoleGrantOfferAcceptedParams
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD, params);

export const build_role_grant_offer_declined_notification = (
	params: RoleGrantOfferDeclinedParams
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD, params);

export const build_role_grant_offer_supersede_notification = (
	params: RoleGrantOfferSupersedeParams
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD, params);

export const build_role_grant_revoked_notification = (
	params: RoleGrantRevokedParams
): JsonrpcNotification =>
	create_jsonrpc_notification(ROLE_GRANT_REVOKED_NOTIFICATION_METHOD, params);
