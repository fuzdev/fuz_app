/**
 * Single JSON-RPC 2.0 endpoint from action specs.
 *
 * `create_rpc_endpoint` produces `RouteSpec[]` (GET + POST on one path)
 * with an internal dispatcher. Method name lives in the JSON-RPC envelope
 * (POST body or GET query string), not the URL. Auth is checked per-action
 * inside the dispatcher.
 *
 * Handler signature: `(input: TInput, ctx: ActionContext) => TOutput`
 * where `ActionContext` provides auth identity, DB, and framework context.
 *
 * @module
 */

import type {Context} from 'hono';
import {z} from 'zod';
import {DEV} from 'esm-env';
import type {Logger} from '@fuzdev/fuz_util/log.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import type {RequestResponseActionSpec} from './action_spec.js';
import {type RouteContext, type RouteSpec} from '../http/route_spec.js';
import {get_client_ip} from '../http/proxy.js';
import {
	get_request_context,
	type RequestActorContext,
	type RequestContext,
} from '../auth/request_context.js';
import {ACCOUNT_ID_KEY, CREDENTIAL_TYPE_KEY, TEST_CONTEXT_PRESET_KEY} from '../hono_context.js';
import type {Db} from '../db/db.js';
import {compile_action_registry} from './compile_action_registry.js';
import {
	JSONRPC_VERSION,
	JsonrpcRequest,
	type JsonrpcRequestId,
	type JsonrpcErrorObject,
} from '../http/jsonrpc.js';
import {
	jsonrpc_error_messages,
	jsonrpc_error_code_to_http_status,
	JSONRPC_ERROR_CODES,
} from '../http/jsonrpc_errors.js';
import type {RateLimiter} from '../rate_limiter.js';
import {perform_action, perform_action_result_to_envelope} from './perform_action.js';

/**
 * Per-request context provided to action handlers across every transport
 * (HTTP RPC, WebSocket, REST bridge). Built once per dispatched action by
 * `perform_action` and threaded into the handler.
 *
 * `auth` is `RequestContext | null` — handlers for authenticated actions
 * can narrow via the dispatcher's authorization-phase guarantee.
 *
 * Post-Phase-4 unification: this is the only handler context shape. The
 * pre-Phase-4 `BaseHandlerContext` (request_id + connection_id + notify +
 * signal) and `extend_context` mechanism are gone; consumers inject
 * domain deps via factory closures the same way HTTP RPC factories
 * already do.
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
	/** Transaction-scoped for mutations, pool-level for reads. */
	db: Db;
	/** Always pool-level — for fire-and-forget effects that outlive the transaction. */
	background_db: Db;
	/** Fire-and-forget side effects — push here for post-response flushing. */
	pending_effects: Array<Promise<void>>;
	/**
	 * Resolved client IP from the trusted-proxy middleware — `'unknown'` if the
	 * middleware wasn't in the stack (e.g. WS dispatch) or couldn't resolve.
	 * Thread into `audit_log_fire_and_forget` as `ip: ctx.client_ip` for every
	 * user-initiated action so RPC audit rows match the REST convention. Pass
	 * `null` only for rows written outside a request (e.g. the
	 * `role_grant_offer_expire` cleanup sweep in `auth/cleanup.ts`).
	 */
	client_ip: string;
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
	ctx: ActionContext,
) => TOutput | Promise<TOutput>;

/**
 * `ActionContext` narrowed to a resolved acting actor.
 *
 * Returned to handlers bound via `rpc_actor_action` — the dispatcher's
 * authorization phase has already run for actor-implying auth or
 * `acting`-declaring inputs, so `ctx.auth.actor` is non-null and the
 * handler skips the `require_request_actor(ctx.auth)` narrowing call.
 */
export interface ActionActorContext extends Omit<ActionContext, 'auth'> {
	auth: RequestActorContext;
}

/**
 * Handler function for an RPC action whose dispatcher always resolves an
 * acting actor — actions with `auth.actor === 'required'` (which by
 * registry-time invariant 2 biconditionally implies the input declares
 * `acting?: ActingActor`). Mirrors `ActionHandler` but tightens the
 * `ctx.auth` slot to the non-null `RequestActorContext`.
 */
export type ActorActionHandler<TInput = any, TOutput = any> = (
	input: TInput,
	ctx: ActionActorContext,
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
 * Pair a spec with a handler while preserving per-method input/output types.
 *
 * Constructing `{spec, handler}` literals widens `handler` to
 * `ActionHandler<any, any>`, so spec/handler drift (renamed Zod schema,
 * output field removal, input shape change) slips past the typechecker.
 * `rpc_action(spec, handler)` binds the handler signature to
 * `(input: z.infer<spec.input>, ctx) => z.infer<spec.output>` via the
 * generic spec parameter — drift surfaces at the call site.
 *
 * Fits fuz_app's factory-closure pattern (handlers close over
 * `grantable_roles`, `app_settings` ref, `notification_sender`, etc.).
 * zzz uses a different shape — a codegen-keyed `Record<Method, Handler>`
 * map typed via generated `ActionInputs`/`ActionOutputs` — which works when
 * handlers are pure (no closure state) and specs are codegen-enumerated.
 * fuz_app's admin + role-grant-offer actions have neither, so per-pair typing
 * at the registration site is the right fit.
 */
export const rpc_action = <TSpec extends RequestResponseActionSpec>(
	spec: TSpec,
	handler: ActionHandler<z.infer<TSpec['input']>, z.infer<TSpec['output']>>,
): RpcAction => ({
	spec,
	handler: handler as ActionHandler,
});

/**
 * Variant of `rpc_action` for handlers whose spec always resolves an
 * acting actor — actions with `auth.actor === 'required'` (which by
 * registry-time invariant 2 biconditionally implies the input declares
 * `acting?: ActingActor`). The dispatcher's authorization phase
 * runs before the handler, populates `ctx.auth` with a non-null
 * `RequestActorContext`, and `rpc_actor_action` reflects that
 * guarantee in the handler signature so the handler body skips the
 * `require_request_actor(ctx.auth)` narrowing call (and the bug class
 * where forgetting that call fails open against a `null` actor).
 *
 * The runtime binding is identical to `rpc_action` — both register the
 * same `RpcAction` shape on the action map. Only the compile-time
 * handler signature differs.
 *
 * @example
 * ```ts
 * rpc_actor_action(role_grant_revoke_action_spec, async (input, ctx) => {
 *   // ctx.auth is RequestActorContext — no require_request_actor() needed.
 *   const revoker_id = ctx.auth.actor.id;
 *   // ...
 * });
 * ```
 */
export const rpc_actor_action = <TSpec extends RequestResponseActionSpec>(
	spec: TSpec,
	handler: ActorActionHandler<z.infer<TSpec['input']>, z.infer<TSpec['output']>>,
): RpcAction => ({
	spec,
	handler: handler as ActionHandler,
});

/** Options for `create_rpc_endpoint`. */
export interface CreateRpcEndpointOptions {
	/** Mount path for the endpoint (e.g., `/api/rpc`). */
	path: string;
	/** RPC actions to serve. */
	actions: Array<RpcAction>;
	/** Logger instance for handler context. */
	log: Logger;
	/**
	 * Per-IP rate limiter consulted for actions whose spec declares
	 * `rate_limit: 'ip'` or `'both'`. `null` disables the IP check.
	 * Per-action gate via `action.spec.rate_limit`. Same limiter is
	 * shared with the WebSocket action dispatcher — one budget per
	 * action, not per transport.
	 */
	action_ip_rate_limiter?: RateLimiter | null;
	/**
	 * Per-account rate limiter consulted for actions whose spec declares
	 * `rate_limit: 'account'` or `'both'`. Keyed on
	 * `request_context.account.id` (account-grain — billed to the
	 * authenticated account regardless of which actor was resolved).
	 * `null` disables the account check. Same limiter is shared with the
	 * WebSocket action dispatcher.
	 */
	action_account_rate_limiter?: RateLimiter | null;
}

/**
 * Build a JSON-RPC error envelope for transport-shape errors (envelope
 * parse failures, method-not-found, GET-on-mutation rejections). The
 * dispatch core in `perform_action` returns a `PerformActionResult`
 * directly; this helper covers only the wire-shape errors the HTTP shim
 * emits before / after the core runs.
 */
const jsonrpc_error_envelope = (
	id: JsonrpcRequestId | null,
	error: JsonrpcErrorObject,
): {jsonrpc: string; id: JsonrpcRequestId | null; error: JsonrpcErrorObject} => ({
	jsonrpc: JSONRPC_VERSION,
	id,
	error,
});

/**
 * Single JSON-RPC 2.0 endpoint — the canonical RPC transport binding.
 *
 * Returns two `RouteSpec` entries (GET + POST on the same path) for
 * `apply_route_specs`. The internal dispatcher handles:
 *
 * 1. **Parse envelope** — POST: JSON body as `JsonrpcRequest`. GET: `method`
 *    and `params` from query string.
 * 2. **Lookup method** — find the `RpcAction` by method name.
 * 3. **Pre-validation auth** — short-circuit `unauthenticated` when no
 *    account is on the request, before input validation runs.
 * 4. **Authorization phase** — resolve the acting actor (when the action's
 *    auth requires role_grants or its input declares `acting?: ActingActor`)
 *    and build the request context. Runs before input validation so
 *    role-grant-grain auth checks return 403 before 400 invalid_params;
 *    `acting` is read from raw params via a string typeguard.
 * 5. **Post-authorization auth** — enforce role / keeper requirements
 *    against the request context.
 * 6. **Validate params** — parse input against the action's `input` schema.
 * 7. **Rate limit** — per-action IP / account throttling.
 * 8. **Dispatch** — acquire DB handle (transaction for mutations, pool for reads),
 *    construct `ActionContext`, call handler, return JSON-RPC response.
 *
 * GET is restricted to `side_effects: false` actions (cacheable reads).
 * All errors use JSON-RPC format: `{jsonrpc, id, error: {code, message, data?}}`.
 *
 * The RouteSpecs use `auth: {type: 'none'}` because auth is checked per-action
 * inside the dispatcher, and `transaction: false` because transaction scope
 * is per-action (mutations get a transaction, reads get pool).
 *
 * @param options - endpoint path, actions, and logger
 * @returns route specs (GET + POST) ready for `apply_route_specs`
 * @throws Error if two actions share the same `spec.method` (registration-time
 *   duplicate detection); also throws if any action's `spec.input` is
 *   `z.null()` (JSON-RPC 2.0 §4.2 forbids `params: null` on the wire — use
 *   `z.void()` for parameterless methods).
 */
export const create_rpc_endpoint = (options: CreateRpcEndpointOptions): Array<RouteSpec> => {
	const {
		path: endpoint_path,
		actions,
		log,
		action_ip_rate_limiter = null,
		action_account_rate_limiter = null,
	} = options;

	const {action_map} = compile_action_registry(actions, 'RPC action');

	/**
	 * HTTP-shape dispatch shim — the GET/POST entry points share this:
	 *
	 * 1. Resolve the action by method name (HTTP-shape `method_not_found` envelope).
	 * 2. Reject GET requests for `side_effects: true` actions (HTTP-only constraint).
	 * 3. Hand off to `perform_action` for the post-parse pipeline.
	 * 4. Bind the result to `c.json` — `'ok'` returns the result envelope,
	 *    `'error'` returns the error envelope at the `result.status` HTTP code.
	 *
	 * @param restrict_to_reads - `true` for GET (rejects `side_effects: true` actions)
	 */
	const dispatch = async (
		c: Context,
		route: RouteContext,
		method_name: string,
		raw_params: unknown,
		id: JsonrpcRequestId,
		restrict_to_reads: boolean,
	): Promise<Response> => {
		const action = action_map.get(method_name);
		if (!action) {
			return c.json(
				jsonrpc_error_envelope(id, jsonrpc_error_messages.method_not_found(method_name)),
				jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.method_not_found),
			);
		}

		if (restrict_to_reads && action.spec.side_effects) {
			return c.json(
				jsonrpc_error_envelope(
					id,
					jsonrpc_error_messages.invalid_request({
						reason: `method '${method_name}' has side effects and must use POST`,
					}),
				),
				jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.invalid_request),
			);
		}

		// HTTP RPC has no streaming channel; `ctx.notify` warn-and-drops in DEV.
		const notify = (notify_method: string, _notify_params: unknown): void => {
			if (DEV) {
				log.warn(
					`ctx.notify('${notify_method}') called on non-streaming transport; notification dropped (method=${method_name})`,
				);
			}
		};

		// Test escape hatch: harnesses pre-populate `REQUEST_CONTEXT_KEY` and
		// flag `TEST_CONTEXT_PRESET_KEY = true`. Production middleware never
		// sets the flag; the shim honors it and `perform_action` trusts the
		// pre-baked context instead of running the live authorization phase.
		const preset = c.get(TEST_CONTEXT_PRESET_KEY)
			? {request_context: get_request_context(c)}
			: undefined;

		const result = await perform_action(
			{
				action,
				raw_params,
				request_id: id,
				account_id: c.get(ACCOUNT_ID_KEY) ?? null,
				credential_type: c.get(CREDENTIAL_TYPE_KEY) ?? null,
				client_ip: get_client_ip(c),
				signal: c.req.raw.signal,
				notify,
				preset,
			},
			{
				db: route.db,
				background_db: route.background_db,
				pending_effects: route.pending_effects,
				log,
				action_ip_rate_limiter,
				action_account_rate_limiter,
			},
		);

		const envelope = perform_action_result_to_envelope(id, result);
		if (result.kind === 'error') {
			// `result.status` is one of the JSON-RPC → HTTP status codes the
			// dispatcher emits; Hono types `c.json`'s second arg as
			// `ContentfulStatusCode`, which the cast bridges (the value space
			// is verified by `jsonrpc_error_code_to_http_status`).
			return c.json(envelope, result.status as Parameters<typeof c.json>[1]);
		}
		return c.json(envelope);
	};

	// POST handler — parse JSON-RPC envelope from body
	const post_handler = async (c: Context, route: RouteContext): Promise<Response> => {
		// step 1: parse envelope
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			const error = jsonrpc_error_envelope(null, jsonrpc_error_messages.parse_error());
			return c.json(error, 400);
		}

		const envelope = JsonrpcRequest.safeParse(body);
		if (!envelope.success) {
			// try to extract id even from an invalid envelope
			const raw_id =
				typeof body === 'object' && body !== null && 'id' in body
					? (body as Record<string, unknown>).id
					: null;
			const id = typeof raw_id === 'string' || typeof raw_id === 'number' ? raw_id : null;
			const error = jsonrpc_error_envelope(
				id,
				jsonrpc_error_messages.invalid_request({issues: envelope.error.issues}),
			);
			return c.json(error, 400);
		}

		return dispatch(c, route, envelope.data.method, envelope.data.params, envelope.data.id, false);
	};

	// GET handler — extract method and params from query string
	const get_handler = async (c: Context, route: RouteContext): Promise<Response> => {
		// step 1: parse from query string
		const method_name = c.req.query('method');
		if (!method_name) {
			const error = jsonrpc_error_envelope(
				null,
				jsonrpc_error_messages.invalid_request({reason: 'missing method query parameter'}),
			);
			return c.json(error, 400);
		}

		const id_raw = c.req.query('id');
		if (!id_raw) {
			const error = jsonrpc_error_envelope(
				null,
				jsonrpc_error_messages.invalid_request({reason: 'missing id query parameter'}),
			);
			return c.json(error, 400);
		}

		// parse integer ids so GET ?id=42 matches POST {id: 42} behavior
		// JSON-RPC spec: "Numbers SHOULD NOT contain fractional parts"
		const id_num = Number(id_raw);
		const id: JsonrpcRequestId =
			Number.isInteger(id_num) && String(id_num) === id_raw ? id_num : id_raw;

		// parse params from query string (optional — null input schemas need no params)
		const params_raw = c.req.query('params');
		let params: unknown;
		if (params_raw !== undefined) {
			try {
				params = JSON.parse(params_raw);
			} catch {
				const error = jsonrpc_error_envelope(
					id,
					jsonrpc_error_messages.invalid_params('params query parameter is not valid JSON'),
				);
				return c.json(error, 400);
			}
		}

		return dispatch(c, route, method_name, params, id, true);
	};

	return [
		{
			method: 'POST',
			path: endpoint_path,
			auth: {account: 'none', actor: 'none'}, // per-action auth inside dispatcher
			handler: post_handler,
			description: `JSON-RPC 2.0 endpoint — ${actions.length} method${actions.length === 1 ? '' : 's'}`,
			input: z.null(), // dispatcher owns body parsing; rpc_endpoints surface has the real schemas
			output: z.any(), // varies by method
			transaction: false, // per-action inside dispatcher
		},
		{
			method: 'GET',
			path: endpoint_path,
			auth: {account: 'none', actor: 'none'}, // per-action auth inside dispatcher
			handler: get_handler,
			description: `JSON-RPC 2.0 endpoint (cacheable reads) — ${actions.length} method${actions.length === 1 ? '' : 's'}`,
			input: z.null(), // params from query string, validated by dispatcher
			output: z.any(), // varies by method
			transaction: false, // per-action inside dispatcher
		},
	];
};
