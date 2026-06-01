import '../assert_dev_env.js';

/**
 * Shared WebSocket client surface for cross-backend tests.
 *
 * `WsClient` is the interface every in-process or cross-process WS test
 * driver implements — `send` / `request` / `close` / `messages` /
 * `wait_for`. Two impls today:
 *
 * - **In-process** — `create_ws_test_harness` in `testing/ws_round_trip.ts`.
 *   Drives `register_action_ws` against a fake Hono upgrade so the
 *   dispatcher's full path runs without the wire upgrade.
 * - **Cross-process** — `create_ws_transport` in `testing/transports/ws_transport.ts`.
 *   Wraps the native `WebSocket` upgrade against a real running binary,
 *   threading the session cookie captured by `FetchTransport`.
 *
 * Wire-frame types + predicates also live here so both impls (and every
 * shared assertion helper) reference one source.
 *
 * @module
 */

import {
	is_jsonrpc_error_response,
	is_jsonrpc_notification,
	is_jsonrpc_response,
} from '../../http/jsonrpc_helpers.js';
import {JSONRPC_VERSION} from '../../http/jsonrpc.js';

// ---------------------------------------------------------------------
// Wire-frame types — describe a parsed wire message as observed on the
// client side in a test, with a type parameter for the `params` /
// `result` payload so assertions narrow without a cast. Distinct from
// the Zod-inferred `JsonrpcNotification` / `JsonrpcResponse` /
// `JsonrpcErrorResponse` in `http/jsonrpc.ts` — the runtime validation
// schemas intentionally keep `params` / `result` widened to `unknown`,
// since adding a generic parameter there would break the `z.infer`
// pattern for a benefit test code owns exclusively.
// ---------------------------------------------------------------------

export interface JsonrpcNotificationFrame<P = unknown> {
	jsonrpc: typeof JSONRPC_VERSION;
	method: string;
	params: P;
}

export interface JsonrpcSuccessResponseFrame<R = unknown> {
	jsonrpc: typeof JSONRPC_VERSION;
	id: number | string;
	result: R;
}

export interface JsonrpcErrorResponseFrame<D = unknown> {
	jsonrpc: typeof JSONRPC_VERSION;
	id: number | string;
	error: {code: number; message: string; data?: D};
}

// ---------------------------------------------------------------------
// Predicates — compose with `WsClient.wait_for` and
// `messages.filter(...)`. Both in-process and cross-process tests use
// the same names against the same shapes.
// ---------------------------------------------------------------------

/** Predicate matching a JSON-RPC notification with the given method name. */
export const is_notification =
	(method: string) =>
	(msg: unknown): boolean =>
		is_jsonrpc_notification(msg) && msg.method === method;

/**
 * Type-guard combinator: match a notification whose typed `params` satisfies
 * `match`. Collapses the common test pattern of casting `msg` to
 * `JsonrpcNotificationFrame<P>` in every predicate body.
 *
 * ```ts
 * const match_roster_for = (id: Uuid) =>
 *   is_notification_with<RosterChangedParams>(
 *     WORLD_METHODS.roster_changed,
 *     (params) => params.character_id === id && !params.removed,
 *   );
 * const roster = await client.wait_for(match_roster_for(char_id));
 * ```
 */
export const is_notification_with =
	<P>(method: string, match: (params: P) => boolean) =>
	(msg: unknown): msg is JsonrpcNotificationFrame<P> =>
		is_jsonrpc_notification(msg) &&
		msg.method === method &&
		match((msg as JsonrpcNotificationFrame<P>).params);

/** Predicate matching a JSON-RPC response frame (success or error) for the given request id. */
export const is_response_for =
	(id: number | string) =>
	(msg: unknown): boolean =>
		(is_jsonrpc_response(msg) || is_jsonrpc_error_response(msg)) && msg.id === id;

// ---------------------------------------------------------------------
// WsClient — the test-driver surface every impl implements.
// ---------------------------------------------------------------------

/**
 * Default wait-for timeout shared across in-process + cross-process
 * impls. Tunable per-call via the `timeout_ms` parameter.
 */
export const WS_CLIENT_DEFAULT_TIMEOUT_MS = 1000;

/** A test WS client: send requests, inspect / await incoming messages. */
export interface WsClient {
	/**
	 * Send a JSON-RPC message (request or notification) to the server.
	 *
	 * @throws Error if called after `close()` resolves — every impl
	 *   rejects sends on a closed socket so post-close test bugs surface
	 *   immediately rather than silently dropping.
	 */
	send: (message: unknown) => Promise<void>;
	/**
	 * Send a JSON-RPC request and await its response. Resolves with the
	 * `result`; throws with a useful message (code, text, and any `data`
	 * payload) on an error frame — without this, asserting on
	 * `result.foo` for a failed request throws
	 * `Cannot read property 'foo' of undefined`, hiding the real cause.
	 * Use `send` + `wait_for(is_response_for(id))` directly when the test
	 * needs to assert on the error frame itself.
	 *
	 * @throws Error if the server returns a JSON-RPC error frame for `id`,
	 *   or if `wait_for` times out before a matching response arrives.
	 */
	request: <R = unknown>(
		id: number | string,
		method: string,
		params: unknown,
		timeout_ms?: number,
	) => Promise<R>;
	/**
	 * Close the connection. Returns a promise that resolves once the
	 * transport's own cleanup (and any `on_socket_close` for the
	 * in-process driver) has completed — tests that assert on post-close
	 * state should await.
	 */
	close: (code?: number, reason?: string) => Promise<void>;
	/**
	 * Wait for the server to close the connection. Resolves `true` if the
	 * socket closed within `timeout_ms`, `false` on timeout. The signal for
	 * server-initiated close — used by close-on-revoke tests that fire a
	 * revocation over a side channel and assert the live socket drops.
	 *
	 * Resolves `true` immediately when the socket is already closed.
	 * Distinct from `close()` (client-initiated): this awaits a close the
	 * test did not request. Mirrors `wait_for_close` on the SSE frame reader
	 * in `testing/sse_round_trip.ts`.
	 */
	wait_for_close: (timeout_ms?: number) => Promise<boolean>;
	/** Every message the server has sent, in arrival order. */
	readonly messages: ReadonlyArray<unknown>;
	/**
	 * Wait until a message satisfies `predicate`. Matches are checked
	 * against already-received messages first, then new arrivals until
	 * the timeout (defaults to `WS_CLIENT_DEFAULT_TIMEOUT_MS`).
	 *
	 * When `predicate` is a type guard (e.g. `is_notification_with<P>`),
	 * the result is narrowed automatically and callers don't need to
	 * spell `<JsonrpcNotificationFrame<P>>` on the call site.
	 *
	 * @throws Error if `timeout_ms` elapses before a matching message
	 *   arrives — the pending waiter is dropped from the internal list so
	 *   later messages don't keep iterating it.
	 */
	wait_for: {
		<T>(predicate: (msg: unknown) => msg is T, timeout_ms?: number): Promise<T>;
		// eslint-disable-next-line @typescript-eslint/unified-signatures
		<T = unknown>(predicate: (msg: unknown) => boolean, timeout_ms?: number): Promise<T>;
	};
}
