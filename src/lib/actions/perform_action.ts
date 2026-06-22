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
 *    `z.void()` / `?? {}` rules. The validated input lands inside the
 *    function so the authorization phase reads `acting` as a typed Zod
 *    field.
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
import type {Logger} from '@fuzdev/fuz_util/log.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';

import {
	apply_authorization_phase,
	has_any_scoped_role,
	type RequestContext,
} from '../auth/request_context.ts';
import {type CredentialType} from '../hono_context.ts';
import type {Db} from '../db/db.ts';
import {is_void_schema} from '../http/schema_helpers.ts';
import {dispatch_with_post_commit_rollback} from '../http/pending_effects.ts';
import {
	JSONRPC_VERSION,
	type JsonrpcRequestId,
	type JsonrpcErrorCode,
	type JsonrpcErrorObject,
} from '../http/jsonrpc.ts';
import {
	jsonrpc_error_messages,
	jsonrpc_error_code_to_http_status,
	http_status_to_jsonrpc_error_code,
	JSONRPC_ERROR_CODES,
	dev_only,
} from '../http/jsonrpc_errors.ts';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_CREDENTIAL_TYPE_REQUIRED,
} from '../http/error_schemas.ts';
import type {RateLimiter} from '../rate_limiter.ts';
import {is_public_auth, type RouteAuth} from '../http/auth_shape.ts';
import type {ActionContext, ActionHandler, RpcAction} from './action_rpc.ts';
import type {RequestClient} from './peer_request.ts';

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
	 * Initiate a server→client request on the originating WS socket and await
	 * the typed reply (ActionPeer). Present only on WebSocket dispatch;
	 * `undefined` on HTTP RPC (no return socket). Handlers must handle its
	 * absence — e.g. `peer/ping` surfaces `peer_no_transport`.
	 */
	request_client?: RequestClient;
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
 *
 * Pool-resilient fire-and-forget effects (audit writes) run through
 * `AppDeps.audit.emit` from the action factory's closure — the dispatcher
 * never sees the audit emitter. The bound emitter owns the pool.
 */
export interface PerformActionDeps {
	/** Pool-level DB. The dispatcher wraps in `db.transaction` for `side_effects: true` actions. */
	db: Db;
	/**
	 * Eager fire-and-forget pool-write queue, flushed by the transport's
	 * `try/finally` via `flush_pending_effects`.
	 */
	pending_effects: Array<Promise<void>>;
	/**
	 * Deferred post-commit thunks pushed via `emit_after_commit`, flushed
	 * by the transport's `try/finally` after the handler returns.
	 */
	post_commit_effects: Array<() => void | Promise<void>>;
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
 * Phase order: 401 → 400 → 403 → handler. On the test-preset path the
 * dispatcher skips the live authorization phase and uses the supplied
 * pre-baked context for post-authorization checks; pre-validation 401
 * still fires when the harness omits `account_id`.
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
		request_client,
		preset,
	} = input;
	const {
		db,
		pending_effects,
		post_commit_effects,
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
			jsonrpc_error_messages.invalid_params(
				'invalid params',
				dev_only({issues: parse_result.error.issues}),
			),
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
	} else if (!is_public_auth(action_auth)) {
		const validated_with_acting = validated_input as {acting?: unknown} | undefined;
		const acting_value =
			validated_with_acting && typeof validated_with_acting.acting === 'string'
				? validated_with_acting.acting
				: undefined;
		const result = await apply_authorization_phase({db}, account_id, action_auth, acting_value);
		if (!result.ok) {
			const {error: reason, ...rest} = result.body;
			const code = http_status_to_jsonrpc_error_code(result.status);
			return {
				kind: 'error',
				status: result.status,
				error: {code, message: reason, data: {reason, ...rest}},
			};
		}
		// `request_context: null` covers public actions and the
		// unauthenticated-optional axis; the handler sees null in either case.
		request_context = result.request_context;
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
			request_client,
			db: effective_db,
			pending_effects,
			post_commit_effects,
			client_ip,
			credential_type,
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

	// Dispatch — transaction for mutations, pool for reads. Wrapped so a thrown
	// handler discards the post-commit effects it queued (`emit_after_commit`):
	// its transaction rolled back, so those effects must not announce state that
	// never committed. The eager `pending_effects` queue survives rollback
	// (attempt audits). See `dispatch_with_post_commit_rollback` (canonical
	// contract) and docs/security.md §"Post-commit WS fan-out".
	try {
		return await dispatch_with_post_commit_rollback(post_commit_effects, () =>
			use_transaction ? db.transaction((tx) => execute(tx)) : execute(db),
		);
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
		// Raw exception messages can leak internals (paths, SQL, secrets in a
		// message) — surface them only in development; production falls back to
		// the generic `internal_error` default. Same gate as the Zod-issue redaction.
		return error_result(
			jsonrpc_error_messages.internal_error(
				dev_only(err instanceof Error ? err.message : undefined),
			),
		);
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
		if (account_id == null) {
			// Carry the reason on `error.data.reason` (symmetric with the 403
			// credential / role gates) so a 401 can be asserted on reason, not
			// just status. The reason is generic — it leaks nothing about
			// whether a credential was present or what the route demanded.
			return jsonrpc_error_messages.unauthenticated('unauthenticated', {
				reason: ERROR_AUTHENTICATION_REQUIRED,
			});
		}
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
 * `ERROR_CREDENTIAL_TYPE_REQUIRED` 403 with `required_credential_types`
 * echoing the spec's allowlist (symmetric with the role gate's
 * `required_roles`).
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
				reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
				required_credential_types: auth.credential_types,
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
