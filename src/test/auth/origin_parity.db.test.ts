/**
 * In-process leg of the Origin-verification parity suite.
 *
 * Runs `describe_origin_cross_tests` against the in-process Hono app (no
 * process boundary), so the disallowed-Origin → 403 / absent-Origin → pass
 * contract is verified under a plain `gro test` — the cross-process leg
 * (`origin.cross.test.ts`) additionally drives the TS spine binary + Rust
 * `testing_spine_stub` over real HTTP behind `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * The in-process app allows `http://localhost*` origins (the `create_test_app`
 * default), so `http://evil.com` is rejected and an absent Origin passes —
 * matching the cross-process backends' `ALLOWED_ORIGINS=http://localhost:*`.
 *
 * @module
 */

import {default_in_process_setup} from '$lib/testing/cross_backend/in_process_setup.js';
import {in_process_capabilities} from '$lib/testing/cross_backend/capabilities.js';
import {describe_origin_cross_tests} from '$lib/testing/cross_backend/origin.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import type {AppServerContext} from '$lib/server/app_server_context.js';
import type {RouteSpec} from '$lib/http/route_spec.js';

const RPC_PATH = '/api/rpc';
const session_options = create_session_config('test_session');

const setup_test = default_in_process_setup({
	session_options,
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	create_route_specs: (ctx: AppServerContext): Array<RouteSpec> =>
		create_rpc_endpoint({
			path: RPC_PATH,
			actions: create_standard_rpc_actions(ctx.deps),
			log: ctx.deps.log,
		}),
});

describe_origin_cross_tests({
	setup_test,
	capabilities: in_process_capabilities,
	rpc_path: RPC_PATH,
});
