/**
 * Shared `peer/ping` action — the protocol action that exercises the
 * server→client request/response direction of ActionPeer.
 *
 * `peer/ping` is `initiator: 'both'`: the client→server direction overlaps
 * with `heartbeat`, but the new direction this action drives is the reverse —
 * a connected client invokes `peer/ping` over its socket, and the handler
 * turns around and *initiates* a `peer/ping` request back to that same socket
 * (`ctx.request_client`), awaits the client's echo, validates it against
 * `PingResponse`, and returns the validated shape. So one client RPC drives
 * the whole round-trip and every outcome surfaces as that RPC's wire response.
 *
 * **Public auth.** A liveness echo is non-sensitive; the WebSocket upgrade
 * itself still authenticates, so only admitted sockets reach the handler.
 *
 * **No return transport (HTTP RPC).** Over HTTP there is no socket to ping —
 * `ctx.request_client` is absent — so the handler refuses with
 * `peer_no_transport` rather than `method_not_found`. That requires the action
 * to be mounted on the HTTP RPC endpoint as well as the WS endpoint (it is, via
 * the spine's full mount); the manifest excludes it as a protocol action so the
 * cross-impl diff stays apples-to-apples.
 *
 * The `data.reason` discriminators and the `PingResponse` shape are the
 * cross-impl wire contract — twins of the Rust spine's `REASON_PEER_*`
 * constants and `PingResponse` (parity by test, not codegen).
 *
 * **Frontend-safe.** Like `heartbeat.ts` / `cancel.ts`, this module names
 * the dispatcher types (`ActionContext`, `RpcAction`) type-only and builds
 * `peer_ping_action` as a plain literal — it never imports the runtime
 * `action_rpc.ts` (which would drag the HTTP dispatch core + Hono into any
 * frontend that pulls `protocol_action_specs`). The frontend responder
 * (`peer_ping_responder`) lives here too so a real frontend can answer the
 * server's probe.
 *
 * @module
 */

import { z } from 'zod';

import { ThrownJsonrpcError, JSONRPC_ERROR_CODES } from '../http/jsonrpc_errors.ts';
import type { RequestResponseActionSpec } from './action_spec.ts';
import type { ActionContext, RpcAction } from './action_rpc.ts';
import { DEFAULT_PEER_REQUEST_TIMEOUT, type PeerRequestError } from './peer_request.ts';

/** Wire method name (both directions). Twin of the Rust `PEER_PING_METHOD`. */
export const PEER_PING_METHOD = 'peer/ping';

/**
 * Wire-protocol version reported in `peer/ping` replies
 * (`PingResponse.protocol_version`). Twin of the Rust spine's value — bump
 * in lockstep with a breaking peer-protocol change. The far side validates
 * the reply's *shape*, not this value, so it's informational telemetry
 * today, but it's the hook a future protocol negotiation reads.
 */
export const PEER_PROTOCOL_VERSION = 1;

// --- `data.reason` discriminators (cross-impl wire contract) ---

/** The peer did not reply within the deadline. */
export const REASON_PEER_TIMEOUT = 'peer_timeout';
/** The socket closed before the peer replied. */
export const REASON_PEER_CONNECTION_GONE = 'peer_connection_gone';
/** No return socket — the action ran over a transport that can't initiate a server→client request (HTTP RPC). */
export const REASON_PEER_NO_TRANSPORT = 'peer_no_transport';
/** The per-connection in-flight server→client request cap was hit. */
export const REASON_PEER_TOO_MANY_IN_FLIGHT = 'peer_too_many_in_flight';
/** The peer replied, but the payload failed `PingResponse` validation. */
export const REASON_PEER_PING_INVALID_REPLY = 'peer_ping_invalid_reply';
/** The peer replied with a `PingResponse` whose nonce didn't echo the issued one. */
export const REASON_PEER_PING_NONCE_MISMATCH = 'peer_ping_nonce_mismatch';

/**
 * Input to the client→server `peer/ping` invocation. Both fields optional
 * (mirrors the Rust `PingActionInput`): `nonce` defaults to a server-issued
 * value, `timeout_ms` to `DEFAULT_PEER_REQUEST_TIMEOUT` (clamped shorten-only).
 */
export const PingActionInput = z
	.strictObject({
		nonce: z.number().int().optional(),
		timeout_ms: z.number().int().positive().optional()
	})
	// `.default({})` so omitting `params` entirely (undefined) is accepted — both
	// fields are optional, so an empty invocation is valid (server-issued nonce,
	// default timeout). Mirrors `heartbeat`'s nullary `.default({})`.
	.default({});
export type PingActionInput = z.infer<typeof PingActionInput>;

/** Params of the server→client `peer/ping` request frame. Twin of the Rust `PingRequest`. */
export const PingRequestParams = z.strictObject({
	nonce: z.number().int()
});
export type PingRequestParams = z.infer<typeof PingRequestParams>;

/**
 * The client's reply shape — also the action's output (the handler returns the
 * validated echo). Twin of the Rust `PingResponse`.
 */
export const PingResponse = z.strictObject({
	nonce: z.number().int(),
	protocol_version: z.number().int()
});
export type PingResponse = z.infer<typeof PingResponse>;

/**
 * `ActionSpec` for the shared `peer/ping`. `initiator: 'both'` (the
 * client→server invocation drives a server→client request); `auth: public`
 * (liveness is non-sensitive; the upgrade authenticated the socket);
 * `side_effects: false` (no state change — the handler only round-trips a ping).
 */
export const peer_ping_action_spec = {
	method: PEER_PING_METHOD,
	kind: 'request_response',
	initiator: 'both',
	auth: { account: 'none', actor: 'none' },
	side_effects: false,
	input: PingActionInput,
	output: PingResponse,
	async: true,
	description:
		'Liveness round-trip — the handler pings the originating client back over its socket, ' +
		'validates the echo, and returns it. Refused as no-transport over HTTP RPC.'
} satisfies RequestResponseActionSpec;

/** Monotonic fallback nonce when the caller omits one — mirrors the Rust `next_nonce`. */
let next_ping_nonce = 0;

/** Map a transport-level `PeerRequestError` to the thrown JSON-RPC error the caller sees. */
const peer_request_error_to_jsonrpc = (error: PeerRequestError): ThrownJsonrpcError => {
	switch (error.kind) {
		case 'timeout':
			return new ThrownJsonrpcError(JSONRPC_ERROR_CODES.timeout, 'peer request timed out', {
				reason: REASON_PEER_TIMEOUT
			});
		case 'connection_gone':
			return new ThrownJsonrpcError(
				JSONRPC_ERROR_CODES.service_unavailable,
				'peer connection gone',
				{ reason: REASON_PEER_CONNECTION_GONE }
			);
		case 'too_many_in_flight':
			return new ThrownJsonrpcError(
				JSONRPC_ERROR_CODES.queue_overflow,
				'too many in-flight peer requests',
				{ reason: REASON_PEER_TOO_MANY_IN_FLIGHT }
			);
		case 'client_error':
			// Forward the client's envelope verbatim so its own code / message /
			// data reach the original caller unchanged.
			return new ThrownJsonrpcError(error.error.code, error.error.message, error.error.data);
	}
};

/**
 * Handler — initiates a `peer/ping` request back to the originating client,
 * awaits the reply, validates it against `PingResponse`, and returns it.
 *
 * @throws ThrownJsonrpcError with `data.reason` of `peer_no_transport` (HTTP),
 *   `peer_timeout` / `peer_connection_gone` / `peer_too_many_in_flight`
 *   (transport failures), the client's own envelope (`client_error`), or
 *   `peer_ping_invalid_reply` / `peer_ping_nonce_mismatch` (bad echo).
 */
export const peer_ping_handler = async (
	input: PingActionInput,
	ctx: ActionContext
): Promise<PingResponse> => {
	if (!ctx.request_client) {
		throw new ThrownJsonrpcError(
			JSONRPC_ERROR_CODES.invalid_request,
			'peer/ping has no return transport',
			{ reason: REASON_PEER_NO_TRANSPORT }
		);
	}

	const nonce = input.nonce ?? ++next_ping_nonce;
	// Shorten-only clamp: a remote caller may make the server give up sooner,
	// never hold the (pooled) connection longer than the default.
	const timeout_ms =
		input.timeout_ms == null
			? DEFAULT_PEER_REQUEST_TIMEOUT
			: Math.min(input.timeout_ms, DEFAULT_PEER_REQUEST_TIMEOUT);

	const request_params: PingRequestParams = { nonce };
	const outcome = await ctx.request_client(PEER_PING_METHOD, request_params, { timeout_ms });
	if (!outcome.ok) throw peer_request_error_to_jsonrpc(outcome.error);

	const parsed = PingResponse.safeParse(outcome.value);
	if (!parsed.success) {
		throw new ThrownJsonrpcError(
			JSONRPC_ERROR_CODES.validation_error,
			'peer/ping reply failed validation',
			{ reason: REASON_PEER_PING_INVALID_REPLY }
		);
	}
	if (parsed.data.nonce !== nonce) {
		throw new ThrownJsonrpcError(
			JSONRPC_ERROR_CODES.validation_error,
			'peer/ping reply nonce mismatch',
			{ reason: REASON_PEER_PING_NONCE_MISMATCH }
		);
	}
	return parsed.data;
};

/**
 * Reusable responder for an inbound *server→client* `peer/ping` request — the
 * mirror of `peer_ping_handler`, run by the **client** (frontend). Validates the
 * request params and echoes a `PingResponse` carrying the issued nonce. Pure +
 * transport-agnostic (the production twin of the cross-process test transport's
 * `echo_responder`); `FrontendWebsocketTransport` wires it so a real frontend
 * answers the server's liveness probe with zero consumer plumbing. Falls back to
 * `nonce: 0` on a malformed request — the server then surfaces a nonce mismatch,
 * the correct outcome for a bad probe.
 *
 * @param params - the inbound request's `params` (`PingRequestParams` shape)
 * @returns the `PingResponse` echo to send back as the reply's `result`
 */
export const peer_ping_responder = (params: unknown): PingResponse => {
	const parsed = PingRequestParams.safeParse(params);
	return { nonce: parsed.success ? parsed.data.nonce : 0, protocol_version: PEER_PROTOCOL_VERSION };
};

/**
 * Protocol-action tuple — spread into the server's `actions` array (via
 * `protocol_actions` from `actions/protocol.ts`) so the dispatcher resolves the
 * `peer/ping` handler on both the WS endpoint and (for the no-transport refusal)
 * the HTTP RPC endpoint. A plain `RpcAction` literal (not `rpc_action(...)`) so
 * this module stays free of the runtime `action_rpc.ts` import — the same
 * frontend-safety discipline `heartbeat_action` / `cancel_action` follow; the
 * handler's input/output are already pinned by `peer_ping_handler`'s signature.
 * Usable directly in the spine's `RpcAction[]` full mount and the `Action[]`
 * protocol bundle alike.
 */
export const peer_ping_action: RpcAction = {
	spec: peer_ping_action_spec,
	handler: peer_ping_handler
};
