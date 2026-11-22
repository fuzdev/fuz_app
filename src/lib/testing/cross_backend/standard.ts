import '../assert_dev_env.ts';

/**
 * The standard suites against a spawned backend that fuz_app's transcript
 * differential can't run: `describe_middleware_gate_tests`, whose probes write
 * raw request heads over a socket, and `describe_round_trip_validation`,
 * `describe_rpc_round_trip_tests` and `describe_data_exposure_tests`, which
 * build fixtures outside a test. The standard auth suites, which it can, are
 * `standard_auth.ts`; `describe_standard_cross_process_tests`
 * (`standard_bundle.ts`) runs both in one call.
 *
 * @module
 */

import type { AppSurfaceSpec } from '../../http/surface.ts';
import { describe_middleware_gate_tests } from '../middleware_gate_probes.ts';
import { describe_round_trip_validation } from '../round_trip.ts';
import { describe_rpc_round_trip_tests, type RpcSuccessFixtures } from '../rpc_round_trip.ts';
import { describe_data_exposure_tests } from '../data_exposure.ts';
import type { RpcEndpointsSuiteOption } from '../rpc_helpers.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import type { RouteParamValues } from '../schema_generators.ts';
/** Configuration for `describe_standard_cross_tests`. */
export interface StandardCrossTestOptions {
	/** Per-test fixture-producing function. */
	setup_test: SetupTest;
	/**
	 * App surface. Constructed in TS by the consumer; same shape for
	 * in-process and cross-process tests.
	 */
	surface_source: AppSurfaceSpec;
	/** The session cookie's name — read for the factory-form `rpc_endpoints` resolution. */
	session_cookie_name: string;
	/** RPC endpoint specs — the RPC round trip drives every method on them. */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/**
	 * Base URL the spawned backend is reachable at. Forwarded to
	 * `describe_middleware_gate_tests`, whose probes write their request heads
	 * to the socket.
	 */
	base_url: string;
	/**
	 * Forwarded to `describe_middleware_gate_tests` — the backend's
	 * request-body cap on every counted route but the RPC endpoint, when it
	 * isn't the spine default.
	 */
	max_body_bytes?: number;
	/**
	 * Forwarded to `describe_middleware_gate_tests` — the backend's
	 * request-body cap on the RPC endpoint, when it isn't `max_body_bytes`.
	 */
	rpc_max_body_bytes?: number;
	/**
	 * Forwarded to `describe_round_trip_validation` as `skip_routes`
	 * (`'METHOD /path'` keys). For consumer REST routes whose responses
	 * aren't JSON-with-an-output-schema and so can't be round-tripped — e.g.
	 * fuz_forge's git smart-HTTP routes (`git-upload-pack` / `git-receive-pack`
	 * / `info/refs`) which stream git protocol bytes.
	 */
	round_trip_skip_routes?: Array<string>;
	/**
	 * Forwarded to `describe_data_exposure_tests` as `skip_routes`
	 * (`'METHOD /path'` keys for routes, `'/path method_name'` for RPC or WS
	 * method outputs, `'/path method_name params'` for params the server pushes
	 * over WS), as the in-process bundle's consumers pass it directly.
	 */
	data_exposure_skip_routes?: Array<string>;
	/**
	 * Forwarded to `describe_round_trip_validation` and
	 * `describe_data_exposure_tests` as `param_values` (`'METHOD /path'` →
	 * param name → value), for a `{re}` param whose pattern refuses the
	 * generated value. See `RouteParamValues`.
	 */
	param_values?: RouteParamValues;
	/**
	 * Forwarded to `describe_rpc_round_trip_tests` as `success_fixtures`
	 * (method name → async params factory). Drives a populated **success**
	 * body for referential RPC reads (`*_get`, `*_log`) the nil-id round-trip
	 * can only ever error on, and validates it against the method's `output`
	 * schema on each backend — the success-shape parity check. See
	 * `RpcRoundTripTestOptions.success_fixtures`.
	 */
	rpc_success_fixtures?: RpcSuccessFixtures;
	/**
	 * Forwarded to `describe_rpc_round_trip_tests` as `skip_methods` — the
	 * consumer escape hatch for a method the generic round-trip can't drive at
	 * all (a handler whose test wiring stubs out the deps it reaches, or reads
	 * tables the suite's database doesn't migrate). Each entry hides the
	 * method from both the crash check and the envelope check, so name the
	 * reason beside it.
	 */
	rpc_skip_methods?: Array<string>;
	/**
	 * Forwarded to `describe_rpc_round_trip_tests` as `input_overrides`
	 * (method name → params) — for a method whose generated params can't
	 * reach its handler cleanly. The response is held to the same rules as a
	 * generated one.
	 */
	rpc_input_overrides?: Map<string, Record<string, unknown>>;
	/**
	 * Forwarded to `describe_round_trip_validation` as `success_fixtures`
	 * (`'METHOD /path'` → async `{url?, body?}` factory) for referential REST
	 * routes. See `RoundTripTestOptions.success_fixtures`.
	 */
	rest_success_fixtures?: Map<
		string,
		(fixture: TestFixture) => Promise<{ url?: string; body?: Record<string, unknown> }>
	>;
}

/**
 * Run the standard suites the transcript can't — the middleware-gate probes,
 * round trip, RPC round trip, data exposure.
 */
export const describe_standard_cross_tests = (options: StandardCrossTestOptions): void => {
	describe_middleware_gate_tests({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		session_cookie_name: options.session_cookie_name,
		rpc_endpoints: options.rpc_endpoints,
		base_url: options.base_url,
		max_body_bytes: options.max_body_bytes,
		rpc_max_body_bytes: options.rpc_max_body_bytes
	});
	describe_round_trip_validation({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		skip_routes: options.round_trip_skip_routes,
		success_fixtures: options.rest_success_fixtures,
		param_values: options.param_values
	});
	describe_rpc_round_trip_tests({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		session_cookie_name: options.session_cookie_name,
		rpc_endpoints: options.rpc_endpoints,
		skip_methods: options.rpc_skip_methods,
		input_overrides: options.rpc_input_overrides,
		success_fixtures: options.rpc_success_fixtures
	});
	describe_data_exposure_tests({
		setup_test: options.setup_test,
		surface_source: options.surface_source,
		skip_routes: options.data_exposure_skip_routes,
		param_values: options.param_values
	});
};
