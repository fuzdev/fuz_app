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

import { Logger, type Logger as LoggerType } from '@fuzdev/fuz_util/log.ts';

import { create_jsonrpc_notification, to_jsonrpc_params } from '../http/jsonrpc_helpers.ts';
import type { ActionSpecUnion } from './action_spec.ts';
import type { ConnectionRegistry, ConnectionIdentity } from './connection_registry.ts';

/**
 * What a broadcast is sent through — the fan-out half of
 * `ConnectionRegistry`. A structural `Pick`, so a test or another
 * registry can stand in.
 */
export type BroadcastTarget = Pick<ConnectionRegistry, 'broadcast' | 'broadcast_filtered'>;

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
	connection: Readonly<ConnectionIdentity>,
	method: string,
	input: unknown
) => boolean;

/** Options for `create_broadcast_api`. */
export interface CreateBroadcastApiOptions {
	/**
	 * The connection registry broadcasts go out on — typically the WS endpoint's
	 * `ConnectionRegistry` (`AppServer.ws_endpoints[path]`, or the one a
	 * `WsEndpointSpec.registry` supplies).
	 */
	registry: BroadcastTarget;
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
	 * via the registry's `broadcast_filtered` — each connection's identity is
	 * checked before the message is sent. When unset, the registry broadcasts
	 * unfiltered via `registry.broadcast`.
	 */
	should_deliver?: ShouldDeliverFn;
}

/**
 * Builds a typed broadcast API from a set of action specs.
 *
 * For each spec, adds a method keyed by `spec.method` that:
 * - Validates `input` against the spec's Zod schema (logs and returns on failure)
 * - Creates a JSON-RPC notification from the validated input
 * - Broadcasts on the registry (filtered by `should_deliver` when supplied)
 *
 * A broadcast with no connections reaches nobody and is not an error. Errors
 * during send are logged but never thrown — broadcasts are fire-and-forget from
 * the handler's perspective.
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
 *   registry: app_server.ws_endpoints['/api/ws']!,
 *   specs: [filer_change_action_spec, workspace_changed_action_spec],
 * });
 * ```
 *
 * The cast is unchecked — callers must keep the interface and the `specs`
 * array in sync. Codegen (`action_collections.gen.ts`) is a natural fit
 * if the consumer already generates per-method type maps.
 */
export const create_broadcast_api = <TApi extends object>(
	options: CreateBroadcastApiOptions
): TApi => {
	const { registry, specs, should_deliver } = options;
	const log = options.log === undefined ? new Logger('[broadcast]') : options.log;

	const api: Record<string, (input: unknown) => Promise<void>> = {};

	for (const spec of specs) {
		const { method } = spec;
		const send = (input: unknown): void => {
			const parsed = spec.input.safeParse(input);
			if (!parsed.success) {
				log?.error(`[${method}] input validation failed:`, parsed.error.issues);
				return;
			}

			const notification = create_jsonrpc_notification(method, to_jsonrpc_params(parsed.data));

			try {
				if (should_deliver) {
					registry.broadcast_filtered(notification, (identity) =>
						should_deliver(identity, method, parsed.data)
					);
				} else {
					registry.broadcast(notification);
				}
			} catch (error) {
				log?.error(`[${method}] unexpected error:`, error);
			}
		};
		// the broadcast is synchronous; the method stays `Promise<void>`, the
		// shape `BackendActionsApi` declares
		api[method] = (input: unknown): Promise<void> => {
			send(input);
			return Promise.resolve();
		};
	}

	return api as unknown as TApi;
};
