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

import type {ActionAuth, RequestResponseActionSpec} from './action_spec.js';
import {type RouteContext, type RouteSpec} from '../http/route_spec.js';
import {get_client_ip} from '../http/proxy.js';
import {
	apply_authorization_phase,
	get_request_context,
	has_role,
	input_schema_declares_acting,
	is_actor_implying_auth,
	type RequestActorContext,
	type RequestContext,
} from '../auth/request_context.js';
import {ACCOUNT_ID_KEY, CREDENTIAL_TYPE_KEY, type CredentialType} from '../hono_context.js';
import type {Db} from '../db/db.js';
import {is_null_schema, is_void_schema} from '../http/schema_helpers.js';
import {
	JSONRPC_VERSION,
	JsonrpcRequest,
	type JsonrpcRequestId,
	type JsonrpcErrorCode,
	type JsonrpcErrorObject,
} from '../http/jsonrpc.js';
import {
	jsonrpc_error_messages,
	jsonrpc_error_code_to_http_status,
	http_status_to_jsonrpc_error_code,
	JSONRPC_ERROR_CODES,
} from '../http/jsonrpc_errors.js';
import {
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
} from '../http/error_schemas.js';
import type {RateLimiter} from '../rate_limiter.js';

/**
 * Per-request context provided to RPC action handlers.
 *
 * Extends `RouteContext` with auth identity and logger.
 * `auth` is `RequestContext | null` — handlers for authenticated
 * actions can narrow via the auth middleware guarantee.
 */
export interface ActionContext {
	/** The authenticated identity, or `null` for public routes. */
	auth: RequestContext | null;
	/** The JSON-RPC request ID from the envelope. */
	request_id: JsonrpcRequestId;
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
	 * `permit_offer_expire` cleanup sweep in `auth/cleanup.ts`).
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
	 * (client disconnect on HTTP, socket close on WebSocket). Streaming
	 * handlers should check this for early termination.
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
 * acting actor (`auth: 'keeper' | {role}` or input declaring
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
 * fuz_app's admin + permit-offer actions have neither, so per-pair typing
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
 * acting actor — actions with `auth: 'keeper' | {role}` or inputs that
 * declare `acting?: ActingActor`. The dispatcher's authorization phase
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
 * rpc_actor_action(permit_revoke_action_spec, async (input, ctx) => {
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

const jsonrpc_error_response = (
	id: JsonrpcRequestId | null,
	error: JsonrpcErrorObject,
): {jsonrpc: string; id: JsonrpcRequestId | null; error: JsonrpcErrorObject} => ({
	jsonrpc: JSONRPC_VERSION,
	id,
	error,
});

/**
 * Pre-validation auth gate — fires before input validation so missing
 * credentials short-circuit with `unauthenticated` instead of leaking
 * a `invalid_params` error for methods with required input.
 *
 * Reads `c.var.auth_account_id` (set by the auth middleware). Returns
 * `unauthenticated` when `auth !== 'public'` and no account is on the
 * request. Role / keeper checks are deferred until after the
 * authorization phase populates the request context — see
 * `check_action_auth_post_authorization`.
 *
 * @returns a JSON-RPC error object if no account is on the request, or `null`
 */
const check_action_auth_pre_validation = (
	auth: ActionAuth,
	account_id: string | null,
): JsonrpcErrorObject | null => {
	if (auth === 'public') return null;
	if (account_id == null) return jsonrpc_error_messages.unauthenticated();
	return null;
};

/**
 * Post-authorization auth gate — fires after the dispatcher's authorization
 * phase has populated `REQUEST_CONTEXT_KEY` with the resolved actor +
 * permits. Enforces `role` and `keeper` requirements; `'public'` and
 * `'authenticated'` already cleared the pre-validation gate.
 *
 * @returns a JSON-RPC error object if permit / credential check fails, or `null`
 */
const check_action_auth_post_authorization = (
	auth: ActionAuth,
	request_context: RequestContext | null,
	credential_type: CredentialType | null,
): JsonrpcErrorObject | null => {
	if (auth === 'public' || auth === 'authenticated') return null;
	if (auth === 'keeper') {
		// keeper requires daemon_token credential type AND the keeper role.
		// API tokens and session cookies cannot access keeper actions even
		// if the account has the keeper permit. Attach the credential type
		// under `data` so clients can distinguish "wrong credential shape"
		// from "missing keeper role" — mirrors REST 403 semantics.
		if (credential_type !== 'daemon_token' || !has_role(request_context, 'keeper')) {
			return jsonrpc_error_messages.forbidden('forbidden', {
				reason: ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
				credential_type,
			});
		}
		return null;
	}
	// role check — attach `required_role` under `data.required_role` so
	// clients can render targeted copy (matches the former REST `PermissionError`
	// shape that exposed `required_role` as a top-level field).
	if (!has_role(request_context, auth.role)) {
		return jsonrpc_error_messages.forbidden(`requires role: ${auth.role}`, {
			reason: ERROR_INSUFFICIENT_PERMISSIONS,
			required_role: auth.role,
		});
	}
	return null;
};

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
 *    auth requires permits or its input declares `acting?: ActingActor`)
 *    and build the request context. Runs before input validation so
 *    permit-grain auth checks return 403 before 400 invalid_params;
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

	const action_map = new Map<string, RpcAction>();
	for (const action of actions) {
		if (action_map.has(action.spec.method)) {
			throw new Error(`Duplicate RPC action method: ${action.spec.method}`);
		}
		if (is_null_schema(action.spec.input)) {
			throw new Error(
				`RPC action "${action.spec.method}" uses z.null() for input — JSON-RPC 2.0 §4.2 forbids "params": null on the wire (must be omitted or be a Structured value). Use z.void() for parameterless methods.`,
			);
		}
		// Reject account-keyed rate limiting on public actions — there's no
		// actor post-auth, so the account bucket has no key to consume.
		if (
			(action.spec.rate_limit === 'account' || action.spec.rate_limit === 'both') &&
			action.spec.auth === 'public'
		) {
			throw new Error(
				`RPC action "${action.spec.method}" declares rate_limit: '${action.spec.rate_limit}' but auth: 'public' — no actor available for account-keyed limiting. Use 'ip' or change auth.`,
			);
		}
		action_map.set(action.spec.method, action);
	}

	/**
	 * Core dispatcher — shared by GET and POST handlers.
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
		// step 2: lookup method
		const action = action_map.get(method_name);
		if (!action) {
			const error = jsonrpc_error_response(
				id,
				jsonrpc_error_messages.method_not_found(method_name),
			);
			return c.json(error, jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.method_not_found));
		}

		// GET restriction: only side_effects:false actions
		if (restrict_to_reads && action.spec.side_effects) {
			const error = jsonrpc_error_response(
				id,
				jsonrpc_error_messages.invalid_request({
					reason: `method '${method_name}' has side effects and must use POST`,
				}),
			);
			return c.json(error, jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.invalid_request));
		}

		// step 3: pre-validation auth — short-circuit with `unauthenticated`
		// when no account is on the request before input validation runs,
		// so callers without credentials don't see `invalid_params` for
		// methods with required input.
		const action_auth = action.spec.auth;
		const account_id: string | null = c.get(ACCOUNT_ID_KEY) ?? null;
		const pre_validation_auth_error = check_action_auth_pre_validation(action_auth, account_id);
		if (pre_validation_auth_error) {
			const error = jsonrpc_error_response(id, pre_validation_auth_error);
			return c.json(error, jsonrpc_error_code_to_http_status(pre_validation_auth_error.code));
		}

		// step 4: authorization phase — resolves the acting actor and
		// builds the request context. Runs before input validation so
		// permit-grain auth checks (`role` / `keeper`) surface 403
		// before 400 invalid_params. `acting` is read from raw params
		// (string typeguard) so multi-actor callers can still pick a
		// persona without paying for full validation up front; an
		// invalid `acting` shape will be rejected by step 5's input
		// validation if it survives the authorization probe.
		//
		// Resolution failures come back as `{status, body}` so this
		// dispatcher can fold them into a JSON-RPC error envelope —
		// REST emits the same `body` directly. The reason string lands
		// on `error.message` and `error.data.reason`; remaining
		// diagnostic fields (e.g. `available[]` for `actor_required`)
		// flatten under `error.data` so wire callers see structured
		// data instead of a status-coded synthetic envelope.
		if (action_auth !== 'public') {
			const declares_acting = input_schema_declares_acting(action.spec.input);
			const needs_actor = is_actor_implying_auth(action_auth) || declares_acting;
			const raw_acting =
				declares_acting && typeof raw_params === 'object' && raw_params !== null
					? (raw_params as {acting?: unknown}).acting
					: undefined;
			const acting_value = typeof raw_acting === 'string' ? raw_acting : undefined;
			const failure = await apply_authorization_phase({db: route.db}, c, needs_actor, acting_value);
			if (failure) {
				// `error.code` comes from `http_status_to_jsonrpc_error_code(failure.status)` so the
				// wire shape stays uniform with every other JSON-RPC failure path. The 400 mapping
				// lands on `invalid_params` even though `actor_required` / `actor_not_on_account`
				// are not strictly "params malformed" failures — the alternative would be inventing
				// a JSON-RPC code outside the http-status mapping just for these two reasons. The
				// slight semantic mismatch is acceptable because consumers key on
				// `error.data.reason`, never on `error.code` (the in-tree consumers — zzz, tx,
				// visiones, mageguild — never match on the actor reason strings via `error.code`).
				// The 500 mapping (`internal_error`) for `no_actors_on_account` / `account_vanished`
				// is on-the-nose.
				const {error: reason, ...rest} = failure.body;
				const code = http_status_to_jsonrpc_error_code(failure.status);
				const error = jsonrpc_error_response(id, {
					code,
					message: reason,
					data: {reason, ...rest},
				});
				return c.json(error, failure.status);
			}
		}

		// step 5: post-authorization auth — gate role / keeper requirements
		// against the request context populated by the authorization phase.
		const request_context = get_request_context(c);
		const credential_type: CredentialType | null = c.get(CREDENTIAL_TYPE_KEY) ?? null;
		const post_authorization_auth_error = check_action_auth_post_authorization(
			action_auth,
			request_context,
			credential_type,
		);
		if (post_authorization_auth_error) {
			const error = jsonrpc_error_response(id, post_authorization_auth_error);
			return c.json(error, jsonrpc_error_code_to_http_status(post_authorization_auth_error.code));
		}

		// step 6: validate params
		// Missing `params` on the envelope maps to `undefined` for `z.void()`
		// input schemas and `{}` for object inputs (matches HTTP's "empty
		// body = empty object" convention so callers of all-optional-object
		// RPC methods can omit `params` on the wire). JSON-RPC 2.0 §4.2
		// forbids `params: null`, so `z.void()` is the spec-correct schema
		// for parameterless methods — registration above rejects `z.null()`
		// inputs to keep this branch from having to consider that legacy
		// shape. When `raw_params` is present it flows through unchanged so
		// contract-violating shapes still fail validation.
		const params = is_void_schema(action.spec.input) ? raw_params : (raw_params ?? {});
		const parse_result = action.spec.input.safeParse(params);
		if (!parse_result.success) {
			const error = jsonrpc_error_response(
				id,
				jsonrpc_error_messages.invalid_params('invalid params', {
					issues: parse_result.error.issues,
				}),
			);
			return c.json(error, jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.invalid_params));
		}

		// step 7: rate limit — throttle-requests semantics (record on every
		// invocation, no success-reset). Suits admin mutation oracles where
		// the *successful* call is the threat. Different from REST login's
		// throttle-failures pattern that resets on success. Silent partial
		// enforcement: a key is checked iff its bucket's limiter is wired —
		// `rate_limit: 'both'` with only one limiter set runs only that side.
		// Account-keyed limiting bills the authenticated account: every
		// authenticated action has `request_context.account.id`, regardless
		// of whether an actor was resolved.
		const rate_limit = action.spec.rate_limit;
		const client_ip = get_client_ip(c);
		if (rate_limit) {
			const ip_check = action_ip_rate_limiter && (rate_limit === 'ip' || rate_limit === 'both');
			const account_check =
				action_account_rate_limiter &&
				request_context &&
				(rate_limit === 'account' || rate_limit === 'both');
			const reject = (retry_after: number): Response => {
				const error = jsonrpc_error_response(
					id,
					jsonrpc_error_messages.rate_limited('rate limited', {retry_after}),
				);
				return c.json(error, jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.rate_limited));
			};
			if (ip_check) {
				const result = action_ip_rate_limiter.check(client_ip);
				if (!result.allowed) return reject(result.retry_after);
			}
			if (account_check) {
				const result = action_account_rate_limiter.check(request_context.account.id);
				if (!result.allowed) return reject(result.retry_after);
			}
			if (ip_check) action_ip_rate_limiter.record(client_ip);
			if (account_check) action_account_rate_limiter.record(request_context.account.id);
		}

		// step 8: dispatch — transaction for mutations, pool for reads
		const use_transaction = action.spec.side_effects;

		const notify = (notify_method: string, _notify_params: unknown): void => {
			if (DEV) {
				log.warn(
					`ctx.notify('${notify_method}') called on non-streaming transport; notification dropped (method=${method_name})`,
				);
			}
		};
		const signal = c.req.raw.signal;

		const execute = async (db: Db): Promise<Response> => {
			const action_context: ActionContext = {
				auth: request_context,
				request_id: id,
				db,
				background_db: route.background_db,
				pending_effects: route.pending_effects,
				client_ip,
				log,
				notify,
				signal,
			};

			const output = await action.handler(parse_result.data, action_context);

			// DEV-only output validation — logs an error on mismatch, does not throw.
			if (DEV) {
				const output_result = action.spec.output.safeParse(output);
				if (!output_result.success) {
					log.error(`RPC output schema mismatch: ${method_name}`, output_result.error.issues);
				}
			}

			return c.json({jsonrpc: JSONRPC_VERSION, id, result: output});
		};

		// error handling wraps the transaction boundary so handler throws
		// cause rollback before the error is formatted as a JSON-RPC response
		try {
			if (use_transaction) {
				return await route.db.transaction((tx) => execute(tx));
			}
			return await execute(route.db);
		} catch (err) {
			// Duck-type check: Error with numeric `code` signals a JSON-RPC error.
			// Avoids instanceof which fails when consumers throw their own ThrownJsonrpcError
			// (structurally identical but different class identity, e.g. zzz's copy).
			const error_like = err as {code?: unknown; data?: unknown};
			if (err instanceof Error && typeof error_like.code === 'number') {
				const code = error_like.code as JsonrpcErrorCode;
				const status = jsonrpc_error_code_to_http_status(code);
				const error_json: JsonrpcErrorObject = {code, message: err.message};
				if (error_like.data !== undefined) error_json.data = error_like.data;
				return c.json(jsonrpc_error_response(id, error_json), status);
			}
			// generic error
			log.error(`Unhandled RPC handler error: ${method_name}`, err);
			const message = DEV && err instanceof Error ? err.message : 'internal server error';
			return c.json(
				jsonrpc_error_response(id, jsonrpc_error_messages.internal_error(message)),
				500,
			);
		}
	};

	// POST handler — parse JSON-RPC envelope from body
	const post_handler = async (c: Context, route: RouteContext): Promise<Response> => {
		// step 1: parse envelope
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			const error = jsonrpc_error_response(null, jsonrpc_error_messages.parse_error());
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
			const error = jsonrpc_error_response(
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
			const error = jsonrpc_error_response(
				null,
				jsonrpc_error_messages.invalid_request({reason: 'missing method query parameter'}),
			);
			return c.json(error, 400);
		}

		const id_raw = c.req.query('id');
		if (!id_raw) {
			const error = jsonrpc_error_response(
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
				const error = jsonrpc_error_response(
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
			auth: {type: 'none'}, // per-action auth inside dispatcher
			handler: post_handler,
			description: `JSON-RPC 2.0 endpoint — ${actions.length} method${actions.length === 1 ? '' : 's'}`,
			input: z.null(), // dispatcher owns body parsing; rpc_endpoints surface has the real schemas
			output: z.any(), // varies by method
			transaction: false, // per-action inside dispatcher
		},
		{
			method: 'GET',
			path: endpoint_path,
			auth: {type: 'none'}, // per-action auth inside dispatcher
			handler: get_handler,
			description: `JSON-RPC 2.0 endpoint (cacheable reads) — ${actions.length} method${actions.length === 1 ? '' : 's'}`,
			input: z.null(), // params from query string, validated by dispatcher
			output: z.any(), // varies by method
			transaction: false, // per-action inside dispatcher
		},
	];
};
