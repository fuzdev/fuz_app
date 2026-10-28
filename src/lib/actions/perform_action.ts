/**
 * Transport-agnostic dispatch core shared by HTTP RPC and WebSocket
 * action dispatchers.
 *
 * `perform_action` runs the post-parse pipeline that every action-spec
 * handler must traverse:
 *
 * 1. **Pre-authorization auth (401)** — short-circuits unauthenticated callers
 *    on `'required'` axes.
 * 2. **Authorization phase** — when `auth.actor !== 'none'` (or
 *    `auth.account !== 'none' && actor === 'none'`), resolves the actor
 *    via `apply_authorization_phase` against the supplied `account_id`
 *    plus the request's `acting` selector, read off the raw params by
 *    `read_acting`. Failures fold into a JSON-RPC error envelope. The
 *    test-harness escape hatch lives in the caller — pass
 *    `preset.request_context` to skip the live phase and use a pre-baked
 *    context instead.
 * 3. **Post-authorization auth (403)** — gates `auth.credential_types`,
 *    the credential's `token_scope`, and `auth.roles` against the resolved
 *    context.
 * 4. **Rate limit (429)** — per-action IP / account throttling, throttle-
 *    requests semantics (every invocation records, regardless of outcome).
 *    Ahead of validation so the budget is charged for malformed params too
 *    — a flood of garbage bodies must cost the sender its quota, not slip
 *    past the limiter on a cheap 400 — and so a throttled caller never pays
 *    for schema work. The account key is the credential's own account
 *    (`request_context.account.id`), settled by authentication, so the gate
 *    sits behind the authority gates by choice rather than necessity: a
 *    caller those gates refuse is answered 403, not 429.
 * 5. **Validate params (400)** — `spec.input.safeParse(raw_params)` with
 *    `z.void()` / `?? {}` rules (`to_input_params`). A refusal is the generic
 *    `invalid params`, with `data.reason` when the first issue's field
 *    declares an `invalid_reason` (`to_invalid_params_error`) and the Zod
 *    issues under DEV only. Runs **after** the authority gates: a
 *    400 describing the action's input shape to a caller those gates
 *    refuse would confirm the method exists and describe how to call it,
 *    to a channel that should have learned nothing. Coarse authority
 *    facts before fine ones, and no shape disclosure before authority is
 *    settled — the same argument that puts the credential gate ahead of
 *    the scope gate. The cost: a malformed request from an *authenticated*
 *    caller pays for the authorization phase's actor + role_grant reads
 *    before being rejected, rather than being turned away by validation
 *    first. Not a new DoS lever — the same caller reaches that work anyway
 *    by sending well-formed params — but there is no cheap-rejection path
 *    for buggy clients.
 * 6. **Dispatch + DEV-only output validation + error normalization** —
 *    `spec.side_effects` picks transaction (`deps.db.transaction`) vs
 *    pool. Handler throws roll back the transaction; the catch sits
 *    outside the transaction boundary. Handler outputs are validated
 *    against `spec.output` under DEV (logs an error on mismatch, never
 *    throws, never mutates the result).
 *
 * The function is pure data — it never touches a Hono context, so HTTP
 * RPC and WS dispatch call into it the same way and bind the discriminated
 * `PerformActionResult` to their wire shape.
 *
 * @module
 */

import { DEV } from 'esm-env';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { z } from 'zod';
import type { Uuid } from '../primitive_schemas.ts';

import {
	apply_authorization_phase,
	has_any_scoped_role,
	type RequestContext
} from '../auth/request_context.ts';
import type { BuiltinCredentialType } from '../auth/credential_type_schema.ts';
import type { Db } from '../db/db.ts';
import { resolve_issues_invalid_reason } from '../schema_meta.ts';
import { to_input_params } from '../http/schema_helpers.ts';
import { rate_limit_ip_key } from '../http/ip_canonical.ts';
import { dispatch_with_post_commit_rollback } from '../http/pending_effects.ts';
import {
	type JsonrpcRequestId,
	is_jsonrpc_error_code,
	type JsonrpcErrorObject,
	type JsonrpcErrorResponse,
	type JsonrpcResponse
} from '../http/jsonrpc.ts';
import { create_jsonrpc_error_response, create_jsonrpc_response } from '../http/jsonrpc_helpers.ts';
import {
	jsonrpc_error_messages,
	jsonrpc_error_code_to_http_status,
	http_status_to_jsonrpc_error_code,
	JSONRPC_ERROR_CODES,
	dev_only
} from '../http/jsonrpc_errors.ts';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_CREDENTIAL_TYPE_REQUIRED,
	ERROR_TOKEN_SCOPE_REQUIRED
} from '../http/error_schemas.ts';
import type { RateLimiter } from '../rate_limiter.ts';
import { is_public_auth, needs_actor, parse_acting, type RouteAuth } from '../http/auth_shape.ts';
import type { ActionContext, ActionHandler, RpcAction } from './action_types.ts';
import type { RequestClient } from './peer_request.ts';
import {
	token_scope_admits_method,
	token_scope_method_capability,
	type TokenScope
} from '../auth/token_scope.ts';

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
	credential_type: BuiltinCredentialType | null;
	/**
	 * The credential's authority narrowing — `null` only for the anonymous
	 * caller, who holds no credential to narrow. Every resolved credential
	 * carries one, so this mirrors the `null` shape `credential_type` already
	 * has rather than introducing a permissive absent case.
	 */
	token_scope: TokenScope | null;
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
	preset?: { request_context: RequestContext | null };
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
	{ kind: 'ok'; result: unknown } | { kind: 'error'; error: JsonrpcErrorObject; status: number };

/**
 * The shared dispatch core. Pure data — no Hono context, no socket. Each
 * transport calls into this with pre-parsed inputs and binds the result
 * to its wire shape.
 *
 * Phase order: 401 → authz → 403 → 429 → 400 → handler. On the test-preset path
 * the dispatcher skips the live authorization phase and uses the supplied
 * pre-baked context for post-authorization checks; the 401 still fires when
 * the harness omits `account_id`.
 */
export const perform_action = async (
	input: PerformActionInput,
	deps: PerformActionDeps
): Promise<PerformActionResult> => {
	const {
		action,
		raw_params,
		request_id: id,
		account_id,
		credential_type,
		token_scope,
		client_ip,
		signal,
		notify,
		connection_id,
		request_client,
		preset
	} = input;
	const {
		db,
		pending_effects,
		post_commit_effects,
		log,
		action_ip_rate_limiter,
		action_account_rate_limiter
	} = deps;
	const { spec, handler } = action;
	const action_auth = spec.auth;

	// step 1: pre-authorization auth — 401 short-circuit.
	const pre = check_action_auth_pre_authorization(action_auth, account_id);
	if (pre) return error_result(pre);

	// step 2: authorization phase. `acting` reads off the raw params rather
	// than a validated field, because validation runs after the authority
	// gates. Per registry-time invariant 2,
	// `auth.actor !== 'none' ⟺ input declares acting?: ActingActor` — so the
	// selector is present on exactly the specs that need it, and step 5 is
	// what rejects a malformed one.
	let request_context: RequestContext | null = null;
	if (preset !== undefined) {
		request_context = preset.request_context;
	} else if (!is_public_auth(action_auth)) {
		const result = await apply_authorization_phase(
			{ db },
			account_id,
			action_auth,
			read_acting(action_auth, raw_params)
		);
		if (!result.ok) {
			const { error: reason, ...rest } = result.body;
			const code = http_status_to_jsonrpc_error_code(result.status);
			return {
				kind: 'error',
				status: result.status,
				error: { code, message: reason, data: { reason, ...rest } }
			};
		}
		// `request_context: null` covers public actions and the
		// unauthenticated-optional axis; the handler sees null in either case.
		request_context = result.request_context;
	}

	// step 3: post-authorization auth — credential gate, then scope, then role.
	const post = check_action_auth_post_authorization(
		action_auth,
		request_context,
		credential_type,
		action.spec.method,
		token_scope
	);
	if (post) return error_result(post);

	// step 4: rate limit — throttle-requests semantics (record on every
	// invocation, no success-reset). Same limiters shared with the WS
	// dispatcher so an attacker can't switch transports to bypass the budget.
	// Runs ahead of validation so a flood of malformed params burns the
	// budget it should, and so a throttled caller pays no schema work.
	const rate_limit = spec.rate_limit;
	if (rate_limit) {
		const ip_limiter = rate_limit === 'ip' || rate_limit === 'both' ? action_ip_rate_limiter : null;
		const account_keyed_context =
			action_account_rate_limiter &&
			request_context !== null &&
			(rate_limit === 'account' || rate_limit === 'both')
				? request_context
				: null;
		// keyed by the address's rate-limit key (an IPv6 client's /64); the
		// audit trail keeps `client_ip` whole
		const ip_key = ip_limiter ? rate_limit_ip_key(client_ip) : '';
		if (ip_limiter) {
			const result = ip_limiter.check(ip_key);
			if (!result.allowed) return rate_limited_result(result.retry_after);
		}
		if (account_keyed_context) {
			const result = action_account_rate_limiter!.check(account_keyed_context.account.id);
			if (!result.allowed) return rate_limited_result(result.retry_after);
		}
		if (ip_limiter) ip_limiter.record(ip_key);
		if (account_keyed_context) {
			action_account_rate_limiter!.record(account_keyed_context.account.id);
		}
	}

	// step 5: validate params. JSON-RPC 2.0 §4.2 forbids `params: null`;
	// registration sites reject `z.null()` inputs. Empty-body convention
	// (`raw_params ?? {}`) lets all-optional-object methods omit `params`;
	// a `z.void()` input reads every empty shape as the no-arg call — see
	// `to_input_params`.
	const params = to_input_params(spec.input, raw_params);
	const parse_result = spec.input.safeParse(params);
	if (!parse_result.success) {
		return error_result(to_invalid_params_error(spec.input, parse_result.error.issues));
	}
	const validated_input = parse_result.data;

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
			signal
		};

		const output = await (handler as ActionHandler)(validated_input, action_context);

		// DEV-only output validation — logs on mismatch, never throws.
		if (DEV) {
			const output_result = spec.output.safeParse(output);
			if (!output_result.success) {
				log.error(`action output schema mismatch: ${spec.method}`, output_result.error.issues);
			}
		}

		return { kind: 'ok', result: output };
	};

	// Dispatch — transaction for mutations, pool for reads. Wrapped so a thrown
	// handler discards the post-commit effects it queued (`emit_after_commit`):
	// its transaction rolled back, so those effects must not announce state that
	// never committed. The eager `pending_effects` queue survives rollback
	// (attempt audits). See `dispatch_with_post_commit_rollback` (canonical
	// contract) and docs/security.md §"Post-commit WS fan-out".
	try {
		return await dispatch_with_post_commit_rollback(post_commit_effects, () =>
			use_transaction ? db.transaction((tx) => execute(tx)) : execute(db)
		);
	} catch (err) {
		// Duck-type check: an Error whose `code` is a JSON-RPC error code signals
		// a JSON-RPC error. Avoids cross-realm `instanceof` misses when consumers
		// throw their own `ThrownJsonrpcError` (structurally identical, different
		// class identity). The code must be a valid JSON-RPC one, not just a
		// number — a `DOMException` (`code` 20, 23, ...) is an internal error,
		// logged and masked like any other.
		const error_like = err as { code?: unknown; data?: unknown };
		if (err instanceof Error && is_jsonrpc_error_code(error_like.code)) {
			const code = error_like.code;
			const status = jsonrpc_error_code_to_http_status(code);
			const error: JsonrpcErrorObject = { code, message: err.message };
			if (error_like.data !== undefined) error.data = error_like.data;
			return { kind: 'error', status, error };
		}
		log.error(`unhandled action handler error: ${spec.method}`, err);
		// Raw exception messages can leak internals (paths, SQL, secrets in a
		// message) — surface them only in development; production falls back to
		// the generic `internal_error` default. Same gate as the Zod-issue redaction.
		return error_result(
			jsonrpc_error_messages.internal_error(
				dev_only(err instanceof Error ? err.message : undefined)
			)
		);
	}
};

/**
 * The `invalid_params` error an input validation failure answers: the generic
 * `invalid params` message, `data.reason` when the field the first issue lands
 * on declares an `invalid_reason` and no issue sits on the input itself
 * (`resolve_issues_invalid_reason`), and the Zod issues under DEV only
 * (`dev_only`). With no declared reason, production sends no `data` at all.
 *
 * @param input - the action's input schema
 * @param issues - the failed parse's issues, in Zod's order
 * @returns the JSON-RPC error object
 */
export const to_invalid_params_error = (
	input: z.ZodType,
	issues: ReadonlyArray<z.core.$ZodIssue>
): JsonrpcErrorObject => {
	const reason = resolve_issues_invalid_reason(input, issues);
	const issues_data = dev_only({ issues });
	return jsonrpc_error_messages.invalid_params(
		'invalid params',
		reason === undefined ? issues_data : { reason, ...issues_data }
	);
};

const error_result = (error: JsonrpcErrorObject): PerformActionResult => ({
	kind: 'error',
	error,
	status: jsonrpc_error_code_to_http_status(error.code)
});

const rate_limited_result = (retry_after: number): PerformActionResult => {
	const error = jsonrpc_error_messages.rate_limited('rate limited', { retry_after });
	return {
		kind: 'error',
		error,
		status: jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.rate_limited)
	};
};

/**
 * Read the `acting` actor selector off the raw params for the authorization
 * phase.
 *
 * Consulted only when the spec declares an actor axis; `parse_acting` owns
 * what counts as a selector and why a malformed one reads as omitted.
 *
 * @param auth - the spec's auth shape; no actor axis means no selector
 * @param raw_params - the request's unvalidated params
 * @returns the actor id, or `undefined` when absent, malformed, or unwanted
 */
const read_acting = (auth: RouteAuth, raw_params: unknown): string | undefined => {
	if (!needs_actor(auth)) return undefined;
	if (typeof raw_params !== 'object' || raw_params === null) return undefined;
	return parse_acting((raw_params as { acting?: unknown }).acting);
};

/**
 * Pre-authorization auth gate — fires before the authorization phase so
 * missing credentials short-circuit with `unauthenticated`.
 *
 * 401 fires when `auth.account === 'required'` (or `auth.actor === 'required'`,
 * since registry-time invariant 3 forbids accountless actors in v1) and
 * no account is on the request. `'optional'` axes pass through — the
 * authorization phase decides based on whatever the credential supports.
 */
const check_action_auth_pre_authorization = (
	auth: RouteAuth,
	account_id: string | null
): JsonrpcErrorObject | null => {
	if (auth.account === 'required' || auth.actor === 'required') {
		if (account_id == null) {
			// Carry the reason on `error.data.reason` (symmetric with the 403
			// credential / role gates) so a 401 can be asserted on reason, not
			// just status. The reason is generic — it leaks nothing about
			// whether a credential was present or what the route demanded.
			return jsonrpc_error_messages.unauthenticated('unauthenticated', {
				reason: ERROR_AUTHENTICATION_REQUIRED
			});
		}
	}
	return null;
};

/**
 * The credential-type 403 — one builder, so the dispatcher's gate below and a
 * handler that gates a credential channel on its input (`account_delete`'s
 * self path) emit a byte-identical error. Twin of the Rust
 * `fuz_auth::credential_type_required`.
 *
 * @param required_credential_types - the channels that would be admitted
 * @returns the `forbidden` error object with reason `credential_type_required`
 */
export const credential_type_required_error = (
	required_credential_types: ReadonlyArray<string>
): JsonrpcErrorObject =>
	jsonrpc_error_messages.forbidden('forbidden', {
		reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
		required_credential_types
	});

/**
 * Post-authorization auth gate — fires after the authorization phase
 * resolved the actor + role_grants. Enforces `auth.credential_types` and
 * `auth.roles`.
 *
 * ## Gate order: credential → scope → role
 *
 * **Credential first** because it is the coarser fact ("this channel may never
 * call me" outranks "this token may not"), because it preserves every existing
 * wire assertion — a session-only spec called over bearer keeps returning
 * `ERROR_CREDENTIAL_TYPE_REQUIRED` — and because it leaks less: telling a
 * bearer caller "your token lacks `rpc:X`" on an endpoint no bearer may ever
 * reach confirms the endpoint to a channel that should not learn it.
 *
 * **Scope second**, before the role gate, because scope is a fact about the
 * credential decided without a DB read, while the role gate reads the resolved
 * actor's grants. Coarse → fine, and an under-scoped token learns nothing about
 * the deployment's role structure. `token_scope` is `null` only for the
 * anonymous caller, who has no credential to narrow.
 *
 * **Role gate third**: if the spec declares any roles and the actor doesn't hold
 * one globally, emit `ERROR_INSUFFICIENT_PERMISSIONS` 403 with `required_roles`
 * (the multi-role disjunction).
 */
const check_action_auth_post_authorization = (
	auth: RouteAuth,
	request_context: RequestContext | null,
	credential_type: BuiltinCredentialType | null,
	method: string,
	token_scope: TokenScope | null
): JsonrpcErrorObject | null => {
	if (auth.credential_types?.length) {
		if (!credential_type || !auth.credential_types.includes(credential_type)) {
			return credential_type_required_error(auth.credential_types);
		}
	}
	// Token-scope gate — second of three. See the doc comment for why the order
	// is credential → scope → role.
	if (token_scope && !token_scope_admits_method(token_scope, method)) {
		return jsonrpc_error_messages.forbidden('forbidden', {
			reason: ERROR_TOKEN_SCOPE_REQUIRED,
			required_scope: token_scope_method_capability(method)
		});
	}
	if (auth.roles?.length) {
		if (!has_any_scoped_role(request_context, auth.roles, null)) {
			return jsonrpc_error_messages.forbidden('forbidden', {
				reason: ERROR_INSUFFICIENT_PERMISSIONS,
				required_roles: auth.roles
			});
		}
	}
	return null;
};

/**
 * Build a JSON-RPC response envelope from a `PerformActionResult` for
 * transports that wire over the JSON-RPC 2.0 message shape (HTTP RPC + WS).
 */
const perform_action_result_to_envelope = (
	id: JsonrpcRequestId,
	result: PerformActionResult
): JsonrpcResponse | JsonrpcErrorResponse =>
	result.kind === 'ok'
		? create_jsonrpc_response(id, result.result as JsonrpcResponse['result'])
		: create_jsonrpc_error_response(id, result.error);

/** A `PerformActionResult` serialized for the wire: the JSON body and its HTTP status. */
export interface SerializedActionResult {
	body: string;
	/** `200` for a result, the error's status otherwise. WS ignores it. */
	status: number;
}

/**
 * Serialize a `PerformActionResult` to its JSON-RPC envelope text — the one
 * step HTTP RPC and WS share after `perform_action` returns.
 *
 * A result that cannot be serialized (a `bigint`, a cycle) answers
 * `internal_error` rather than throwing. By then the action has committed, so
 * a throw would cost its effects: over HTTP the route wrapper reads it as a
 * rollback and discards `post_commit_effects` (a revocation's connection
 * closes among them); over WS the adapter does not await the frame handler, so
 * the rejection is unhandled and the caller gets no reply to a request that
 * did run.
 *
 * @param id - the request id the envelope echoes
 * @param result - what `perform_action` returned
 * @param method - the action method, for the log line
 * @param log - where a serialization failure is logged
 * @returns the envelope text and the HTTP status to send it with
 */
export const serialize_action_result = (
	id: JsonrpcRequestId,
	result: PerformActionResult,
	method: string,
	log: Logger
): SerializedActionResult => {
	const status = result.kind === 'error' ? result.status : 200;
	try {
		return { body: JSON.stringify(perform_action_result_to_envelope(id, result)), status };
	} catch (error) {
		log.error(`action result is not serializable: ${method}`, error);
		return {
			body: JSON.stringify(
				create_jsonrpc_error_response(
					id,
					jsonrpc_error_messages.internal_error(
						dev_only(error instanceof Error ? error.message : undefined)
					)
				)
			),
			status: jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.internal_error)
		};
	}
};
