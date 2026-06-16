/**
 * In-process leg of the `actor_search` parity suite.
 *
 * Runs `describe_actor_search_cross_tests` against the in-process Hono app (no
 * process boundary), so the empty-`scope_ids` admin gate / scope-bypass
 * contract is verified under a plain `gro test` — the cross-process leg
 * (`actor_search.cross.test.ts`) additionally drives the TS spine binary +
 * Rust `testing_spine_stub` over real HTTP behind `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * `actor_search` is opt-in (not in `create_standard_rpc_actions`), so the
 * endpoint mounts `create_actor_search_actions` alongside the standard bundle
 * — mirroring how the spine binary live-mounts it.
 *
 * @module
 */

import {default_in_process_setup} from '$lib/testing/cross_backend/in_process_setup.ts';
import {in_process_capabilities} from '$lib/testing/cross_backend/capabilities.ts';
import {describe_actor_search_cross_tests} from '$lib/testing/cross_backend/actor_search.ts';
import {create_session_config} from '$lib/auth/session_cookie.ts';
import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.ts';
import {create_actor_search_actions} from '$lib/auth/actor_search_actions.ts';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.ts';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.ts';
import type {AppServerContext} from '$lib/server/app_server_context.ts';
import type {RouteSpec} from '$lib/http/route_spec.ts';

const RPC_PATH = '/api/rpc';
const session_options = create_session_config('test_session');

const setup_test = default_in_process_setup({
	session_options,
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	create_route_specs: (ctx: AppServerContext): Array<RouteSpec> =>
		create_rpc_endpoint({
			path: RPC_PATH,
			actions: [...create_standard_rpc_actions(ctx.deps), ...create_actor_search_actions(ctx.deps)],
			log: ctx.deps.log,
		}),
});

describe_actor_search_cross_tests({
	setup_test,
	capabilities: in_process_capabilities,
	rpc_path: RPC_PATH,
});
