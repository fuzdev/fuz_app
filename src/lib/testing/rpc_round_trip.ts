import './assert_dev_env.ts';

/**
 * Schema-driven round-trip validation for RPC endpoints.
 *
 * For every RPC method, generates valid params and fires JSON-RPC requests
 * (POST for all methods, GET for reads), validating that responses are
 * well-formed JSON-RPC. Successful responses are validated against the
 * method's declared output schema. DB-backed via the suite's `setup_test`
 * fixture-producing callback.
 *
 * Cadence: per-describe `setup_test()` call (see `testing/round_trip.ts` module
 * docstring). The generic POST and GET cases fire one JSON-RPC envelope per
 * method-direction against shared principals (an authed account, an admin
 * account, the keeper). A side-effecting method called as the authed account
 * runs on a fresh account of its own (`round_trip_uses_fresh_account`):
 * the generated params of a self-targeting method act on the caller — an
 * `account_delete` with no `account_id` deletes it, an
 * `account_session_revoke_all` ends its session — and on the shared account
 * that would leave every later call refused as unauthenticated. A 401 to any
 * non-public call fails (`assert_rpc_authenticated`), so a credential lost
 * some other way goes red rather than vacuous. The `success_fixtures` case
 * also mutates — each fixture builds a row and the call revokes, deletes, or
 * decides it — so it runs last on the describe's fixture, and each factory
 * seeds its own rows.
 *
 * @module
 */

import { describe, test, beforeAll, assert } from 'vitest';

import { ROLE_ADMIN } from '../auth/role_schema.ts';
import {
	JSONRPC_INTERNAL_ERROR,
	JSONRPC_METHOD_NOT_FOUND,
	JsonrpcErrorResponse
} from '../http/jsonrpc.ts';
import { jsonrpc_error_code_to_http_status } from '../http/jsonrpc_errors.ts';
import type { TestAccount } from './app_server.ts';
import { generate_valid_body } from './schema_generators.ts';
import type { AppSurfaceSpec, AppSurfaceRpcMethod } from '../http/surface.ts';
import {
	create_rpc_post_init,
	create_rpc_get_url,
	assert_jsonrpc_error_response,
	assert_jsonrpc_success_response,
	resolve_rpc_endpoints_for_setup,
	find_rpc_action,
	find_rpc_method,
	type RpcEndpointsSuiteOption
} from './rpc_helpers.ts';
import {
	is_unauthenticated_refusal,
	pick_auth_principal,
	round_trip_uses_fresh_account,
	to_principal_headers,
	type AuthPrincipal,
	type KeeperHeaderProvider
} from './integration_helpers.ts';
import type { SetupTest, TestFixture } from './cross_backend/setup.ts';
import type { SessionOptions } from '../auth/session_cookie.ts';

/** Options for `describe_rpc_round_trip_tests`. */
export interface RpcRoundTripTestOptions {
	/** Per-test fixture-producing function (per-describe cadence). */
	setup_test: SetupTest;
	/**
	 * App surface (with route + RPC endpoint specs) for RPC endpoint
	 * enumeration. Constructed in TS by the consumer; same shape for
	 * in-process and cross-process tests.
	 */
	surface_source: AppSurfaceSpec;
	/**
	 * Session config — only needed to resolve factory-form `rpc_endpoints`
	 * against a stub `AppServerContext` at setup time (the actions' input
	 * schemas drive params generation; auth/dispatch run against the real
	 * backend through `fixture.transport`).
	 */
	session_options: SessionOptions<string>;
	/**
	 * RPC endpoint specs — eager array or factory. The factory must return
	 * the same endpoint `path` + `spec.method` list regardless of ctx
	 * (invoked once at setup with a stub ctx; the real per-test live
	 * dispatch goes through whatever the backend was started with).
	 */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/** Methods to skip, by name (e.g., `'zap_plan'`). */
	skip_methods?: Array<string>;
	/** Override generated params for specific methods (method name → params). */
	input_overrides?: Map<string, Record<string, unknown>>;
	/**
	 * Success-case fixtures for methods whose **populated success body** the
	 * generic nil-id input can't reach — referential reads (`*_get`, `*_log`)
	 * whose required ids must point at existing rows. Maps method name to an
	 * async factory that receives the per-test `fixture` (so it can seed the
	 * referenced state — e.g. create a repo via `fixture.transport` +
	 * `fixture.create_session_headers()`) and returns the params that drive a
	 * **success** response.
	 *
	 * Distinct from `input_overrides`, which only swaps the request params; the
	 * response may still be a valid *error* envelope (missing-row `not_found`),
	 * which the generic loop accepts. A `success_fixtures` entry **asserts the
	 * response is `ok`** and validates `result` against the method's `output`
	 * schema — so a backend that drops a field, or errors where the other
	 * backend succeeds, fails loud. This is the success-shape parity check the
	 * nil-id round-trip structurally cannot perform (it only ever sees error
	 * envelopes for referential methods).
	 *
	 * Fired as POST. The factory runs against the shared per-describe fixture,
	 * so it must not assume a clean slate between entries (seed unique state).
	 * By default the request carries the identity the generic loop picks for
	 * the method's auth (`authed` / `admin` / keeper); a case that returns
	 * `headers` sends those instead — for methods whose row must belong to the
	 * caller (revoking one's own token or session, retracting one's own offer).
	 * `create_spine_rpc_success_fixtures` (`cross_backend/rpc_success_fixtures.ts`)
	 * builds the map for the standard spine methods.
	 */
	success_fixtures?: RpcSuccessFixtures;
}

/** One success-fixture request: the params, and optionally the caller's headers. */
export interface RpcSuccessFixtureCase {
	/** Params that drive a success response. */
	params: Record<string, unknown>;
	/**
	 * Auth headers to send in place of the identity the suite picks from the
	 * method's auth — for a row that only its owner may act on.
	 */
	headers?: Record<string, string>;
}

/** One success-fixture factory: builds the row against the per-test fixture, then returns the request. */
export type RpcSuccessFixture = (fixture: TestFixture) => Promise<RpcSuccessFixtureCase>;

/** Success-case fixtures, method name → async factory. See `RpcRoundTripTestOptions.success_fixtures`. */
export type RpcSuccessFixtures = Map<string, RpcSuccessFixture>;

/** A picked principal and the headers that carry its credential. */
export interface RpcRoundTripAuth {
	principal: AuthPrincipal;
	headers: Record<string, string>;
}

/**
 * Pick the principal matching an RPC method's auth requirement
 * (`pick_auth_principal`, shared with the REST round-trip), and the headers
 * carrying its credential. Accepts any `KeeperHeaderProvider` — both `TestApp`
 * (in-process) and `TestFixture` (cross-backend) satisfy the shape
 * structurally.
 */
export const pick_rpc_auth = (
	method: AppSurfaceRpcMethod,
	keeper: KeeperHeaderProvider,
	authed_account: TestAccount,
	admin_account: TestAccount
): RpcRoundTripAuth => {
	const principal = pick_auth_principal(method.auth);
	return {
		principal,
		headers: to_principal_headers(principal, keeper, authed_account, admin_account)
	};
};

/**
 * Guard against a refusal that says the call carried no valid credential
 * when it carried one (`is_unauthenticated_refusal`). The round-trip sends
 * every non-public method a live credential its auth admits, so such a 401
 * means the backend failed to authenticate it — most often because an earlier
 * call destroyed it (a self-delete, a revoke-all), which would turn every
 * later method's coverage into a vacuous refusal. A public method may still
 * answer 401 (a login with a wrong password), and so may a handler refusing
 * an authenticated call with a reason of its own (`invalid_credentials`).
 *
 * @param method - the RPC method name
 * @param status - the HTTP status
 * @param body - the parsed response body (or raw text when not JSON)
 * @param principal - the principal the call was sent as
 */
export const assert_rpc_authenticated = (
	method: string,
	status: number,
	body: unknown,
	principal: AuthPrincipal
): void => {
	if (principal === 'public') return;
	const parsed = JsonrpcErrorResponse.safeParse(body);
	const data = parsed.success ? parsed.data.error.data : undefined;
	const reason =
		data !== null && typeof data === 'object' ? (data as { reason?: unknown }).reason : undefined;
	if (!is_unauthenticated_refusal(status, reason)) return;
	const detail = parsed.success
		? `code ${parsed.data.error.code}, message ${JSON.stringify(parsed.data.error.message)}${
				data === undefined ? '' : `, data ${JSON.stringify(data)}`
			}`
		: `body ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`;
	assert.fail(
		`method '${method}' answered 401 to the ${principal} principal's credential (${detail})` +
			' — the call carried a credential its auth admits, so the backend owed an' +
			' authenticated answer; a 401 here means that credential stopped working'
	);
};

/**
 * Guard against silent parity gaps: a method enumerated from the local action
 * surface that the remote backend answers with `method not found` (-32601)
 * means the backend is missing an implementation the local surface advertises.
 * That is a well-formed JSON-RPC error, so the round-trip's
 * `assert_jsonrpc_error_response` branch would otherwise accept it as a pass —
 * masking missing methods across coequal backends. Fail loud instead, before
 * the generic error-envelope acceptance runs.
 *
 * Only `JSONRPC_METHOD_NOT_FOUND` trips this — every other well-formed error
 * (validation, `not_found` from missing DB state, auth denials) stays a valid
 * round-trip outcome.
 */
const assert_method_implemented = (method: string, body: unknown): void => {
	const parsed = JsonrpcErrorResponse.safeParse(body);
	if (parsed.success && parsed.data.error.code === JSONRPC_METHOD_NOT_FOUND) {
		assert.fail(
			`method '${method}' is registered on the local surface but the backend` +
				` returned method-not-found — backend is missing this method (parity gap)`
		);
	}
};

/**
 * Read a response body as JSON, falling back to the raw text — a crashed
 * backend may answer with a non-JSON body (an HTML or plain-text 500), and
 * the round-trip must report that response, not a JSON parse error with no
 * method attached.
 */
const read_rpc_body = async (res: Response): Promise<unknown> => {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

/** The HTTP status an `internal_error` maps to, read off the shared status table. */
const INTERNAL_ERROR_HTTP_STATUS = jsonrpc_error_code_to_http_status(JSONRPC_INTERNAL_ERROR);

/**
 * Guard against a backend that crashes on schema-valid input. A response is
 * a crash when any of these holds:
 *
 * - its HTTP status is the one `internal_error` maps to (500) — what an
 *   uncaught throw and an unmapped error code both answer
 * - its JSON-RPC code is `internal_error` (-32603)
 * - its status is ≥500 and its body is not a well-formed JSON-RPC error
 *   envelope (an HTML or plain-text crash page)
 *
 * Any other ≥500 that carries a well-formed envelope with a declared code
 * passes like a 4xx: `service_unavailable` (503), `timeout` (504), or a
 * consumer's own code declared with `register_jsonrpc_error_code` (a 502).
 * Those are server conditions a handler declares on purpose — a dependency
 * the test environment doesn't provide — while an undeclared 500 or -32603
 * is a handler that failed where it owed an answer.
 *
 * @param method - the RPC method name
 * @param status - the HTTP status
 * @param body - the parsed response body (or raw text when not JSON)
 * @param expected - what the call owed: a refusal (the generic nil-id loop)
 *   or a success (a declared success fixture), for the failure message
 */
const assert_not_crash = (
	method: string,
	status: number,
	body: unknown,
	expected: 'refusal' | 'success'
): void => {
	const parsed = JsonrpcErrorResponse.safeParse(body);
	const code = parsed.success ? parsed.data.error.code : null;
	const crashed = parsed.success
		? status === INTERNAL_ERROR_HTTP_STATUS || code === JSONRPC_INTERNAL_ERROR
		: status >= 500;
	if (!crashed) return;
	const message = parsed.success
		? parsed.data.error.message
		: typeof body === 'string'
			? body.slice(0, 500)
			: JSON.stringify(body).slice(0, 500);
	assert.fail(
		`method '${method}' crashed on ${
			expected === 'success' ? 'its success fixture' : 'schema-valid params'
		} (status ${status}, code ${code ?? 'none'}, message ${JSON.stringify(message)})` +
			(expected === 'success'
				? ' — the fixture built a real row, so the backend owed a success here'
				: ' — the backend owes a declared refusal here (a 4xx, or a declared 5xx code)')
	);
};

/**
 * Assert a non-ok response is an acceptable refusal: the method exists, the
 * failure is not a crash (`assert_not_crash`), an authenticated call was not
 * refused as unauthenticated (`assert_rpc_authenticated`), and the body is a
 * well-formed JSON-RPC error envelope.
 */
const assert_rpc_refusal = (
	method: string,
	status: number,
	body: unknown,
	principal: AuthPrincipal
): void => {
	assert_method_implemented(method, body);
	assert_not_crash(method, status, body, 'refusal');
	assert_rpc_authenticated(method, status, body, principal);
	assert_jsonrpc_error_response(body);
};

/**
 * Run schema-driven round-trip validation for RPC endpoints.
 *
 * For each method:
 * 1. Generate valid params from the action's input schema
 * 2. Fire a POST request with JSON-RPC envelope
 * 3. For `side_effects: false` methods, also fire a GET request
 * 4. Validate response is well-formed JSON-RPC; successful responses are
 *    also validated against the method's declared output schema
 *
 * Error responses (from missing DB state, etc.) are expected and validated
 * as well-formed JSON-RPC errors. Successful responses are validated against
 * `action.spec.output`. Two error classes fail loud instead of passing as a
 * valid envelope: `method not found` (-32601) means the backend is missing a
 * method the local surface advertises (`assert_method_implemented`), and a
 * crash — HTTP 500, `internal_error` (-32603), or a ≥500 with no JSON-RPC
 * envelope — means the backend failed on schema-valid input
 * (`assert_not_crash`). A declared ≥500 code (`service_unavailable`,
 * `timeout`) passes as a refusal. A method the suite can't drive generically
 * goes in `skip_methods`; one whose generated params can't reach its handler
 * gets an `input_overrides` entry.
 */
export const describe_rpc_round_trip_tests = (options: RpcRoundTripTestOptions): void => {
	const skip_set = new Set(options.skip_methods);
	// Resolve factory-form endpoints once for setup-time iteration (method
	// enumeration, surface lookup). The live dispatcher runs against
	// whatever the backend was started with — `action.spec.method` /
	// `.input` / `.output` are ctx-independent, so the stub-resolved specs
	// match what the running backend serves.
	const rpc_endpoints_for_setup = resolve_rpc_endpoints_for_setup(
		options.rpc_endpoints,
		options.session_options
	);
	const surface_rpc_endpoints = options.surface_source.surface.rpc_endpoints;

	describe('RPC round-trip validation', () => {
		let fixture: TestFixture;
		let authed_account: TestAccount;
		let admin_account: TestAccount;

		beforeAll(async () => {
			fixture = await options.setup_test();
			authed_account = await fixture.create_account({
				username: 'rpc_round_trip_authed',
				roles: []
			});
			admin_account = await fixture.create_account({
				username: 'rpc_round_trip_admin',
				roles: [ROLE_ADMIN]
			});
		});

		test('all RPC methods produce valid JSON-RPC responses (POST)', async () => {
			for (const ep_spec of rpc_endpoints_for_setup) {
				const surface_ep = surface_rpc_endpoints.find((e) => e.path === ep_spec.path);
				if (!surface_ep) continue;

				for (const action of ep_spec.actions) {
					if (skip_set.has(action.spec.method)) continue;

					const surface_method = surface_ep.methods.find((m) => m.name === action.spec.method);
					if (!surface_method) continue;

					const override = options.input_overrides?.get(action.spec.method);
					const params = override ?? generate_valid_body(action.spec.input) ?? null;

					const picked = pick_rpc_auth(surface_method, fixture, authed_account, admin_account);
					const { principal, headers } = round_trip_uses_fresh_account(
						picked.principal,
						action.spec.side_effects
					)
						? pick_rpc_auth(
								surface_method,
								fixture,
								await fixture.create_account({ roles: [] }),
								admin_account
							)
						: picked;

					const init = create_rpc_post_init(action.spec.method, params);
					Object.assign(init.headers as Record<string, string>, headers);

					const res = await fixture.transport(ep_spec.path, init);
					const body = await read_rpc_body(res);

					try {
						if (res.ok) {
							assert_jsonrpc_success_response(body, action.spec.output);
						} else {
							assert_rpc_refusal(action.spec.method, res.status, body, principal);
						}
					} catch (e) {
						throw new Error(
							`RPC round-trip POST failed for ${action.spec.method} (status ${res.status}): ${
								(e as Error).message
							}`
						);
					}
				}
			}
		});

		test('all read RPC methods produce valid JSON-RPC responses (GET)', async () => {
			for (const ep_spec of rpc_endpoints_for_setup) {
				const surface_ep = surface_rpc_endpoints.find((e) => e.path === ep_spec.path);
				if (!surface_ep) continue;

				const read_actions = ep_spec.actions.filter((a) => !a.spec.side_effects);
				for (const action of read_actions) {
					if (skip_set.has(action.spec.method)) continue;

					const surface_method = surface_ep.methods.find((m) => m.name === action.spec.method);
					if (!surface_method) continue;

					const override = options.input_overrides?.get(action.spec.method);
					const params = override ?? generate_valid_body(action.spec.input) ?? undefined;

					const { principal, headers } = pick_rpc_auth(
						surface_method,
						fixture,
						authed_account,
						admin_account
					);

					const url = create_rpc_get_url(ep_spec.path, action.spec.method, params);
					const res = await fixture.transport(url, { headers });
					const body = await read_rpc_body(res);

					try {
						if (res.ok) {
							assert_jsonrpc_success_response(body, action.spec.output);
						} else {
							assert_rpc_refusal(action.spec.method, res.status, body, principal);
						}
					} catch (e) {
						throw new Error(
							`RPC round-trip GET failed for ${action.spec.method} (status ${res.status}): ${
								(e as Error).message
							}`
						);
					}
				}
			}
		});

		test('declared success fixtures produce schema-valid success bodies', async () => {
			const success_fixtures = options.success_fixtures;
			if (!success_fixtures || success_fixtures.size === 0) return;
			for (const [method, build] of success_fixtures) {
				const located = find_rpc_action(rpc_endpoints_for_setup, method);
				assert.ok(located, `success_fixtures references unknown RPC method '${method}'`);
				const surface = find_rpc_method(surface_rpc_endpoints, method);
				assert.ok(surface, `success_fixtures method '${method}' missing from generated surface`);

				const fixture_case = await build(fixture);
				const headers =
					fixture_case.headers ??
					pick_rpc_auth(surface.method_spec, fixture, authed_account, admin_account).headers;
				const init = create_rpc_post_init(method, fixture_case.params);
				Object.assign(init.headers as Record<string, string>, headers);

				const res = await fixture.transport(located.path, init);
				const body = await read_rpc_body(res);
				try {
					assert_method_implemented(method, body);
					assert_not_crash(method, res.status, body, 'success');
					assert.ok(
						res.ok,
						`success fixture expected a success response, got status ${
							res.status
						}: ${JSON.stringify(body)}`
					);
					assert_jsonrpc_success_response(body, located.action.spec.output);
				} catch (e) {
					throw new Error(
						`RPC success-fixture failed for ${method} (status ${res.status}): ${
							(e as Error).message
						}`
					);
				}
			}
		});
	});
};
