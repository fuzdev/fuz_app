/**
 * Composable RPC suite coverage for the permit_offer action set.
 *
 * Wires `describe_rpc_attack_surface_tests` (stub-deps, no DB) and
 * `describe_rpc_round_trip_tests` (PGlite) against the five actions
 * produced by `create_permit_offer_actions`. Auto-covers per-method
 * auth enforcement, adversarial envelopes, adversarial params, and
 * output-schema validation.
 *
 * @module
 */

import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {create_test_app_surface_spec} from '$lib/testing/stubs.js';
import {describe_rpc_attack_surface_tests} from '$lib/testing/rpc_attack_surface.js';
import {describe_rpc_round_trip_tests} from '$lib/testing/rpc_round_trip.js';
import {create_permit_offer_actions} from '$lib/auth/permit_offer_actions.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RouteSpec} from '$lib/http/route_spec.js';

const log = new Logger('test', {level: 'off'});
const session_options = create_session_config('test_permit_offer_rpc');
const RPC_PATH = '/api/rpc';

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_permit_offer_actions(ctx.deps),
		log: ctx.deps.log,
	}),
];

const rpc_endpoint_spec = {
	path: RPC_PATH,
	actions: create_permit_offer_actions({
		log,
		on_audit_event: () => undefined,
	}),
};

const build = () =>
	create_test_app_surface_spec({
		session_options,
		create_route_specs,
		rpc_endpoints: [rpc_endpoint_spec],
	});

describe_rpc_attack_surface_tests({
	build,
	roles: [ROLE_ADMIN],
});

describe_rpc_round_trip_tests({
	session_options,
	create_route_specs,
	rpc_endpoints: [rpc_endpoint_spec],
});
