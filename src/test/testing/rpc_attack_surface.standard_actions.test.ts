/**
 * `describe_rpc_attack_surface_tests` over the standard RPC actions, whose
 * handlers read the database (`account_verify` re-reads the account live and
 * answers the dead credential's 401 when it finds none): "correct auth passes"
 * pins the gate, the handler swapped for a recording stub, so a handler's own
 * answer over the stub deps never reads as the gate's.
 *
 * @module
 */

import { create_test_app_surface_spec } from '#lib/testing/stubs.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import { describe_rpc_attack_surface_tests } from '#lib/testing/rpc_attack_surface.ts';

describe_rpc_attack_surface_tests({
	build: () =>
		create_test_app_surface_spec({
			session_options: create_session_config('test_rpc_standard_actions_session'),
			create_route_specs: () => [],
			rpc_endpoints: (ctx) => [{ path: '/api/rpc', actions: create_standard_rpc_actions(ctx.deps) }]
		}),
	roles: ['admin', 'keeper']
});
