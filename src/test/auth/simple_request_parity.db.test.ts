/**
 * In-process leg of the CORS simple-request parity suite.
 *
 * Runs `describe_simple_request_cross_tests` against the in-process Hono app
 * (no process boundary), so the untyped / `text/plain` / form `POST` → 415
 * contract is verified under a plain `gro test` — the cross-process leg
 * (`simple_request.cross.test.ts`) additionally drives the TS spine binary +
 * Rust `testing_spine_stub` over real HTTP behind `FUZ_TEST_CROSS_BACKEND=1`.
 * The app mounts the RPC endpoint and the account routes, since the suite
 * probes login and logout as well as RPC.
 *
 * @module
 */

import { default_in_process_setup } from '#lib/testing/cross_backend/in_process_setup.ts';
import { describe_simple_request_cross_tests } from '#lib/testing/cross_backend/simple_request.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import { create_account_route_specs } from '#lib/auth/account_routes.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import { prefix_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';

const RPC_PATH = '/api/rpc';
const session_options = create_session_config('test_session');

const setup_test = default_in_process_setup({
	session_options,
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	create_route_specs: (ctx: AppServerContext): Array<RouteSpec> => [
		...prefix_route_specs(
			'/api/account',
			create_account_route_specs(ctx.deps, {
				session_options,
				login_ip_rate_limiter: null,
				login_account_rate_limiter: null
			})
		),
		...create_rpc_endpoint({
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null,
			path: RPC_PATH,
			actions: create_standard_rpc_actions(ctx.deps),
			log: ctx.deps.log
		})
	]
});

describe_simple_request_cross_tests({
	setup_test,
	rpc_path: RPC_PATH
});
