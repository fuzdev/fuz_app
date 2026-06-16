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
 * docstring). RPC round-trip tests fire one JSON-RPC envelope per
 * method-direction and don't mutate state in a way that contaminates the
 * next case.
 *
 * @module
 */

import {describe, test, beforeAll, assert} from 'vitest';

import {ROLE_ADMIN} from '../auth/role_schema.ts';
import {JSONRPC_METHOD_NOT_FOUND, JsonrpcErrorResponse} from '../http/jsonrpc.ts';
import type {TestAccount} from './app_server.ts';
import {generate_valid_body} from './schema_generators.ts';
import type {AppSurfaceSpec, AppSurfaceRpcMethod} from '../http/surface.ts';
import {is_public_auth} from '../http/auth_shape.ts';
import {
	create_rpc_post_init,
	create_rpc_get_url,
	assert_jsonrpc_error_response,
	assert_jsonrpc_success_response,
	resolve_rpc_endpoints_for_setup,
	find_rpc_action,
	find_rpc_method,
	type RpcEndpointsSuiteOption,
} from './rpc_helpers.ts';
import type {KeeperHeaderProvider} from './integration_helpers.ts';
import type {BackendCapabilities} from './cross_backend/capabilities.ts';
import type {SetupTest, TestFixture} from './cross_backend/setup.ts';
import type {SessionOptions} from '../auth/session_cookie.ts';

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
	/** Backend capability declarations. */
	capabilities: BackendCapabilities;
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
	 */
	success_fixtures?: Map<string, (fixture: TestFixture) => Promise<Record<string, unknown>>>;
}

/**
 * Pick auth headers matching an RPC method's auth requirement. Accepts
 * any `KeeperHeaderProvider` — both `TestApp` (in-process) and
 * `TestFixture` (cross-backend) satisfy the shape structurally.
 */
const pick_rpc_auth_headers = (
	method: AppSurfaceRpcMethod,
	keeper: KeeperHeaderProvider,
	authed_account: TestAccount,
	admin_account: TestAccount,
): Record<string, string> => {
	const {auth} = method;
	if (is_public_auth(auth)) {
		return {host: 'localhost', origin: 'http://localhost:5173'};
	}
	if (auth.credential_types?.includes('daemon_token')) {
		return keeper.create_daemon_token_headers();
	}
	if (auth.roles?.length) {
		if (auth.roles.includes(ROLE_ADMIN)) {
			return admin_account.create_session_headers();
		}
		return keeper.create_session_headers();
	}
	return authed_account.create_session_headers();
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
				` returned method-not-found — backend is missing this method (parity gap)`,
		);
	}
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
 * `action.spec.output`. A `method not found` (-32601) error is the one
 * exception — it means the backend is missing a method the local surface
 * advertises, so the round-trip fails loud (`assert_method_implemented`)
 * rather than accepting it as a valid error envelope.
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
		options.session_options,
	);
	const surface_rpc_endpoints = options.surface_source.surface.rpc_endpoints;
	void options.capabilities;

	describe('RPC round-trip validation', () => {
		let fixture: TestFixture;
		let authed_account: TestAccount;
		let admin_account: TestAccount;

		beforeAll(async () => {
			fixture = await options.setup_test();
			authed_account = await fixture.create_account({
				username: 'rpc_round_trip_authed',
				roles: [],
			});
			admin_account = await fixture.create_account({
				username: 'rpc_round_trip_admin',
				roles: [ROLE_ADMIN],
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

					const headers = pick_rpc_auth_headers(
						surface_method,
						fixture,
						authed_account,
						admin_account,
					);

					const init = create_rpc_post_init(action.spec.method, params);
					Object.assign(init.headers as Record<string, string>, headers);

					const res = await fixture.transport(ep_spec.path, init);
					const body = await res.json();

					try {
						if (res.ok) {
							assert_jsonrpc_success_response(body, action.spec.output);
						} else {
							assert_method_implemented(action.spec.method, body);
							assert_jsonrpc_error_response(body);
						}
					} catch (e) {
						throw new Error(
							`RPC round-trip POST failed for ${action.spec.method} (status ${res.status}): ${(e as Error).message}`,
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

					const headers = pick_rpc_auth_headers(
						surface_method,
						fixture,
						authed_account,
						admin_account,
					);

					const url = create_rpc_get_url(ep_spec.path, action.spec.method, params);
					const res = await fixture.transport(url, {headers});
					const body = await res.json();

					try {
						if (res.ok) {
							assert_jsonrpc_success_response(body, action.spec.output);
						} else {
							assert_method_implemented(action.spec.method, body);
							assert_jsonrpc_error_response(body);
						}
					} catch (e) {
						throw new Error(
							`RPC round-trip GET failed for ${action.spec.method} (status ${res.status}): ${(e as Error).message}`,
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

				const params = await build(fixture);
				const headers = pick_rpc_auth_headers(
					surface.method_spec,
					fixture,
					authed_account,
					admin_account,
				);
				const init = create_rpc_post_init(method, params);
				Object.assign(init.headers as Record<string, string>, headers);

				const res = await fixture.transport(located.path, init);
				const body = await res.json();
				try {
					assert_method_implemented(method, body);
					assert.ok(
						res.ok,
						`success fixture expected a success response, got status ${res.status}: ${JSON.stringify(body)}`,
					);
					assert_jsonrpc_success_response(body, located.action.spec.output);
				} catch (e) {
					throw new Error(
						`RPC success-fixture failed for ${method} (status ${res.status}): ${(e as Error).message}`,
					);
				}
			}
		});
	});
};
