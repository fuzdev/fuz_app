/**
 * Shared cancel action — a fuz_app protocol action validating the
 * spec+handler tuple pattern on a notification-kind action.
 *
 * Semantics: the client sends `{jsonrpc, method: 'cancel', params:
 * {request_id}}` to abort an in-flight request on the same socket.
 * `register_action_ws` intercepts this notification and aborts the
 * matching pending request's `ctx.signal`. Unknown ids are no-ops by design —
 * races between response arrival and cancel delivery are safe without extra
 * coordination.
 *
 * The handler field is an empty stub: cancel semantics are dispatcher-owned
 * (the dispatcher has the `{request_id → AbortController}` map, not the
 * handler). The handler exists for symmetry with other protocol actions
 * like `heartbeat_action`; the dispatcher never calls it. Consumers
 * spread `cancel_action` (or the `protocol_actions` bundle from
 * `actions/protocol.ts`) into their server's `actions` array so `spec_by_method`
 * knows about it (enabling input validation on incoming cancels) and so
 * `create_rpc_client` codegen produces `app.api.cancel()` when desired —
 * though `FrontendWebsocketClient.request({signal})` sends the cancel on
 * abort without needing the typed API.
 *
 * Wire format is snake_case `cancel` with `{request_id}`, not MCP's
 * `$/cancelRequest` with `{requestId}` — fuz_app's WS transport isn't MCP,
 * and adopting MCP's convention would leak protocol-specific framing into
 * the base transport. When MCP elicitation (Phase 5) lands, a translation
 * layer at the MCP adapter is the right seam.
 *
 * @module
 */

import {z} from 'zod';

import {JsonrpcRequestId} from '../http/jsonrpc.js';
import type {RemoteNotificationActionSpec} from './action_spec.js';
import type {Action} from './action_types.js';

/**
 * Params for the `cancel` notification. `request_id` is the id of the
 * pending request to abort. Must match the id of a request sent on the
 * same socket; cancels from other sockets (or for unknown ids) are ignored.
 */
export const CancelNotificationParams = z.strictObject({
	request_id: JsonrpcRequestId,
});
export type CancelNotificationParams = z.infer<typeof CancelNotificationParams>;

/**
 * `ActionSpec` for the shared cancel. `auth: null` matches every other
 * remote-notification spec — upgrade-time auth has already admitted the
 * socket, so per-action auth on a fire-and-forget notification is moot. The
 * per-connection `{request_id → AbortController}` map enforces socket-scoped
 * ownership naturally: a different socket's cancel for the same id misses
 * in its own map.
 */
export const cancel_action_spec = {
	method: 'cancel',
	kind: 'remote_notification',
	initiator: 'frontend',
	auth: null,
	side_effects: true,
	input: CancelNotificationParams,
	output: z.void(),
	async: true,
	description:
		'Client-initiated cancellation of an in-flight request by id. Dispatcher-handled: aborts the ctx.signal of the matching pending request on the same socket. Unknown or completed ids no-op.',
} satisfies RemoteNotificationActionSpec;

/**
 * Placeholder handler — cancel semantics are owned by `register_action_ws`,
 * not invoked per-handler. Exported for symmetry with the `Action`
 * tuple shape; the dispatcher short-circuits cancel notifications before any
 * handler lookup happens.
 */
export const cancel_handler = (): void => {}; // eslint-disable-line @typescript-eslint/no-empty-function

/**
 * Protocol-action tuple — spread into the server's `actions` array (or via
 * `protocol_actions` from `actions/protocol.ts`) so the dispatcher registers the
 * spec for input validation and so `create_rpc_client` codegen sees the
 * method. The client doesn't need to call it directly;
 * `FrontendWebsocketClient.request({signal})` sends the cancel notification
 * automatically when the signal fires.
 */
export const cancel_action: Action = {
	spec: cancel_action_spec,
	handler: cancel_handler,
};
