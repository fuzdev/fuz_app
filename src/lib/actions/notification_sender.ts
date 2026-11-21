/**
 * Pushing a server-initiated JSON-RPC notification to an account's live
 * WebSocket connections.
 *
 * **Why the handler context carries it.** A notification carries a domain
 * payload (an offer, a revoked grant) that only the handler holds, so the
 * handler builds the message and queues the send after its commit
 * (`queue_offer_notification` in `auth/role_grant_offer_notifications.ts`).
 * `perform_action` puts the sender on every `ActionContext`, so no action
 * factory takes one and none can be wired with the wrong one: an offer
 * created over HTTP RPC must reach the recipient's sockets on the WebSocket
 * registry, which a sender bound to any other registry would miss silently.
 *
 * **Why a fan-out.** `create_app_backend` puts one
 * `RealtimeNotificationSender` on `AppDeps.notification_sender`, and
 * `create_app_server` adds every WebSocket connection registry it mounts.
 * The registries are created at mount, after the RPC and WebSocket action
 * factories run, so a sender read at send time is the only one that reaches
 * them. A server mounting no WebSocket endpoint holds an empty fan-out, and
 * its sends reach no one.
 *
 * Twin of the Rust spine's `NotificationSender` and `NoopNotificationSender`;
 * the Rust backend serves one connection registry on every endpoint, which
 * the fan-out stands in for.
 *
 * @module
 */

import type { Uuid } from '../primitive_schemas.ts';
import type { JsonrpcNotification } from '../http/jsonrpc.ts';

/**
 * Send a JSON-RPC notification to every admitted socket bound to an account.
 *
 * `ConnectionRegistry` satisfies this structurally — its `send_to_account`
 * accepts the broader `JsonrpcMessageFromServerToClient`. The interface
 * stays narrow so handlers don't couple to the concrete registry and tests
 * can capture sends with no WebSocket machinery.
 *
 * Returns how many sockets accepted the notification — bookkeeping, not a
 * delivery receipt; `0` means the account has no live socket.
 */
export interface NotificationSender {
	send_to_account: (account_id: Uuid, message: JsonrpcNotification) => number;
}

/**
 * A `NotificationSender` that sends nothing — for a hand-mounted dispatcher
 * whose actions have no live connection to reach.
 */
export const noop_notification_sender: NotificationSender = Object.freeze({
	send_to_account: () => 0
});

/**
 * One `NotificationSender` over every WebSocket connection registry of a
 * backend.
 *
 * Each send reaches every member and returns the sum, so an account with
 * sockets on two registries hears the notification on each. A member that
 * throws does not stop the others: every member is called, then the first
 * error is thrown for the caller (the post-commit flush) to log.
 */
export interface RealtimeNotificationSender extends NotificationSender {
	/**
	 * Add a registry's sender, returning a remover for this addition.
	 *
	 * Membership is by reference: a sender added twice — two endpoints sharing
	 * one registry — is one member, and every send reaches it once, so no
	 * socket hears a notification twice. Each `add` is counted, and its
	 * remover releases only that count: the sender stays a member until every
	 * addition is removed. Calling a remover again is a no-op.
	 *
	 * @param sender - the registry's sender
	 * @returns a remover for this addition, idempotent
	 */
	add: (sender: NotificationSender) => () => void;
	/** Count of distinct members — introspection for tests and diagnostics. */
	member_count: () => number;
}

/**
 * Create an empty `RealtimeNotificationSender`.
 *
 * `create_app_backend` creates the one on `AppDeps.notification_sender`, and
 * `create_app_server` adds each WebSocket connection registry it mounts,
 * removing them when its assembly fails or the server closes.
 */
export const create_realtime_notification_sender = (): RealtimeNotificationSender => {
	// member → how many additions hold it; iteration order is first addition
	const members: Map<NotificationSender, number> = new Map();
	return Object.freeze({
		add: (sender: NotificationSender): (() => void) => {
			members.set(sender, (members.get(sender) ?? 0) + 1);
			let removed = false;
			return () => {
				if (removed) return;
				removed = true;
				const count = members.get(sender);
				if (count === undefined) return;
				if (count <= 1) members.delete(sender);
				else members.set(sender, count - 1);
			};
		},
		member_count: (): number => members.size,
		send_to_account: (account_id: Uuid, message: JsonrpcNotification): number => {
			let count = 0;
			let failed = false;
			let first_error: unknown;
			for (const member of members.keys()) {
				try {
					count += member.send_to_account(account_id, message);
				} catch (error) {
					// keep going — one registry's failure must not keep the
					// notification from the account's sockets on another
					if (!failed) {
						failed = true;
						first_error = error;
					}
				}
			}
			if (failed) throw first_error;
			return count;
		}
	});
};
