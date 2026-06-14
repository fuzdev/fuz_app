/**
 * In-process leg of the account-lifecycle parity suite.
 *
 * Runs `describe_account_lifecycle_cross_tests` against the in-process Hono
 * app (no process boundary), so the soft-delete → undelete → purge wire
 * contract + keeper guard are verified under a plain `gro test` — the
 * cross-process leg (`account_lifecycle.cross.test.ts`) additionally drives
 * the TS spine binary + Rust `testing_spine_stub` over real HTTP behind
 * `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * The bootstrapped keeper is granted `ROLE_ADMIN` alongside `ROLE_KEEPER`
 * (mirroring the cross-process fresh keeper) so its session is admin-capable
 * for the delete/undelete calls while its daemon token drives the purge.
 *
 * @module
 */

import {default_in_process_setup} from '$lib/testing/cross_backend/in_process_setup.js';
import {in_process_capabilities} from '$lib/testing/cross_backend/capabilities.js';
import {describe_account_lifecycle_cross_tests} from '$lib/testing/cross_backend/account_lifecycle.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.js';
import {create_testing_drain_effects_action} from '$lib/testing/cross_backend/testing_reset_actions.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import type {AppServerContext} from '$lib/server/app_server_context.js';
import type {RouteSpec} from '$lib/http/route_spec.js';

const RPC_PATH = '/api/rpc';
const session_options = create_session_config('test_session');

const setup_test = default_in_process_setup({
	session_options,
	// Keeper is also admin (matches the cross-process fresh keeper) so its
	// session reaches the admin-gated delete/undelete verbs.
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	create_route_specs: (ctx: AppServerContext): Array<RouteSpec> =>
		create_rpc_endpoint({
			path: RPC_PATH,
			// `_testing_drain_effects` so the shared suite body can call the
			// barrier in-process too (satisfied-by-construction: `create_test_app`
			// runs `await_pending_effects: true`).
			actions: [...create_standard_rpc_actions(ctx.deps), create_testing_drain_effects_action()],
			log: ctx.deps.log,
		}),
});

describe_account_lifecycle_cross_tests({
	setup_test,
	capabilities: in_process_capabilities,
	rpc_path: RPC_PATH,
});
