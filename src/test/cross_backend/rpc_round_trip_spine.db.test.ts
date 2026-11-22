/**
 * In-process leg of the spine RPC round-trip with its success fixtures.
 *
 * Runs `describe_rpc_round_trip_tests` over the full spine RPC surface with
 * `create_spine_rpc_success_fixtures`, so the row-acting methods (token and
 * session revoke, invite delete, role grant revoke, offer accept / decline /
 * retract) have their success bodies validated in-process too. The
 * cross-process leg is `spine_suites.cross.test.ts`, through the standard bundle.
 *
 * @module
 */

import { SESSION_COOKIE_NAME } from '#lib/auth/session_cookie.ts';
import { describe_rpc_round_trip_tests } from '#lib/testing/rpc_round_trip.ts';
import { default_in_process_suite_options } from '#lib/testing/cross_backend/in_process_setup.ts';
import { create_spine_rpc_success_fixtures } from '#lib/testing/cross_backend/rpc_success_fixtures.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints
} from '#lib/testing/cross_backend/default_spine_surface.ts';

describe_rpc_round_trip_tests({
	...default_in_process_suite_options({
		session_cookie_name: SESSION_COOKIE_NAME,
		create_route_specs: create_spine_route_specs,
		rpc_endpoints: spine_rpc_endpoints
	}),
	success_fixtures: create_spine_rpc_success_fixtures()
});
