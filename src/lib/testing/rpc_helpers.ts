import './assert_dev_env.js';

/**
 * JSON-RPC test helpers — request construction, response assertion, and
 * one-shot call ergonomics.
 *
 * Shared by `rpc_attack_surface.ts`, `rpc_round_trip.ts`, and
 * consumer-facing admin/audit suites that exercise RPC methods directly.
 *
 * @module
 */

import {assert} from 'vitest';
import {z} from 'zod';

import {
	JSONRPC_VERSION,
	JsonrpcErrorResponse,
	JsonrpcResponse,
	type JsonrpcErrorCode,
} from '../http/jsonrpc.js';
import type {RpcAction} from '../actions/action_rpc.js';
import type {AppSurfaceRpcEndpoint, AppSurfaceRpcMethod, RpcEndpointSpec} from '../http/surface.js';

/**
 * Create a `RequestInit` for a JSON-RPC POST request.
 *
 * @param method - JSON-RPC method name
 * @param params - params object (omit or pass `null` for null-input methods;
 *                both are serialized without a `params` field so the envelope
 *                schema accepts the request — `"params":null` is not a valid
 *                JSON-RPC value)
 * @param id - request id (default `'test'`)
 * @returns a `RequestInit` with the JSON-RPC envelope as body
 */
export const create_rpc_post_init = (
	method: string,
	params?: unknown,
	id: string | number = 'test',
): RequestInit => {
	const envelope: Record<string, unknown> = {jsonrpc: JSONRPC_VERSION, method, id};
	if (params !== undefined && params !== null) envelope.params = params;
	return {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(envelope),
	};
};

/**
 * Build a GET URL with JSON-RPC query parameters.
 *
 * @param endpoint_path - the RPC endpoint path (e.g., `/api/rpc`)
 * @param method - JSON-RPC method name
 * @param params - params object (omit for null-input methods)
 * @param id - request id (default `'test'`)
 * @returns the full URL with query string
 */
export const create_rpc_get_url = (
	endpoint_path: string,
	method: string,
	params?: unknown,
	id: string | number = 'test',
): string => {
	const search = new URLSearchParams({method, id: String(id)});
	if (params !== undefined && params !== null) {
		search.set('params', JSON.stringify(params));
	}
	return `${endpoint_path}?${search.toString()}`;
};

/**
 * Assert that a response body is a valid JSON-RPC error response.
 *
 * Validates the structure matches `JsonrpcErrorResponse` and optionally
 * checks the error code.
 *
 * @param body - parsed response body
 * @param expected_code - optional error code to assert
 */
export const assert_jsonrpc_error_response = (
	body: unknown,
	expected_code?: JsonrpcErrorCode,
): void => {
	const result = JsonrpcErrorResponse.safeParse(body);
	assert.ok(result.success, `not a valid JSON-RPC error response: ${JSON.stringify(body)}`);
	if (expected_code !== undefined) {
		assert.strictEqual(
			result.data.error.code,
			expected_code as number,
			`expected error code ${expected_code}, got ${result.data.error.code}`,
		);
	}
};

/**
 * Assert that a response body is a valid JSON-RPC success response.
 *
 * Validates the structure matches `JsonrpcResponse`. When `output_schema`
 * is provided, also validates the `result` field against the declared
 * output schema — matching the REST round-trip's `assert_response_matches_spec`.
 *
 * @param body - parsed response body
 * @param output_schema - optional Zod schema to validate the `result` field against
 */
export const assert_jsonrpc_success_response = (body: unknown, output_schema?: z.ZodType): void => {
	const result = JsonrpcResponse.safeParse(body);
	assert.ok(result.success, `not a valid JSON-RPC success response: ${JSON.stringify(body)}`);
	if (output_schema) {
		const output_result = output_schema.safeParse(result.data.result);
		assert.ok(
			output_result.success,
			`JSON-RPC result does not match output schema: ${JSON.stringify((output_result as any).error?.issues)}`,
		);
	}
};

// -- rpc_call: one-shot RPC over a Hono-ish app ------------------------------

/**
 * Minimal transport surface — the duck type `Hono.request` already satisfies.
 * Extracted so test setups that want an in-process / WS / mock path can plug
 * a different dispatcher without changing call sites.
 */
export type RpcTestTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Adapt a `Hono`-style app into an `RpcTestTransport`. */
export const http_transport =
	(app: {
		request: (input: string, init: RequestInit) => Promise<Response> | Response;
	}): RpcTestTransport =>
	async (url, init) =>
		app.request(url, init);

/** Discriminated return from `rpc_call`. `status` is the HTTP status. */
export type RpcCallResult =
	| {ok: true; status: number; result: unknown}
	| {
			ok: false;
			status: number;
			error: {code: number; message: string; data?: unknown};
	  };

/** Arguments for `rpc_call`. */
export interface RpcCallArgs {
	/** Hono-like app (anything with a `request(url, init)` method). */
	app: {request: (input: string, init: RequestInit) => Promise<Response> | Response};
	/** RPC endpoint path, e.g. `'/api/rpc'`. */
	path: string;
	/** JSON-RPC method name. */
	method: string;
	/** Params object. Omit or pass `null` for null-input methods. */
	params?: unknown;
	/** Extra request headers (session cookie, bearer, etc.). Overrides defaults. */
	headers?: Record<string, string>;
	/** Request id. Defaults to `'test'`. */
	id?: string | number;
	/** HTTP verb — `'POST'` (default) or `'GET'` for `side_effects: false` methods. */
	verb?: 'POST' | 'GET';
	/**
	 * Suppress the default `origin` header. Required for bearer-auth paths:
	 * `bearer_auth` discards the token when Origin or Referer is present
	 * (browser context), so probing it via `rpc_call` needs this flag — or
	 * use `rpc_call_non_browser`, which sets it for you.
	 */
	suppress_default_origin?: boolean;
}

/** Base default headers merged into every `rpc_call` request. */
const RPC_CALL_DEFAULT_HEADERS_BASE: Readonly<Record<string, string>> = {
	host: 'localhost',
	'Content-Type': 'application/json',
};

/** Default headers merged into every `rpc_call` request. Includes `origin`. */
const RPC_CALL_DEFAULT_HEADERS: Readonly<Record<string, string>> = {
	...RPC_CALL_DEFAULT_HEADERS_BASE,
	origin: 'http://localhost:5173',
};

/**
 * One-shot JSON-RPC call over a Hono app.
 *
 * Merges sensible defaults (`host`, `origin`, `Content-Type`) under
 * caller-provided headers, fires POST (default) or GET, parses the envelope,
 * and returns a discriminated result.
 *
 * Throws `Error` only on envelope-shape violations (neither
 * `JsonrpcResponse` nor `JsonrpcErrorResponse` parses) — protocol-level
 * failures the caller should never tolerate. All JSON-RPC errors come back
 * via `{ok: false, error}` so assertions can focus on `error.code` /
 * `error.data.reason`.
 */
export const rpc_call = async (args: RpcCallArgs): Promise<RpcCallResult> => {
	const {
		app,
		path,
		method,
		params,
		headers,
		id = 'test',
		verb = 'POST',
		suppress_default_origin,
	} = args;

	const defaults = suppress_default_origin
		? RPC_CALL_DEFAULT_HEADERS_BASE
		: RPC_CALL_DEFAULT_HEADERS;

	let url: string;
	let init: RequestInit;
	if (verb === 'GET') {
		url = create_rpc_get_url(path, method, params, id);
		init = {method: 'GET', headers: {...defaults, ...headers}};
	} else {
		url = path;
		const post = create_rpc_post_init(method, params, id);
		init = {
			method: 'POST',
			headers: {
				...defaults,
				...(post.headers as Record<string, string>),
				...headers,
			},
			body: post.body,
		};
	}

	const res = await app.request(url, init);
	const status = res.status;
	const body = await res.json();

	const success = JsonrpcResponse.safeParse(body);
	if (success.success) {
		return {ok: true, status, result: success.data.result};
	}
	const error = JsonrpcErrorResponse.safeParse(body);
	if (error.success) {
		return {
			ok: false,
			status,
			error: {
				code: error.data.error.code,
				message: error.data.error.message,
				data: error.data.error.data,
			},
		};
	}
	throw new Error(
		`rpc_call: response is not a valid JSON-RPC envelope (method=${method}, status=${status}): ${JSON.stringify(body)}`,
	);
};

/**
 * Same as `rpc_call` but without the default `origin` header. Use for
 * bearer-auth probes: `bearer_auth` discards the token when Origin or
 * Referer is present (browser context), so a bearer probe via `rpc_call`
 * would short-circuit to 401 before the token is ever validated.
 *
 * Equivalent to `rpc_call({...args, suppress_default_origin: true})`.
 */
export const rpc_call_non_browser = (
	args: Omit<RpcCallArgs, 'suppress_default_origin'>,
): Promise<RpcCallResult> => rpc_call({...args, suppress_default_origin: true});

/**
 * Same as `rpc_call` but parses the success `result` through the given
 * output schema and returns typed data. Envelope-level failures or error
 * responses throw — use the untyped `rpc_call` for tests that need to
 * assert on specific error shapes.
 */
export const rpc_call_typed = async <T>(
	args: RpcCallArgs,
	output_schema: z.ZodType<T>,
): Promise<T> => {
	const res = await rpc_call(args);
	if (!res.ok) {
		throw new Error(
			`rpc_call_typed(${args.method}) returned error: code=${res.error.code} message=${res.error.message} data=${JSON.stringify(res.error.data)}`,
		);
	}
	const parsed = output_schema.safeParse(res.result);
	if (!parsed.success) {
		throw new Error(
			`rpc_call_typed(${args.method}) result did not match output schema: ${JSON.stringify(parsed.error.issues)}`,
		);
	}
	return parsed.data;
};

// -- registry/surface lookup helpers -----------------------------------------

/**
 * Find the `RpcAction` for a method within a set of RPC endpoint specs.
 * Returns both the endpoint path and the matched action. `undefined` when
 * the method is not registered.
 */
export const find_rpc_action = (
	rpc_endpoints: ReadonlyArray<RpcEndpointSpec>,
	method: string,
): {path: string; action: RpcAction} | undefined => {
	for (const ep of rpc_endpoints) {
		for (const action of ep.actions) {
			if (action.spec.method === method) return {path: ep.path, action};
		}
	}
	return undefined;
};

/**
 * Find the generated surface entry for a method — the shape returned by
 * `generate_app_surface` (JSON-serializable, useful for schema assertions
 * at the boundary of a consumer test).
 */
export const find_rpc_method = (
	rpc_endpoints: ReadonlyArray<AppSurfaceRpcEndpoint>,
	method: string,
): {path: string; method_spec: AppSurfaceRpcMethod} | undefined => {
	for (const ep of rpc_endpoints) {
		for (const method_spec of ep.methods) {
			if (method_spec.name === method) return {path: ep.path, method_spec};
		}
	}
	return undefined;
};

/**
 * Resolve a single RPC endpoint path — the common case where a consumer
 * mounts exactly one `create_rpc_endpoint`. Throws when `rpc_endpoints` is
 * empty (hard-fail; see the suite options docs) or ambiguous (more than one
 * endpoint registered).
 *
 * Callers that need multi-endpoint support should iterate `rpc_endpoints`
 * directly.
 */
export const require_rpc_endpoint_path = (
	rpc_endpoints: ReadonlyArray<RpcEndpointSpec>,
): string => {
	if (rpc_endpoints.length === 0) {
		throw new Error(
			'rpc_endpoints is empty — the admin/audit integration suites require an RPC endpoint. Pass `rpc_endpoints` on the suite options.',
		);
	}
	if (rpc_endpoints.length > 1) {
		throw new Error(
			`rpc_endpoints has ${rpc_endpoints.length} entries; this helper expects exactly one. Iterate rpc_endpoints manually for multi-endpoint setups.`,
		);
	}
	return rpc_endpoints[0]!.path;
};
