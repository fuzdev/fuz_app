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

import type {RequestResponseActionSpec} from './action_spec.js';
import {type RouteContext, type RouteSpec} from '../http/route_spec.js';
import {get_client_ip} from '../http/proxy.js';
import {get_request_context, has_role, type RequestContext} from '../auth/request_context.js';
import {CREDENTIAL_TYPE_KEY, type CredentialType} from '../hono_context.js';
import type {Db} from '../db/db.js';
import {is_null_schema} from '../http/schema_helpers.js';
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
	JSONRPC_ERROR_CODES,
} from '../http/jsonrpc_errors.js';
import {
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
} from '../http/error_schemas.js';

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
	 * Use this when emitting forensic audit rows; pass `null` to
	 * `audit_log_fire_and_forget` for events where IP attribution isn't useful
	 * (e.g. admin-initiated mutations against a target account).
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

/** Options for `create_rpc_endpoint`. */
export interface CreateRpcEndpointOptions {
	/** Mount path for the endpoint (e.g., `/api/rpc`). */
	path: string;
	/** RPC actions to serve. */
	actions: Array<RpcAction>;
	/** Logger instance for handler context. */
	log: Logger;
}

/**
 * Format a JSON-RPC error response.
 *
 * @param id - the request id (null if unknown)
 * @param error - the error object
 * @returns a JSON-RPC error response object
 */
const jsonrpc_error_response = (
	id: JsonrpcRequestId | null,
	error: JsonrpcErrorObject,
): {jsonrpc: string; id: JsonrpcRequestId | null; error: JsonrpcErrorObject} => ({
	jsonrpc: JSONRPC_VERSION,
	id,
	error,
});

/**
 * Check auth for an action spec against the request context.
 *
 * @param auth - the action's auth requirement
 * @param request_context - the resolved identity (null if unauthenticated)
 * @param credential_type - how the request was authenticated (session, api_token, daemon_token)
 * @returns an error json if auth fails, or null if authorized
 */
const check_action_auth = (
	auth: RequestResponseActionSpec['auth'],
	request_context: RequestContext | null,
	credential_type: CredentialType | null,
): JsonrpcErrorObject | null => {
	if (auth === 'public') return null;
	if (!request_context) return jsonrpc_error_messages.unauthenticated();
	if (auth === 'authenticated') return null;
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
 * 3. **Auth check** — verify identity against the action's `auth` requirement.
 * 4. **Validate params** — parse input against the action's `input` schema.
 * 5. **Dispatch** — acquire DB handle (transaction for mutations, pool for reads),
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
 */
export const create_rpc_endpoint = (options: CreateRpcEndpointOptions): Array<RouteSpec> => {
	const {path: endpoint_path, actions, log} = options;

	// build action lookup map
	const action_map = new Map<string, RpcAction>();
	for (const action of actions) {
		if (action_map.has(action.spec.method)) {
			throw new Error(`Duplicate RPC action method: ${action.spec.method}`);
		}
		action_map.set(action.spec.method, action);
	}

	/**
	 * Core dispatcher — shared by GET and POST handlers.
	 *
	 * @param c - Hono context
	 * @param route - route context with db and pending_effects
	 * @param method_name - the JSON-RPC method name
	 * @param raw_params - the raw params (parsed from body or query string)
	 * @param id - the request id
	 * @param restrict_to_reads - true for GET requests (reject side_effects actions)
	 * @returns a Response
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
			return c.json(
				error,
				jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.method_not_found) as any,
			);
		}

		// GET restriction: only side_effects:false actions
		if (restrict_to_reads && action.spec.side_effects) {
			const error = jsonrpc_error_response(
				id,
				jsonrpc_error_messages.invalid_request({
					reason: `method '${method_name}' has side effects and must use POST`,
				}),
			);
			return c.json(
				error,
				jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.invalid_request) as any,
			);
		}

		// step 3: auth check
		const request_context = get_request_context(c);
		const credential_type: CredentialType | null = c.get(CREDENTIAL_TYPE_KEY) ?? null;
		const auth_error = check_action_auth(action.spec.auth, request_context, credential_type);
		if (auth_error) {
			const error = jsonrpc_error_response(id, auth_error);
			return c.json(error, jsonrpc_error_code_to_http_status(auth_error.code) as any);
		}

		// step 4: validate params
		const params = raw_params ?? (is_null_schema(action.spec.input) ? null : undefined);
		const parse_result = action.spec.input.safeParse(params);
		if (!parse_result.success) {
			const error = jsonrpc_error_response(
				id,
				jsonrpc_error_messages.invalid_params('invalid params', {
					issues: parse_result.error.issues,
				}),
			);
			return c.json(
				error,
				jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.invalid_params) as any,
			);
		}

		// step 5: dispatch — transaction for mutations, pool for reads
		const use_transaction = action.spec.side_effects;

		const notify = (notify_method: string, _notify_params: unknown): void => {
			if (DEV) {
				log.warn(
					`ctx.notify('${notify_method}') called on non-streaming transport; notification dropped (method=${method_name})`,
				);
			}
		};
		const signal = c.req.raw.signal;

		const client_ip = get_client_ip(c);

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
			if (err instanceof Error && typeof (err as any).code === 'number') {
				const code = (err as any).code as JsonrpcErrorCode;
				const data = (err as any).data;
				const status = jsonrpc_error_code_to_http_status(code);
				const error_json: JsonrpcErrorObject = {code, message: err.message};
				if (data !== undefined) error_json.data = data;
				return c.json(jsonrpc_error_response(id, error_json), status as any);
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
