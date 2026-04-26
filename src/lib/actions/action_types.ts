/**
 * Shared type surface for the action system — context, handler, composable Action tuple.
 *
 * These types sit above `action_spec.ts` (pure Zod schemas) and below the
 * dispatchers (`register_action_ws.ts`, `action_rpc.ts`). Extracted so the
 * shared protocol actions (e.g. `heartbeat_action`) can name them without
 * pulling in server-only modules.
 *
 * @module
 */

import type {Uuid} from '@fuzdev/fuz_util/id.js';

import type {JsonrpcRequestId} from '../http/jsonrpc.js';
import type {ActionSpecUnion} from './action_spec.js';

/**
 * Minimum per-request context every server-side WS handler receives.
 *
 * Consumers extend this with domain-specific fields via the dispatcher's
 * `extend_context` option. Mirrors the HTTP-side `ActionContext` and Rust's
 * `Ctx<'a>` shape (`request_id` + `NotifyFn` + `CancellationToken`).
 */
export interface BaseHandlerContext {
	/** JSON-RPC envelope request id — echoed back on the response. */
	request_id: JsonrpcRequestId;
	/**
	 * Stable per-socket connection id assigned by
	 * `BackendWebsocketTransport.add_connection` — same reference across every
	 * message on this socket, also passed to `on_socket_open` /
	 * `on_socket_close`. Consumers key per-connection domain state on this
	 * directly instead of trying to derive it from signals (which are
	 * per-message composites of `AbortSignal.any([socket, request])`).
	 */
	connection_id: Uuid;
	/**
	 * Send a request-scoped JSON-RPC notification to the originating socket.
	 * Not a broadcast — the message only reaches the client whose request
	 * triggered this handler.
	 */
	notify: (method: string, params: unknown) => void;
	/**
	 * Fires on socket close OR on a client-initiated `cancel` notification
	 * matching this request's id. Streaming handlers poll for early
	 * termination; per-message composite (`AbortSignal.any([socket, request])`)
	 * — not stable across messages.
	 */
	signal: AbortSignal;
}

/**
 * Handler signature — receives validated input and per-request context.
 *
 * Named to disambiguate from `actions/action_rpc.ts`'s `ActionHandler`
 * (HTTP-side, `ActionContext` + two generic slots). The WS variant is
 * single-slotted on the context and returns `unknown`.
 */
export type WsActionHandler<TCtx extends BaseHandlerContext = BaseHandlerContext> = (
	input: unknown,
	ctx: TCtx,
) => unknown;

/**
 * A spec paired with its optional handler — the composable unit passed to
 * `register_action_ws` and `create_rpc_client`. The server uses
 * both fields; the client reads only `spec` (the `handler` is
 * ignored, harmless). Shared fuz_app primitives (e.g. `heartbeat_action`)
 * export a complete tuple so consumers spread them into both sides'
 * `actions` array without inventing per-repo ping plumbing.
 *
 * Left open for future fields (`rate_limit`, ACL, middleware hooks) so
 * additions attach to the action itself instead of scattering across
 * parallel arrays.
 */
export interface Action<TCtx extends BaseHandlerContext = BaseHandlerContext> {
	spec: ActionSpecUnion;
	/** Server-side handler. Ignored by the client. Omit for client-only specs. */
	handler?: WsActionHandler<TCtx>;
}
