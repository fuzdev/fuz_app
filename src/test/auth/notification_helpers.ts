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

import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {create_role_grant_offer_actions} from '$lib/auth/role_grant_offer_actions.js';
import {type NotificationSender} from '$lib/auth/role_grant_offer_notifications.js';
import type {AppServerContext} from '$lib/server/app_server_context.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import type {JsonrpcNotification} from '$lib/http/jsonrpc.js';

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
	calls: Array<CapturedNotificationCall>,
): NotificationSender & {reset: () => void} => ({
	send_to_account: (account_id: Uuid, message: JsonrpcNotification): number => {
		calls.push({
			account_id: account_id as string,
			method: message.method,
			params: message.params,
		});
		return 1;
	},
	reset: () => {
		calls.length = 0;
	},
});

/**
 * Build a `create_route_specs` function that mounts the role-grant-offer RPC
 * endpoint with the given sender wired as `notification_sender`.
 *
 * Path defaults to `NOTIFICATION_TEST_RPC_PATH`; override per test if
 * needed.
 */
export const create_notification_route_specs_factory =
	(sender: NotificationSender, rpc_path: string = NOTIFICATION_TEST_RPC_PATH) =>
	(ctx: AppServerContext): Array<RouteSpec> => [
		...create_rpc_endpoint({
			path: rpc_path,
			actions: create_role_grant_offer_actions({...ctx.deps, notification_sender: sender}),
			log: ctx.deps.log,
		}),
	];
