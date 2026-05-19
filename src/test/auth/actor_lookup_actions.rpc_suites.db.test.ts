/**
 * Composable RPC suite coverage for the `actor_lookup` action.
 *
 * Wires `describe_rpc_attack_surface_tests` (stub-deps, no DB) and
 * `describe_rpc_round_trip_tests` (PGlite) against the single action
 * produced by `create_actor_lookup_actions`. Auto-covers per-method auth
 * enforcement, adversarial envelopes, adversarial params, and output-
 * schema validation. Method-specific wire semantics
 * (`display_name` omitted-not-null, unknown-id absence) live in
 * ./actor_lookup_actions.db.test.ts.
 *
 * @module
 */

import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_test_app_surface_spec} from '$lib/testing/stubs.js';
import {describe_rpc_attack_surface_tests} from '$lib/testing/rpc_attack_surface.js';
import {describe_rpc_round_trip_tests} from '$lib/testing/rpc_round_trip.js';
import {default_in_process_suite_options} from '$lib/testing/cross_backend/setup.js';
import {create_actor_lookup_actions} from '$lib/auth/actor_lookup_actions.js';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RouteSpec} from '$lib/http/route_spec.js';

const log = new Logger('test', {level: 'off'});
const session_options = create_session_config('test_actor_lookup_rpc');
const RPC_PATH = '/api/rpc';

// RPC endpoints are auto-mounted by create_app_server + create_test_app_surface_spec
// from the `rpc_endpoints` option — no duplication via create_route_specs.
const create_route_specs = (_ctx: AppServerContext): Array<RouteSpec> => [];

const rpc_endpoint_spec = {
	path: RPC_PATH,
	actions: create_actor_lookup_actions({log}),
};

const build = () =>
	create_test_app_surface_spec({
		session_options,
		create_route_specs,
		rpc_endpoints: [rpc_endpoint_spec],
	});

describe_rpc_attack_surface_tests({
	build,
	roles: [ROLE_ADMIN, ROLE_KEEPER],
});

describe_rpc_round_trip_tests(
	default_in_process_suite_options({
		session_options,
		create_route_specs,
		rpc_endpoints: [rpc_endpoint_spec],
	}),
);
