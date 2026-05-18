/**
 * Backend-initiated broadcast notification plumbing — generic across consumers.
 *
 * Builds a typed `{method_name: (input) => Promise<void>}` object from a list
 * of action specs. Each call validates input against the spec, wraps it in a
 * JSON-RPC notification, and either broadcasts to every connection or
 * fans out with a per-connection ACL predicate.
 *
 * Counterpart to `register_action_ws`: that handles request-scoped dispatch
 * (frontend-initiated), this handles broadcast (backend-initiated). Together
 * they cover the two primitives fuz_app consumers share. Request-scoped
 * streaming (`completion_progress`, `zap_apply` events) stays on
 * `ctx.notify` inside a handler — it's socket-scoped, not broadcast.
 *
 * Extracted from zzz's `backend_actions_api.ts` to stop the pattern from
 * drifting across consumers.
 *
 * @module
 */

import {Logger, type Logger as LoggerType} from '@fuzdev/fuz_util/log.js';

import {create_jsonrpc_notification, to_jsonrpc_params} from '../http/jsonrpc_helpers.js';
import type {ActionPeer} from './action_peer.js';
import type {ActionSpecUnion} from './action_spec.js';
import {
	is_filterable_broadcast_transport,
	type ConnectionIdentity,
} from './transports_ws_backend.js';

/**
 * Per-connection delivery predicate for subscription ACLs.
 *
 * Called once per connection for every broadcast send. Returning `false`
 * skips that connection. Keep it fast — this runs in the broadcast hot path.
 *
 * `input` is the already-validated payload (matches the spec's input schema);
 * `method` is the action method name.
 */
export type ShouldDeliverFn = (
	connection: ConnectionIdentity,
	method: string,
	input: unknown,
) => boolean;

/** Options for `create_broadcast_api`. */
export interface CreateBroadcastApiOptions {
	/** The peer holding the transport registry used for sends. */
	peer: ActionPeer;
	/**
	 * Notification specs to expose as broadcast methods. Typically the
	 * `remote_notification` specs whose initiator is `backend` (or `both`).
	 * Other kinds are accepted — the helper only uses `spec.method` and
	 * `spec.input` — but the typical use is notifications.
	 */
	specs: ReadonlyArray<ActionSpecUnion>;
	/** Logger for validation/send errors. Defaults to a `[broadcast]` namespace. */
	log?: LoggerType | null;
	/**
	 * Optional per-connection ACL predicate. When set, the broadcast fans out
	 * via the transport's `broadcast_filtered` (feature-detected) — each
	 * connection's identity is checked before the message is sent. When
	 * unset, the transport broadcasts unfiltered via `transport.send`.
	 *
	 * Requires a transport that implements `FilterableBroadcastTransport`
	 * (today: only `BackendWebsocketTransport`). If set and the active
	 * transport is not filterable, the send is skipped and an error logged.
	 */
	should_deliver?: ShouldDeliverFn;
}

/**
 * Loose base shape for a broadcast API. Consumers typically declare a
 * stricter per-method interface (e.g. `BackendActionsApi`) and pin it via
 * the type parameter on `create_broadcast_api`.
 */
export type BroadcastApi = Record<string, (input: never) => Promise<void>>;

/**
 * Builds a typed broadcast API from a set of action specs.
 *
 * For each spec, adds a method keyed by `spec.method` that:
 * - Validates `input` against the spec's Zod schema (logs and returns on failure)
 * - Creates a JSON-RPC notification from the validated input
 * - Broadcasts via the peer (filtered by `should_deliver` when supplied)
 *
 * Silently returns when no transport is ready (e.g. before any clients
 * connect). Errors during send are logged but never thrown — broadcasts are
 * fire-and-forget from the handler's perspective.
 *
 * ## Typed consumer surface
 *
 * Consumers declare an explicit interface and pin it via the type parameter:
 *
 * ```ts
 * export interface BackendActionsApi {
 *   filer_change: (input: ActionInputs['filer_change']) => Promise<void>;
 *   workspace_changed: (input: ActionInputs['workspace_changed']) => Promise<void>;
 * }
 *
 * const api = create_broadcast_api<BackendActionsApi>({
 *   peer: backend.peer,
 *   specs: [filer_change_action_spec, workspace_changed_action_spec],
 * });
 * ```
 *
 * The cast is unchecked — callers must keep the interface and the `specs`
 * array in sync. Codegen (`action_collections.gen.ts`) is a natural fit
 * if the consumer already generates per-method type maps.
 */
export const create_broadcast_api = <TApi extends object>(
	options: CreateBroadcastApiOptions,
): TApi => {
	const {peer, specs, should_deliver} = options;
	const log = options.log === undefined ? new Logger('[broadcast]') : options.log;

	const api: Record<string, (input: unknown) => Promise<void>> = {};

	for (const spec of specs) {
		const {method} = spec;
		api[method] = async (input: unknown): Promise<void> => {
			const parsed = spec.input.safeParse(input);
			if (!parsed.success) {
				log?.error(`[${method}] input validation failed:`, parsed.error.issues);
				return;
			}

			// Resolve the broadcast target deterministically — no fallback.
			// Broadcast is 1→N over a specific primary transport; falling through
			// to "any ready transport" would send to an unexpected audience.
			// Silent skip when no ready transport (e.g. before any clients connect).
			const transport_name = peer.default_send_options.transport_name;
			const transport = transport_name
				? peer.transports.get_transport_by_name(transport_name)
				: peer.transports.get_current_transport();
			if (!transport?.is_ready()) return;

			const notification = create_jsonrpc_notification(method, to_jsonrpc_params(parsed.data));

			try {
				if (should_deliver) {
					if (!is_filterable_broadcast_transport(transport)) {
						log?.error(
							`[${method}] should_deliver set but transport ${transport.transport_name} does not support per-connection filtering`,
						);
						return;
					}
					transport.broadcast_filtered(notification, (identity) =>
						should_deliver(identity, method, parsed.data),
					);
					return;
				}

				const result = await transport.send(notification);
				if (result !== null) {
					log?.error(`[${method}] failed to send notification:`, result.error);
				}
			} catch (error) {
				log?.error(`[${method}] unexpected error:`, error);
			}
		};
	}

	return api as unknown as TApi;
};
