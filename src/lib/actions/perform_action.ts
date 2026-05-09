/**
 * Transport-agnostic dispatch core shared by HTTP RPC and WebSocket
 * action dispatchers.
 *
 * `perform_action` runs the post-parse pipeline that every action-spec
 * handler must traverse:
 *
 * 1. **Pre-validation auth (401)** — short-circuits unauthenticated callers
 *    on `'required'` axes before input validation runs, so callers never
 *    see `invalid_params` for methods with required input.
 * 2. **Validate params (400)** — `spec.input.safeParse(raw_params)` with
 *    the same `z.void()` / `?? {}` rules the HTTP RPC dispatcher applied
 *    pre-Step-4. The validated input lands inside the function so the
 *    authorization phase reads `acting` as a typed Zod field.
 * 3. **Authorization phase** — when `auth.actor !== 'none'` (or
 *    `auth.account !== 'none' && actor === 'none'`), resolves the actor
 *    via `apply_authorization_phase` against the supplied `account_id`
 *    plus `validated_input.acting`. Failures fold into a JSON-RPC error
 *    envelope. The test-harness escape hatch lives in the caller — pass
 *    `preset.request_context` to skip the live phase and use a pre-baked
 *    context instead.
 * 4. **Post-authorization auth (403)** — gates `auth.credential_types` and
 *    `auth.roles` against the resolved context.
 * 5. **Rate limit (429)** — per-action IP / account throttling, throttle-
 *    requests semantics (every invocation records, regardless of outcome).
 * 6. **Dispatch + DEV-only output validation + error normalization** —
 *    `spec.side_effects` picks transaction (`deps.db.transaction`) vs
 *    pool. Handler throws roll back the transaction; the catch sits
 *    outside the transaction boundary. Handler outputs are validated
 *    against `spec.output` under DEV (logs an error on mismatch, never
 *    throws, never mutates the result).
 *
 * The function is pure data — it never touches a Hono context, so HTTP
 * RPC, REST bridge (when on the action surface), and WS dispatch all
 * call into it the same way and bind the discriminated
 * `PerformActionResult` to their wire shape.
 *
 * @module
 */

import {DEV} from 'esm-env';
import type {Logger} from '@fuzdev/fuz_util/log.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {
	apply_authorization_phase,
	has_any_scoped_role,
	type RequestContext,
} from '../auth/request_context.js';
import {type CredentialType} from '../hono_context.js';
import type {Db} from '../db/db.js';
import {is_void_schema} from '../http/schema_helpers.js';
import {
	JSONRPC_VERSION,
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
import type {RouteAuth} from '../http/auth_shape.js';
import type {ActionContext, ActionHandler, RpcAction} from './action_rpc.js';

/**
 * Per-call inputs to `perform_action`. Each transport assembles this from
 * its wire envelope + connection identity.
 */
export interface PerformActionInput {
	/** The resolved spec + handler (transport does method lookup). */
	action: RpcAction;
	/** Raw params from the wire envelope (post-`JsonrpcRequest.parse`, pre-`spec.input.safeParse`). */
	raw_params: unknown;
	/** JSON-RPC request id — echoed onto the response. */
	request_id: JsonrpcRequestId;
	/** Authenticated account id, or `null` for anonymous. */
	account_id: string | null;
	/** Credential type the request arrived on, or `null` for anonymous. */
	credential_type: CredentialType | null;
	/** Resolved client IP (`'unknown'` if upstream couldn't resolve). */
	client_ip: string;
	/** Per-request abort signal. HTTP: `c.req.raw.signal`. WS: `AbortSignal.any([socket, request])`. */
	signal: AbortSignal;
	/** Send a request-scoped notification. HTTP: DEV-warn-and-drop. WS: socket-scoped. */
	notify: (method: string, params: unknown) => void;
	/** Stable per-socket id on WS; `undefined` on HTTP. */
	connection_id?: Uuid;
	/**
	 * Test-harness escape hatch. When set, the live authorization phase is
	 * skipped and `request_context` is used directly for post-authorization
	 * checks + handler dispatch. Production callers leave this `undefined`.
	 */
	preset?: {request_context: RequestContext | null};
}

/**
 * Per-deps inputs to `perform_action`. Each transport supplies its own
 * pool-level `Db` and rate limiters; the dispatcher wraps in a transaction
 * iff `spec.side_effects` is true.
 */
export interface PerformActionDeps {
	/** Pool-level DB. The dispatcher wraps in `db.transaction` for `side_effects: true` actions. */
	db: Db;
	/** Always pool-level — for fire-and-forget effects that outlive the transaction. */
	background_db: Db;
	/** Per-request fire-and-forget queue, flushed by the transport's `try/finally`. */
	pending_effects: Array<Promise<void>>;
	/** Logger threaded into `ActionContext.log`. */
	log: Logger;
	/** Per-IP limiter (shared across transports). `null` disables. */
	action_ip_rate_limiter: RateLimiter | null;
	/** Per-account limiter (shared across transports). `null` disables. */
	action_account_rate_limiter: RateLimiter | null;
}

/**
 * Discriminated result of `perform_action`. Each transport binds this to
 * its wire shape: HTTP RPC folds the error into a JSON-RPC envelope and
 * returns via `c.json`; WS sends the response over the socket.
 */
export type PerformActionResult =
	| {kind: 'ok'; result: unknown}
	| {kind: 'error'; error: JsonrpcErrorObject; status: number};

/**
 * The shared dispatch core. Pure data — no Hono context, no socket. Each
 * transport calls into this with pre-parsed inputs and binds the result
 * to its wire shape.
 *
 * Phase order matches the post-Step-3 contract: 401 → 400 → 403 → handler.
 * On the test-preset path the dispatcher skips the live authorization
 * phase and uses the supplied pre-baked context for post-authorization
 * checks; pre-validation 401 still fires when the harness omits
 * `account_id`.
 */
export const perform_action = async (
	input: PerformActionInput,
	deps: PerformActionDeps,
): Promise<PerformActionResult> => {
	const {
		action,
		raw_params,
		request_id: id,
		account_id,
		credential_type,
		client_ip,
		signal,
		notify,
		connection_id,
		preset,
	} = input;
	const {
		db,
		background_db,
		pending_effects,
		log,
		action_ip_rate_limiter,
		action_account_rate_limiter,
	} = deps;
	const {spec, handler} = action;
	const action_auth = spec.auth;

	// step 1: pre-validation auth — 401 short-circuit before input validation.
	const pre = check_action_auth_pre_validation(action_auth, account_id);
	if (pre) return error_result(pre);

	// step 2: validate params. JSON-RPC 2.0 §4.2 forbids `params: null`;
	// registration sites reject `z.null()` inputs. Empty-body convention
	// (`raw_params ?? {}`) lets all-optional-object methods omit `params`.
	const params = is_void_schema(spec.input) ? raw_params : (raw_params ?? {});
	const parse_result = spec.input.safeParse(params);
	if (!parse_result.success) {
		return error_result(
			jsonrpc_error_messages.invalid_params('invalid params', {
				issues: parse_result.error.issues,
			}),
		);
	}
	const validated_input = parse_result.data;

	// step 3: authorization phase. `acting` reads off the typed Zod field
	// validated in step 2. Per registry-time invariant 2,
	// `auth.actor !== 'none' ⟺ input declares acting?: ActingActor` — so
	// the typed read is safe whenever the dispatcher needs it.
	let request_context: RequestContext | null = null;
	if (preset !== undefined) {
		request_context = preset.request_context;
	} else if (action_auth.account !== 'none' || action_auth.actor !== 'none') {
		const validated_with_acting = validated_input as {acting?: unknown} | undefined;
		const acting_value =
			validated_with_acting && typeof validated_with_acting.acting === 'string'
				? validated_with_acting.acting
				: undefined;
		const outcome = await apply_authorization_phase({db}, account_id, action_auth, acting_value);
		if (outcome.kind === 'failure') {
			const {error: reason, ...rest} = outcome.failure.body;
			const code = http_status_to_jsonrpc_error_code(outcome.failure.status);
			return {
				kind: 'error',
				status: outcome.failure.status,
				error: {code, message: reason, data: {reason, ...rest}},
			};
		}
		if (outcome.kind === 'resolved') {
			request_context = outcome.request_context;
		}
		// 'public' / 'unauthenticated' → request_context stays null.
	}

	// step 4: post-authorization auth — credential gate first, role gate second.
	const post = check_action_auth_post_authorization(action_auth, request_context, credential_type);
	if (post) return error_result(post);

	// step 5: rate limit — throttle-requests semantics (record on every
	// invocation, no success-reset). Same limiters shared with the WS
	// dispatcher so an attacker can't switch transports to bypass the budget.
	const rate_limit = spec.rate_limit;
	if (rate_limit) {
		const ip_check = action_ip_rate_limiter && (rate_limit === 'ip' || rate_limit === 'both');
		const account_keyed_context =
			action_account_rate_limiter &&
			request_context !== null &&
			(rate_limit === 'account' || rate_limit === 'both')
				? request_context
				: null;
		if (ip_check) {
			const result = action_ip_rate_limiter.check(client_ip);
			if (!result.allowed) return rate_limited_result(result.retry_after);
		}
		if (account_keyed_context) {
			const result = action_account_rate_limiter!.check(account_keyed_context.account.id);
			if (!result.allowed) return rate_limited_result(result.retry_after);
		}
		if (ip_check) action_ip_rate_limiter.record(client_ip);
		if (account_keyed_context) {
			action_account_rate_limiter!.record(account_keyed_context.account.id);
		}
	}

	// step 6: dispatch — transaction for mutations, pool for reads.
	const use_transaction = spec.side_effects;

	const execute = async (effective_db: Db): Promise<PerformActionResult> => {
		const action_context: ActionContext = {
			auth: request_context,
			request_id: id,
			connection_id,
			db: effective_db,
			background_db,
			pending_effects,
			client_ip,
			log,
			notify,
			signal,
		};

		const output = await (handler as ActionHandler)(validated_input, action_context);

		// DEV-only output validation — logs on mismatch, never throws.
		if (DEV) {
			const output_result = spec.output.safeParse(output);
			if (!output_result.success) {
				log.error(`action output schema mismatch: ${spec.method}`, output_result.error.issues);
			}
		}

		return {kind: 'ok', result: output};
	};

	try {
		if (use_transaction) {
			return await db.transaction((tx) => execute(tx));
		}
		return await execute(db);
	} catch (err) {
		// Duck-type check: Error with numeric `code` signals a JSON-RPC error.
		// Avoids cross-realm `instanceof` misses when consumers throw their own
		// `ThrownJsonrpcError` (structurally identical, different class identity).
		const error_like = err as {code?: unknown; data?: unknown};
		if (err instanceof Error && typeof error_like.code === 'number') {
			const code = error_like.code as JsonrpcErrorCode;
			const status = jsonrpc_error_code_to_http_status(code);
			const error: JsonrpcErrorObject = {code, message: err.message};
			if (error_like.data !== undefined) error.data = error_like.data;
			return {kind: 'error', status, error};
		}
		log.error(`unhandled action handler error: ${spec.method}`, err);
		const message = DEV && err instanceof Error ? err.message : 'internal server error';
		return error_result(jsonrpc_error_messages.internal_error(message));
	}
};

const error_result = (error: JsonrpcErrorObject): PerformActionResult => ({
	kind: 'error',
	error,
	status: jsonrpc_error_code_to_http_status(error.code),
});

const rate_limited_result = (retry_after: number): PerformActionResult => {
	const error = jsonrpc_error_messages.rate_limited('rate limited', {retry_after});
	return {
		kind: 'error',
		error,
		status: jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.rate_limited),
	};
};

/**
 * Pre-validation auth gate — fires before input validation so missing
 * credentials short-circuit with `unauthenticated` instead of leaking
 * a `invalid_params` error for methods with required input.
 *
 * 401 fires when `auth.account === 'required'` (or `auth.actor === 'required'`,
 * since registry-time invariant 3 forbids accountless actors in v1) and
 * no account is on the request. `'optional'` axes pass through — the
 * authorization phase decides based on whatever the credential supports.
 */
const check_action_auth_pre_validation = (
	auth: RouteAuth,
	account_id: string | null,
): JsonrpcErrorObject | null => {
	if (auth.account === 'required' || auth.actor === 'required') {
		if (account_id == null) return jsonrpc_error_messages.unauthenticated();
	}
	return null;
};

/**
 * Post-authorization auth gate — fires after the authorization phase
 * resolved the actor + role_grants. Enforces `auth.credential_types` and
 * `auth.roles`.
 *
 * Credential gate fires first: if the spec restricts credential types
 * and the request didn't arrive on one of them, emit
 * `ERROR_KEEPER_REQUIRES_DAEMON_TOKEN`-shaped 403 (the only credential
 * gate today is keeper; the literal stays until other gates land).
 *
 * Role gate fires second: if the spec declares any roles and the actor
 * doesn't hold one globally, emit `ERROR_INSUFFICIENT_PERMISSIONS` 403
 * with `required_roles` (the multi-role disjunction).
 */
const check_action_auth_post_authorization = (
	auth: RouteAuth,
	request_context: RequestContext | null,
	credential_type: CredentialType | null,
): JsonrpcErrorObject | null => {
	if (auth.credential_types?.length) {
		if (!credential_type || !auth.credential_types.includes(credential_type)) {
			return jsonrpc_error_messages.forbidden('forbidden', {
				reason: ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
				credential_type,
			});
		}
	}
	if (auth.roles?.length) {
		if (!has_any_scoped_role(request_context, auth.roles, null)) {
			return jsonrpc_error_messages.forbidden(`requires role: ${auth.roles.join(' or ')}`, {
				reason: ERROR_INSUFFICIENT_PERMISSIONS,
				required_roles: auth.roles,
			});
		}
	}
	return null;
};

/**
 * Build a JSON-RPC response envelope from a `PerformActionResult` for
 * transports that wire over the JSON-RPC 2.0 message shape (HTTP RPC + WS).
 */
export const perform_action_result_to_envelope = (
	id: JsonrpcRequestId,
	result: PerformActionResult,
): {jsonrpc: string; id: JsonrpcRequestId} & ({result: unknown} | {error: JsonrpcErrorObject}) => {
	if (result.kind === 'ok') {
		return {jsonrpc: JSONRPC_VERSION, id, result: result.result};
	}
	return {jsonrpc: JSONRPC_VERSION, id, error: result.error};
};
