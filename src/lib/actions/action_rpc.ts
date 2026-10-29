/**
 * Single JSON-RPC 2.0 endpoint from action specs.
 *
 * `create_rpc_endpoint` produces `RouteSpec[]` (GET + POST on one path)
 * with an internal dispatcher. Method name lives in the JSON-RPC envelope
 * (POST body or GET query string), not the URL. Auth is checked per-action
 * inside the dispatcher.
 *
 * Handler signature: `(input: TInput, ctx: ActionContext) => TOutput`
 * where `ActionContext` (`actions/action_types.ts`) provides auth identity,
 * DB, and framework context.
 *
 * @module
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { DEV } from 'esm-env';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { UnreachableError } from '@fuzdev/fuz_util/error.ts';

import type { RpcAction } from './action_types.ts';
import { type RouteContext, type RouteSpec } from '../http/route_spec.ts';
import { get_client_ip } from '../http/client_ip.ts';
import { get_request_context } from '../auth/request_context.ts';
import { get_resolved_auth } from '../auth/resolved_auth.ts';
import { TEST_CONTEXT_PRESET_KEY } from '../hono_context.ts';
import { compile_action_registry } from './compile_action_registry.ts';
import type { JsonrpcRequestId } from '../http/jsonrpc.ts';
import {
	jsonrpc_error_messages,
	jsonrpc_error_code_to_http_status,
	JSONRPC_ERROR_CODES
} from '../http/jsonrpc_errors.ts';
import {
	classify_jsonrpc_message,
	create_jsonrpc_error_response
} from '../http/jsonrpc_helpers.ts';
import type { RateLimiter } from '../rate_limiter.ts';
import { perform_action, serialize_action_result } from './perform_action.ts';

/**
 * The `Cache-Control` every response of the RPC endpoint's `GET` route carries
 * — a read is per caller and per moment, so nothing may store it.
 */
export const RPC_GET_CACHE_CONTROL = 'no-store';

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
	 * `rate_limit: 'ip'` or `'both'`. Required, with no default: pass
	 * `null` to turn the IP check off, so an unthrottled endpoint is a
	 * choice the call site states rather than an option it forgot.
	 * `create_app_server` passes its own (a default limiter unless
	 * configured). Share one instance with the WebSocket action dispatcher —
	 * one budget per action, not per transport.
	 */
	action_ip_rate_limiter: RateLimiter | null;
	/**
	 * Per-account rate limiter consulted for actions whose spec declares
	 * `rate_limit: 'account'` or `'both'`. Keyed on
	 * `request_context.account.id` (account-grain — billed to the
	 * authenticated account regardless of which actor was resolved).
	 * Required, with no default: pass `null` to turn the account check off.
	 * Share one instance with the WebSocket action dispatcher.
	 */
	action_account_rate_limiter: RateLimiter | null;
}

/**
 * Single JSON-RPC 2.0 endpoint — the canonical RPC transport binding.
 *
 * Returns two `RouteSpec` entries (GET + POST on the same path) for
 * `apply_route_specs`. The internal dispatcher handles:
 *
 * 1. **Parse envelope** — POST: JSON body through `classify_jsonrpc_message`. GET: `method`
 *    and `params` from query string.
 * 2. **Lookup method** — find the `RpcAction` by method name.
 * 3. **Pre-authorization auth** — short-circuit `unauthenticated` when no
 *    account is on the request, before any later phase runs.
 * 4. **Authorization phase** — resolve the acting actor (when the action's
 *    auth requires role_grants or its input declares `acting?: ActingActor`)
 *    and build the request context. Runs before input validation so
 *    role-grant-grain auth checks return 403 before 400 invalid_params;
 *    `acting` is read from raw params by `read_acting`, which parses it as
 *    a UUID and treats anything else as omitted.
 * 5. **Post-authorization auth** — enforce role / keeper requirements
 *    against the request context.
 * 6. **Rate limit** — per-action IP / account throttling, ahead of params
 *    validation so a malformed call still charges.
 * 7. **Validate params** — parse input against the action's `input` schema.
 * 8. **Dispatch** — acquire DB handle (transaction for mutations, pool for reads),
 *    construct `ActionContext`, call handler, return JSON-RPC response.
 *
 * GET is restricted to `side_effects: false` actions, and every response the
 * GET handler writes, its refusals included, carries `Cache-Control: no-store`
 * (`RPC_GET_CACHE_CONTROL`) — a refusal by middleware ahead of it does not.
 * All errors use JSON-RPC format: `{jsonrpc, id, error: {code, message, data?}}`.
 *
 * The RouteSpecs use `auth: {type: 'none'}` because auth is checked per-action
 * inside the dispatcher, and `transaction: false` because transaction scope
 * is per-action (mutations get a transaction, reads get pool). They are
 * marked `reads_credential`, since the dispatcher reads the resolved
 * credential, so assembly refuses the pair mounted outside the auth
 * middleware's scope (`assert_credential_routes_in_auth_scope`) whether it
 * arrives as `rpc_endpoints` or through `create_route_specs`.
 *
 * @param options - endpoint path, actions, logger, and the two action rate limiters
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
		action_ip_rate_limiter,
		action_account_rate_limiter
	} = options;

	const { action_map } = compile_action_registry(actions, 'RPC action');

	/**
	 * HTTP-shape dispatch shim — the GET/POST entry points share this:
	 *
	 * 1. Resolve the action by method name (HTTP-shape `method_not_found` envelope).
	 * 2. Reject GET requests for `side_effects: true` actions (HTTP-only constraint).
	 * 3. Hand off to `perform_action` for the post-parse pipeline.
	 * 4. Bind the result through `serialize_action_result` — `'ok'` returns the
	 *    result envelope, `'error'` the error envelope at the `result.status`
	 *    HTTP code, and a result that cannot be serialized `internal_error`
	 *    rather than a throw that would discard the committed action's
	 *    post-commit effects.
	 *
	 * @param restrict_to_reads - `true` for GET (rejects `side_effects: true` actions)
	 */
	const dispatch = async (
		c: Context,
		route: RouteContext,
		method_name: string,
		raw_params: unknown,
		id: JsonrpcRequestId,
		restrict_to_reads: boolean
	): Promise<Response> => {
		const action = action_map.get(method_name);
		if (!action) {
			return c.json(
				create_jsonrpc_error_response(id, jsonrpc_error_messages.method_not_found(method_name)),
				jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.method_not_found)
			);
		}

		if (restrict_to_reads && action.spec.side_effects) {
			return c.json(
				create_jsonrpc_error_response(
					id,
					jsonrpc_error_messages.invalid_request({
						reason: `method '${method_name}' has side effects and must use POST`
					})
				),
				jsonrpc_error_code_to_http_status(JSONRPC_ERROR_CODES.invalid_request)
			);
		}

		// HTTP RPC has no streaming channel; `ctx.notify` warn-and-drops in DEV.
		const notify = (notify_method: string, _notify_params: unknown): void => {
			if (DEV) {
				log.warn(
					`ctx.notify('${
						notify_method
					}') called on non-streaming transport; notification dropped (method=${method_name})`
				);
			}
		};

		// Test escape hatch: harnesses pre-populate `REQUEST_CONTEXT_KEY` and
		// flag `TEST_CONTEXT_PRESET_KEY = true`. Production middleware never
		// sets the flag; the shim honors it and `perform_action` trusts the
		// pre-baked context instead of running the live authorization phase.
		const preset = c.get(TEST_CONTEXT_PRESET_KEY)
			? { request_context: get_request_context(c) }
			: undefined;

		const result = await perform_action(
			{
				action,
				raw_params,
				request_id: id,
				auth: get_resolved_auth(c),
				client_ip: get_client_ip(c),
				signal: c.req.raw.signal,
				notify,
				preset
			},
			{
				db: route.db,
				pending_effects: route.pending_effects,
				post_commit_effects: route.post_commit_effects,
				log,
				action_ip_rate_limiter,
				action_account_rate_limiter
			}
		);

		const { body, status } = serialize_action_result(id, result, method_name, log);
		// `status` is 200 or one of the JSON-RPC → HTTP status codes the
		// dispatcher emits (the value space is verified by
		// `jsonrpc_error_code_to_http_status`), which the cast to Hono's
		// `ContentfulStatusCode` bridges. The content type is `c.json`'s.
		return c.body(body, status as ContentfulStatusCode, {
			'Content-Type': 'application/json'
		});
	};

	// POST handler — parse JSON-RPC envelope from body
	const post_handler = async (c: Context, route: RouteContext): Promise<Response> => {
		// step 1: parse envelope
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			const error = create_jsonrpc_error_response(null, jsonrpc_error_messages.parse_error());
			return c.json(error, 400);
		}

		// the classifier the WS path runs; HTTP issues no server-initiated
		// requests and has no notification semantics, so a response or a
		// notification answers `invalid_request` on `id: null`, as on the Rust spine
		const classified = classify_jsonrpc_message(body);
		switch (classified.kind) {
			case 'request': {
				const { method, params, id } = classified.request;
				return dispatch(c, route, method, params, id, false);
			}
			case 'invalid':
				return c.json(create_jsonrpc_error_response(classified.id, classified.error), 400);
			case 'notification':
			case 'response':
				return c.json(
					create_jsonrpc_error_response(null, jsonrpc_error_messages.invalid_request()),
					400
				);
			default:
				throw new UnreachableError(classified);
		}
	};

	// GET handler — extract method and params from query string
	const get_handler = async (c: Context, route: RouteContext): Promise<Response> => {
		// A read answers for one caller at one moment: no cache — the browser's,
		// a proxy's — may keep it and answer a later call, or another caller,
		// with it. Every response of the route, errors included.
		c.header('Cache-Control', RPC_GET_CACHE_CONTROL);
		// step 1: parse from query string
		const method_name = c.req.query('method');
		if (!method_name) {
			const error = create_jsonrpc_error_response(
				null,
				jsonrpc_error_messages.invalid_request({ reason: 'missing method query parameter' })
			);
			return c.json(error, 400);
		}

		const id_raw = c.req.query('id');
		if (!id_raw) {
			const error = create_jsonrpc_error_response(
				null,
				jsonrpc_error_messages.invalid_request({ reason: 'missing id query parameter' })
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
				const error = create_jsonrpc_error_response(
					id,
					jsonrpc_error_messages.invalid_params('params query parameter is not valid JSON')
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
			auth: { account: 'none', actor: 'none' }, // per-action auth inside dispatcher
			// the dispatcher reads the resolved credential per action, so the
			// endpoint stays inside the auth middleware's scope however it mounts
			reads_credential: true,
			handler: post_handler,
			description: `JSON-RPC 2.0 endpoint — ${actions.length} method${
				actions.length === 1 ? '' : 's'
			}`,
			input: z.null(), // dispatcher owns body parsing; rpc_endpoints surface has the real schemas
			output: z.any(), // varies by method
			transaction: false // per-action inside dispatcher
		},
		{
			method: 'GET',
			path: endpoint_path,
			auth: { account: 'none', actor: 'none' }, // per-action auth inside dispatcher
			reads_credential: true,
			handler: get_handler,
			description: `JSON-RPC 2.0 endpoint (side-effect-free reads) — ${actions.length} method${
				actions.length === 1 ? '' : 's'
			}`,
			input: z.null(), // params from query string, validated by dispatcher
			output: z.any(), // varies by method
			transaction: false // per-action inside dispatcher
		}
	];
};
