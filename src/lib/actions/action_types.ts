/**
 * Shared type surface for the action system — `Action` (the composable
 * `{spec, handler?}` tuple), the handler context `ActionContext` and its
 * narrowed tiers, the handler signatures, `RpcAction`, and the `rpc_action`
 * binder.
 *
 * Sits above `actions/action_spec.ts` (pure Zod schemas) and below the
 * dispatchers (`actions/register_action_ws.ts`, `actions/action_rpc.ts`,
 * `actions/perform_action.ts`). Extracted so the shared protocol actions
 * (e.g. `heartbeat_action`) and every action factory can name them without
 * pulling in server-only modules — everything here is type-only but the
 * identity-function binder.
 *
 * HTTP RPC and WebSocket dispatchers both call into `perform_action`,
 * and both pass the same `ActionContext` to the handler. Consumers
 * inject domain deps via factory closures the same way HTTP RPC
 * factories do (see `auth/standard_rpc_actions.ts`).
 *
 * @module
 */

import type { z } from 'zod';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { ActionSpecUnion, RequestResponseActionSpec } from './action_spec.ts';
import type { Uuid } from '../primitive_schemas.ts';
import type { RequestActorContext, RequestContext } from '../auth/request_context.ts';
import type { BuiltinCredentialType } from '../auth/credential_type_schema.ts';
import type { Db } from '../db/db.ts';
import type { JsonrpcRequestId } from '../http/jsonrpc.ts';
import type { RequestClient } from './peer_request.ts';

/**
 * A spec paired with its optional handler — the composable unit passed to
 * `register_action_ws` and `create_rpc_client`. The server uses both
 * fields; the client reads only `spec` (the `handler` is ignored,
 * harmless). Shared fuz_app primitives (e.g. `heartbeat_action`) export a
 * complete tuple so consumers spread them into both sides' `actions`
 * arrays without inventing per-repo ping plumbing.
 *
 * Polymorphic on `kind`: `request_response` specs require a handler for
 * dispatch; `remote_notification` specs are dispatcher-handled (e.g.
 * `cancel`, which has no handler); `local_call` specs
 * never reach a network dispatcher. The WS dispatcher only invokes
 * handlers on `request_response` actions; everything else is registry-only.
 */
export interface Action<TSpec extends ActionSpecUnion = ActionSpecUnion> {
	spec: TSpec;
	/** Server-side handler — invoked by dispatchers on `request_response` actions. Ignored for client-only specs and dispatcher-handled notifications. */
	handler?: ActionHandler;
}

/**
 * Per-request context provided to action handlers across every transport
 * (HTTP RPC and WebSocket). Built once per dispatched action by
 * `perform_action` and threaded into the handler.
 *
 * `auth` is `RequestContext | null` — handlers for authenticated actions
 * can narrow via the dispatcher's authorization-phase guarantee.
 *
 * Single handler context shape across every transport. Consumers inject
 * domain deps via factory closures the same way HTTP RPC factories do.
 */
export interface ActionContext {
	/** The authenticated identity, or `null` for public routes. */
	auth: RequestContext | null;
	/** The JSON-RPC request ID from the envelope. */
	request_id: JsonrpcRequestId;
	/**
	 * Stable per-socket connection id on WebSocket transport; `undefined`
	 * on HTTP RPC. Consumers key per-connection domain state on this
	 * directly; HTTP handlers ignore it.
	 */
	connection_id?: Uuid;
	/**
	 * Initiate a JSON-RPC request to the originating client and await its typed
	 * reply — the server→client direction of ActionPeer. Present only on the
	 * WebSocket transport (it targets the originating socket); `undefined` on
	 * HTTP RPC, where there is no return socket. Handlers that depend on it
	 * must handle its absence — e.g. `peer/ping` surfaces `peer_no_transport`.
	 */
	request_client?: RequestClient;
	/**
	 * Transaction-scoped when `spec.side_effects` is true (the dispatcher
	 * wraps in `db.transaction`); pool-level otherwise. Handlers that
	 * need rollback-resilient writes call `deps.audit.emit(ctx, input)`,
	 * which captures the pool inside its closure.
	 */
	db: Db;
	/**
	 * Eager fire-and-forget queue — push the in-flight `Promise<void>` for
	 * pool writes already running (audit emits, api-token usage
	 * tracking). Drained via `flush_pending_effects` after the
	 * handler returns.
	 */
	pending_effects: Array<Promise<void>>;
	/**
	 * Deferred post-commit thunks — do not push directly; reach for
	 * `emit_after_commit(ctx, fn)` from `http/pending_effects.ts`. The flush
	 * site invokes each thunk after the handler (and any wrapping
	 * `db.transaction`) returns.
	 */
	post_commit_effects: Array<() => void | Promise<void>>;
	/**
	 * Resolved client IP from the trusted-proxy middleware — `'unknown'` if the
	 * middleware wasn't in the stack (e.g. WS dispatch) or couldn't resolve.
	 * Thread into `deps.audit.emit` as `ip: ctx.client_ip` for every
	 * user-initiated action so RPC audit rows match the REST convention. Pass
	 * `null` only for rows written outside a request (e.g. the
	 * `role_grant_offer_expire` cleanup sweep in `auth/cleanup.ts`).
	 */
	client_ip: string;
	/**
	 * Credential channel the request arrived on (`'session'` | `'api_token'` |
	 * `'daemon_token'`), or `null` for anonymous requests. Same value the
	 * dispatcher's `credential_types` gate consumed at step 3 — exposed here
	 * so handlers can record it in audit metadata (defense in depth: the
	 * gate may be loosened or bypassed in a future refactor, but the audit
	 * row preserves what actually authenticated the request).
	 */
	credential_type: BuiltinCredentialType | null;
	/** Logger instance. */
	log: Logger;
	/**
	 * Send a request-scoped JSON-RPC notification to the originator.
	 *
	 * On streaming transports (WebSocket) this routes to the originating
	 * connection only. On the HTTP RPC transport this is a no-op with a
	 * DEV-mode warn — non-streaming transports have no channel for mid-
	 * request notifications. The `streams` field on an `ActionSpec` names
	 * the notification method this handler is expected to emit.
	 */
	notify: (method: string, params: unknown) => void;
	/**
	 * AbortSignal that fires when the originating request is cancelled
	 * (client disconnect on HTTP, socket close or per-request cancel
	 * notification on WebSocket). Streaming handlers should check this
	 * for early termination.
	 */
	signal: AbortSignal;
}

/**
 * Handler function for an RPC action.
 *
 * Receives validated input and an `ActionContext` with per-request deps.
 * Returns the output value (serialized to JSON by the wrapper).
 */
export type ActionHandler<TInput = any, TOutput = any> = (
	input: TInput,
	ctx: ActionContext
) => TOutput | Promise<TOutput>;

/**
 * `ActionContext` narrowed to a non-null `RequestContext`.
 *
 * Used by handlers whose spec declares `auth.account === 'required'`
 * (with `auth.actor === 'none'`) — the dispatcher's pre-authorization 401
 * gate guarantees `request_context` is populated before the handler
 * runs, but the actor slot stays null because no `acting` resolution
 * happened. Selected automatically by `rpc_action`'s conditional return
 * type for the account-grain tier.
 */
export interface ActionAuthContext extends Omit<ActionContext, 'auth'> {
	auth: RequestContext;
}

/**
 * Handler signature for an account-grain RPC action — `auth.account === 'required'`
 * and `auth.actor === 'none'`. Mirrors `ActionHandler` but tightens the
 * `ctx.auth` slot to the non-null `RequestContext` (with `actor: null`).
 */
export type AuthActionHandler<TInput = any, TOutput = any> = (
	input: TInput,
	ctx: ActionAuthContext
) => TOutput | Promise<TOutput>;

/**
 * `ActionContext` narrowed to a resolved acting actor.
 *
 * Used by handlers whose spec declares `auth.actor === 'required'` —
 * the dispatcher's authorization phase resolves an actor (per
 * registry-time invariant 2 the input declares `acting?: ActingActor`),
 * so `ctx.auth.actor` is non-null. Selected automatically by
 * `rpc_action`'s conditional return type for the actor-implying tier.
 */
export interface ActionActorContext extends Omit<ActionContext, 'auth'> {
	auth: RequestActorContext;
}

/**
 * Handler signature for an actor-implying RPC action — `auth.actor === 'required'`.
 * Mirrors `ActionHandler` but tightens the `ctx.auth` slot to the
 * non-null `RequestActorContext` (with non-null `actor`).
 */
export type ActorActionHandler<TInput = any, TOutput = any> = (
	input: TInput,
	ctx: ActionActorContext
) => TOutput | Promise<TOutput>;

/**
 * An RPC action — combines an action spec with its handler.
 *
 * The spec defines the contract (method, auth, schemas, side effects).
 * The handler implements the behavior.
 */
export interface RpcAction {
	spec: RequestResponseActionSpec;
	handler: ActionHandler;
}

/**
 * Conditional handler shape for `rpc_action` — picks the narrowest
 * `ctx.auth` type the dispatcher's runtime guarantee allows:
 *
 * - `auth.actor === 'required'` → `ActorActionHandler` (`ctx.auth: RequestActorContext`).
 * - `auth.account === 'required' && auth.actor === 'none'` → `AuthActionHandler` (`ctx.auth: RequestContext`).
 * - else (public, optional axes) → `ActionHandler` (`ctx.auth: RequestContext | null`).
 *
 * The bracketed form `[T] extends ['required']` defeats distributive
 * conditionals so a degraded `AuthAxisState` union (when the spec was
 * typed without preserving its literal) falls through to the loosest
 * tier instead of collapsing to the narrowest.
 */
export type HandlerForSpec<TSpec extends RequestResponseActionSpec> = [
	TSpec['auth']['actor']
] extends ['required']
	? ActorActionHandler<z.infer<TSpec['input']>, z.infer<TSpec['output']>>
	: [TSpec['auth']['account']] extends ['required']
		? AuthActionHandler<z.infer<TSpec['input']>, z.infer<TSpec['output']>>
		: ActionHandler<z.infer<TSpec['input']>, z.infer<TSpec['output']>>;

/**
 * Pair a spec with a handler while preserving per-method input/output types
 * and selecting the narrowest `ctx.auth` shape the spec literal admits.
 *
 * Constructing `{spec, handler}` literals widens `handler` to
 * `ActionHandler<any, any>`, so spec/handler drift (renamed Zod schema,
 * output field removal, input shape change) slips past the typechecker.
 * `rpc_action(spec, handler)` binds the handler signature to
 * `(input: z.infer<spec.input>, ctx) => z.infer<spec.output>` via the
 * generic spec parameter — drift surfaces at the call site.
 *
 * The `ctx.auth` narrowing follows the spec's `auth.account` /
 * `auth.actor` literals (see `HandlerForSpec`): an actor-implying spec
 * gets `ctx.auth: RequestActorContext`; an account-grain spec gets
 * `ctx.auth: RequestContext`; everything else stays `ctx.auth:
 * RequestContext | null`. Handlers can rely on the dispatcher's
 * runtime guarantee without a manual narrowing call.
 *
 * Fits fuz_app's factory-closure pattern (handlers close over
 * `grantable_roles`, `app_settings` ref, `notification_sender`, etc.).
 * zzz uses a different shape — a codegen-keyed `Record<Method, Handler>`
 * map typed via generated `ActionInputs`/`ActionOutputs` — which works when
 * handlers are pure (no closure state) and specs are codegen-enumerated.
 * fuz_app's admin + role-grant-offer actions have neither, so per-pair typing
 * at the registration site is the right fit.
 *
 * Spec-literal preservation is load-bearing: declare specs with
 * `satisfies RequestResponseActionSpec` (canonical) so `auth.actor`
 * keeps its `'required'` / `'none'` literal type. A spec typed
 * directly as `RequestResponseActionSpec` widens the axes to
 * `AuthAxisState` and the handler defaults to the loosest tier — sound,
 * but loses the ergonomic narrowing.
 *
 * @example
 * ```ts
 * // actor-implying spec → ctx.auth: RequestActorContext
 * rpc_action(role_grant_revoke_action_spec, async (input, ctx) => {
 *   const revoker_id = ctx.auth.actor.id; // no narrowing needed
 * });
 *
 * // account-grain spec → ctx.auth: RequestContext (actor: null)
 * rpc_action(account_verify_action_spec, (_input, ctx) => {
 *   return to_session_account(ctx.auth.account); // no narrowing needed
 * });
 * ```
 */
export const rpc_action = <TSpec extends RequestResponseActionSpec>(
	spec: TSpec,
	handler: HandlerForSpec<TSpec>
): RpcAction => ({
	spec,
	handler: handler as ActionHandler
});
