/**
 * Shared registration loop for action-dispatcher endpoints.
 *
 * `create_rpc_endpoint` (HTTP RPC) and `register_action_ws` (WebSocket)
 * both build a `Map<method, RpcAction>` from a list of action specs and
 * gate the build on the same registry-time invariants:
 *
 * 1. **Auth-shape biconditional** — per `assert_route_auth_acting_biconditional`
 *    in `auth/request_context.ts`: `auth.actor !== 'none' ⟺ input declares
 *    acting?: ActingActor`. Fires for every spec with non-null auth.
 * 2. **Rate-limit / account axis** — `rate_limit: 'account' | 'both'`
 *    requires `auth.account === 'required'`; without an account on the
 *    request there is no key for the per-account bucket.
 * 3. **JSON-RPC §4.2 wire validity** — `request_response` specs whose
 *    handler will reach the dispatch map must not use `z.null()` for
 *    input (the wire format forbids `"params": null`; use `z.void()`
 *    for parameterless methods).
 * 4. **Duplicate method names** — JSON-RPC keys on `method`, so every
 *    spec in the array must declare a unique `method` regardless of
 *    kind / handler presence.
 *
 * Pre-consolidation each dispatcher inlined these checks; the comment
 * in `register_action_ws.ts` literally said "mirrors the HTTP RPC
 * registration check" but nothing kept them mirrored. Centralizing the
 * loop closes the most likely future drift surface.
 *
 * @module
 */

import type {Action} from './action_types.js';
import type {RpcAction} from './action_rpc.js';
import {assert_route_auth_acting_biconditional} from '../auth/request_context.js';
import {is_null_schema} from '../http/schema_helpers.js';

/** Result returned by `compile_action_registry`. */
export interface ActionRegistryCompileResult {
	/**
	 * Method → `RpcAction` lookup for dispatch. Only `request_response`
	 * specs with a handler land here — kind-polymorphic input arrays
	 * (the WebSocket dispatcher's `actions: ReadonlyArray<Action>`)
	 * pass `remote_notification` / handler-less specs through unchanged.
	 */
	action_map: Map<string, RpcAction>;
}

/**
 * Validate registry-time invariants and build the dispatcher's
 * method → action lookup.
 *
 * @param actions - polymorphic action array; HTTP RPC passes `RpcAction[]` (narrower), WebSocket passes `Action[]` (kind-polymorphic — handler-less notification specs are accepted)
 * @param ctx_label - per-spec error-message prefix, e.g. `'RPC action'` or `'WS action'`. Combined with the spec method as `${ctx_label} "${method}"`.
 * @throws Error on biconditional violation, rate-limit/account-axis mismatch, JSON-RPC null-input, or duplicate method.
 */
export const compile_action_registry = (
	actions: ReadonlyArray<Action>,
	ctx_label: string,
): ActionRegistryCompileResult => {
	const action_map: Map<string, RpcAction> = new Map();
	const seen_methods: Set<string> = new Set();
	for (const action of actions) {
		const {spec} = action;
		const ctx = `${ctx_label} "${spec.method}"`;
		if (seen_methods.has(spec.method)) {
			throw new Error(`Duplicate ${ctx_label} method: ${spec.method}`);
		}
		seen_methods.add(spec.method);
		// Auth-shape invariants apply to any spec with non-null auth (which
		// per the spec union means `kind === 'request_response'`).
		if (spec.auth !== null) {
			assert_route_auth_acting_biconditional(spec.auth, spec.input, ctx);
			if (
				(spec.rate_limit === 'account' || spec.rate_limit === 'both') &&
				spec.auth.account !== 'required'
			) {
				throw new Error(
					`${ctx} declares rate_limit: '${spec.rate_limit}' but auth.account !== 'required' — no account guaranteed for account-keyed limiting. Use 'ip' or set auth.account: 'required'.`,
				);
			}
		}
		// Only request_response specs with a handler reach the dispatch
		// map. Notifications (e.g. WS `cancel`) and handler-less specs
		// stay registry-only and bypass JSON-RPC wire-validity checks.
		if (spec.kind === 'request_response' && action.handler) {
			if (is_null_schema(spec.input)) {
				throw new Error(
					`${ctx} uses z.null() for input — JSON-RPC 2.0 §4.2 forbids "params": null on the wire. Use z.void() for parameterless methods.`,
				);
			}
			action_map.set(spec.method, {spec, handler: action.handler});
		}
	}
	return {action_map};
};
