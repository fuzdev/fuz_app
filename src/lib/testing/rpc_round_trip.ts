import './assert_dev_env.js';

/**
 * Schema-driven round-trip validation for RPC endpoints.
 *
 * For every RPC method, generates valid params and fires JSON-RPC requests
 * (POST for all methods, GET for reads), validating that responses are
 * well-formed JSON-RPC. Successful responses are validated against the
 * method's declared output schema. DB-backed via the suite's `setup_test`
 * fixture-producing callback.
 *
 * Cadence: per-describe `setup_test()` call (see `round_trip.ts` module
 * docstring). RPC round-trip tests fire one JSON-RPC envelope per
 * method-direction and don't mutate state in a way that contaminates the
 * next case.
 *
 * @module
 */

import {describe, test, beforeAll} from 'vitest';

import {ROLE_ADMIN} from '../auth/role_schema.js';
import type {TestAccount} from './app_server.js';
import {generate_valid_body} from './schema_generators.js';
import type {AppSurfaceSpec, AppSurfaceRpcMethod} from '../http/surface.js';
import {is_public_auth} from '../http/auth_shape.js';
import {
	create_rpc_post_init,
	create_rpc_get_url,
	assert_jsonrpc_error_response,
	assert_jsonrpc_success_response,
	resolve_rpc_endpoints_for_setup,
	type RpcEndpointsSuiteOption,
} from './rpc_helpers.js';
import type {KeeperHeaderProvider} from './integration_helpers.js';
import type {BackendCapabilities} from './cross_backend/capabilities.js';
import type {SetupTest, TestFixture} from './cross_backend/setup.js';
import type {SessionOptions} from '../auth/session_cookie.js';

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
 * `action.spec.output`.
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
	});
};
