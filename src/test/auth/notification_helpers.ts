/**
 * Shared helpers for the two role-grant-offer notification test suites
 * (`role_grant_offer_actions.notifications.db.test.ts` and
 * `role_grant_offer_actions.notifications.revoke.db.test.ts`).
 *
 * Not itself a test file — no `.test.` infix means vitest does not execute
 * it directly. The filename is internal to `src/test/` and is not published.
 *
 * @module
 */

import { create_role_grant_offer_actions } from '#lib/auth/role_grant_offer_actions.ts';
import type { NotificationSender } from '#lib/actions/notification_sender.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import type { RpcEndpointSpec } from '#lib/http/surface.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import type { JsonrpcNotification } from '#lib/http/jsonrpc.ts';

/** The conventional RPC mount path in these tests. */
export const NOTIFICATION_TEST_RPC_PATH = '/api/rpc';

/** Shape captured by `create_capture_sender` for each WS fan-out. */
export interface CapturedNotificationCall {
	account_id: string;
	method: string;
	params: unknown;
}

/**
 * Build a `NotificationSender` that records every `send_to_account` call
 * into the provided array. Returns a `reset()` method on the sender so
 * tests that build a single sender can null out the buffer between cases.
 */
export const create_capture_sender = (
	calls: Array<CapturedNotificationCall>
): NotificationSender & { reset: () => void } => ({
	send_to_account: (account_id: Uuid, message: JsonrpcNotification): number => {
		calls.push({
			account_id,
			method: message.method,
			params: message.params
		});
		return 1;
	},
	reset: () => {
		calls.length = 0;
	}
});

/**
 * The `create_test_app` options that mount the role-grant-offer actions on
 * `NOTIFICATION_TEST_RPC_PATH` the way a consumer does — through
 * `rpc_endpoints`, with no sender handed to the factory — and add `sender` to
 * the backend's notification sender, where `create_app_server` adds each
 * WebSocket registry it mounts. So a capture here proves the whole thread: the
 * dispatcher puts the backend's sender on the handler context, and the
 * handler sends through it.
 */
export const create_notification_app_options = (
	sender: NotificationSender
): {
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	rpc_endpoints: (ctx: AppServerContext) => Array<RpcEndpointSpec>;
} => ({
	create_route_specs: (ctx) => {
		ctx.deps.notification_sender.add(sender);
		return [];
	},
	rpc_endpoints: (ctx) => [
		{ path: NOTIFICATION_TEST_RPC_PATH, actions: create_role_grant_offer_actions(ctx.deps) }
	]
});
