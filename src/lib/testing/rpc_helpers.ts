import './assert_dev_env.js';

/**
 * JSON-RPC test helpers — request construction, response assertion, and
 * one-shot call ergonomics.
 *
 * Shared by `testing/rpc_attack_surface.ts`, `testing/rpc_round_trip.ts`, and
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
import type {RequestResponseActionSpec} from '../actions/action_spec.js';
import type {RpcAction} from '../actions/action_rpc.js';
import type {AppSurfaceRpcEndpoint, AppSurfaceRpcMethod, RpcEndpointSpec} from '../http/surface.js';
import type {AppServerContext} from '../server/app_server.js';
import type {SessionOptions} from '../auth/session_cookie.js';
import {create_stub_app_server_context} from './stubs.js';

/**
 * Union accepted by the suite-level `rpc_endpoints` option — eager array or
 * a factory that takes an `AppServerContext` and returns endpoint specs. The
 * factory form is required when action handlers must close over the
 * per-test `ctx.app_settings` / `ctx.deps` (e.g. the canonical
 * `create_standard_rpc_actions(ctx.deps, {app_settings: ctx.app_settings})`
 * pattern). `create_app_server` resolves either shape natively; test helpers
 * forward the raw value to `app_options.rpc_endpoints` for live dispatch.
 */
export type RpcEndpointsSuiteOption =
	| Array<RpcEndpointSpec>
	| ((ctx: AppServerContext) => Array<RpcEndpointSpec>);

/**
 * Resolve a suite's `rpc_endpoints` option to an array for setup-time
 * inspection (path lookup, action presence checks).
 *
 * For the factory form this invokes the factory twice with stub
 * `AppServerContext`s and asserts that both invocations produce the same
 * (path, method-list) shape — catching factories that close over mutable
 * state or otherwise diverge across calls. The first array is returned;
 * the second is discarded after the comparison. `create_app_server`
 * invokes the factory again per-test with its real ctx, and those are
 * the handlers that actually serve requests.
 *
 * Safe as long as the factory is pure with respect to the endpoint `path`
 * and the action `spec.method` list — the canonical helpers
 * (`create_standard_rpc_actions`, `create_admin_actions`, `create_account_actions`,
 * etc.) are. Factories that return a different `path` based on `ctx` will
 * produce a setup/runtime mismatch; the path-purity assert below surfaces
 * that as a clear `gro check` error rather than a silent test/runtime drift.
 *
 * @throws Error if the factory's two stub-ctx invocations produce different
 *   `(path, method-list)` shapes — surfaces non-pure factories at setup time.
 */
export const resolve_rpc_endpoints_for_setup = (
	rpc_endpoints: RpcEndpointsSuiteOption,
	session_options: SessionOptions<string>,
): Array<RpcEndpointSpec> => {
	if (typeof rpc_endpoints !== 'function') return rpc_endpoints;
	const first = rpc_endpoints(create_stub_app_server_context(session_options));
	const second = rpc_endpoints(create_stub_app_server_context(session_options));
	const summarize = (eps: Array<RpcEndpointSpec>): string =>
		JSON.stringify(
			eps
				.map((ep) => ({
					path: ep.path,
					methods: ep.actions.map((a) => a.spec.method).sort(),
				}))
				.sort((a, b) => a.path.localeCompare(b.path)),
		);
	const summary_a = summarize(first);
	const summary_b = summarize(second);
	if (summary_a !== summary_b) {
		throw new Error(
			'rpc_endpoints factory is not path-pure: two invocations with equivalent stub ctxs produced different (path, method) shapes. ' +
				`The factory must be pure wrt endpoint path and action method list — see ../testing/rpc_helpers.ts. ` +
				`first=${summary_a} second=${summary_b}`,
		);
	}
	return first;
};

/**
 * Create a `RequestInit` for a JSON-RPC POST request.
 *
 * @param method - JSON-RPC method name
 * @param params - params (omit for parameterless methods; `null` is also
 *                stripped for ergonomic call sites — JSON-RPC 2.0 §4.2
 *                forbids `"params": null` on the wire, and `create_rpc_endpoint`
 *                rejects `z.null()` action input schemas at registration).
 *                Tests that need to construct a literal `"params": null`
 *                envelope (e.g. asserting envelope-level rejection) should
 *                build the body inline rather than route through this helper.
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
 * @param params - params (omit for parameterless methods)
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
	/**
	 * Params for the call. Omit (or pass `undefined`) for parameterless
	 * (`z.void()`) methods — the helper drops `params` from the envelope
	 * either way. See `create_rpc_post_init` for the null-stripping
	 * affordance and JSON-RPC 2.0 §4.2's prohibition on `params: null`.
	 */
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
 * @throws Error if the response body is neither a valid `JsonrpcResponse`
 *   nor `JsonrpcErrorResponse` envelope — protocol-level failures the caller
 *   should never tolerate. All JSON-RPC errors come back via `{ok: false, error}`
 *   so assertions can focus on `error.code` / `error.data.reason`.
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
 * Typed discriminated result returned by `rpc_call_for_spec`. The success
 * branch's `result` is inferred from `TSpec['output']`. The error branch
 * stays untyped because JSON-RPC `error.data` shapes vary per error and
 * are asserted per call site.
 */
export type RpcCallResultForSpec<TSpec extends RequestResponseActionSpec> =
	| {ok: true; status: number; result: z.infer<TSpec['output']>}
	| {ok: false; status: number; error: {code: number; message: string; data?: unknown}};

/** Arguments for `rpc_call_for_spec`. `spec` replaces the loose `method` field. */
export type RpcCallForSpecArgs<TSpec extends RequestResponseActionSpec> = Omit<
	RpcCallArgs,
	'method' | 'params'
> & {
	/** Action spec whose `method` drives the envelope and whose `input`/`output` types pin params + result. */
	spec: TSpec;
	/** Params, typed against `spec.input`. */
	params: z.infer<TSpec['input']>;
};

/**
 * Typed wrapper over `rpc_call` — binds `params` to `z.infer<spec.input>`
 * and the success `result` to `z.infer<spec.output>` via the generic.
 *
 * Success results are validated at runtime against `spec.output` (same
 * contract as `rpc_call_typed`); a mismatch throws. Error responses come
 * back on the discriminated `{ok: false, error}` branch — use this for
 * happy-path + denial-path assertions where the error `data.reason` shape
 * is still asserted manually. For adversarial input tests that send
 * malformed params, use the untyped `rpc_call`.
 *
 * @throws Error if the success `result` does not parse against `spec.output`,
 *   or if `rpc_call` itself throws on an envelope violation.
 */
export const rpc_call_for_spec = async <TSpec extends RequestResponseActionSpec>(
	args: RpcCallForSpecArgs<TSpec>,
): Promise<RpcCallResultForSpec<TSpec>> => {
	const {spec, params, ...rest} = args;
	const res = await rpc_call({...rest, method: spec.method, params});
	if (!res.ok) {
		return res;
	}
	const parsed = spec.output.safeParse(res.result);
	if (!parsed.success) {
		throw new Error(
			`rpc_call_for_spec(${spec.method}) result did not match spec.output: ${JSON.stringify(parsed.error.issues)}`,
		);
	}
	return {ok: true, status: res.status, result: parsed.data as z.infer<TSpec['output']>};
};

/**
 * Same as `rpc_call` but parses the success `result` through the given
 * output schema and returns typed data. Envelope-level failures or error
 * responses throw — use the untyped `rpc_call` for tests that need to
 * assert on specific error shapes.
 *
 * @throws Error if the response is a JSON-RPC error, if `rpc_call` throws
 *   on an envelope violation, or if the result fails `output_schema.safeParse`.
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
 * mounts exactly one `create_rpc_endpoint`.
 *
 * Used at suite setup time to hard-fail integration suites (admin / audit /
 * SSE / rate-limiting) when the consumer omitted `rpc_endpoints` rather
 * than letting tests fail mid-run with confusing errors.
 *
 * Callers that need multi-endpoint support should iterate `rpc_endpoints`
 * directly.
 *
 * @throws Error if `rpc_endpoints` is empty (hard-fail; see the suite options
 *   docs) or has more than one entry (ambiguous).
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
