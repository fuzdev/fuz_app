/**
 * Shared type surface for the action system — `Action` (the composable
 * `{spec, handler?}` tuple) and re-exports of the canonical `ActionContext`
 * + `ActionHandler` shapes.
 *
 * Sits above `actions/action_spec.ts` (pure Zod schemas) and below the
 * dispatchers (`actions/register_action_ws.ts`, `actions/action_rpc.ts`,
 * `actions/perform_action.ts`). Extracted so the shared protocol actions
 * (e.g. `heartbeat_action`) can name them without pulling in server-only
 * modules.
 *
 * HTTP RPC and WebSocket dispatchers both call into `perform_action`,
 * and both pass the same `ActionContext` to the handler. Consumers
 * inject domain deps via factory closures the same way HTTP RPC
 * factories do (see `auth/standard_rpc_actions.ts`).
 *
 * @module
 */

import type {ActionSpecUnion} from './action_spec.js';
import type {ActionHandler} from './action_rpc.js';

/**
 * A spec paired with its optional handler — the composable unit passed to
 * `register_action_ws` and `create_rpc_client`. The server uses both
 * fields; the client reads only `spec` (the `handler` is ignored,
 * harmless). Shared fuz_app primitives (e.g. `heartbeat_action`) export a
 * complete tuple so consumers spread them into both sides' `actions`
 * arrays without inventing per-repo ping plumbing.
 *
 * Polymorphic on `kind`: `request_response` specs require a handler for
 * dispatch; `remote_notification` specs may declare a stub handler for
 * symmetry but are dispatcher-handled (e.g. `cancel`); `local_call` specs
 * never reach a network dispatcher. The WS dispatcher only invokes
 * handlers on `request_response` actions; everything else is registry-only.
 */
export interface Action<TSpec extends ActionSpecUnion = ActionSpecUnion> {
	spec: TSpec;
	/** Server-side handler — invoked by dispatchers on `request_response` actions. Ignored for client-only specs and dispatcher-handled notifications. */
	handler?: ActionHandler;
}
