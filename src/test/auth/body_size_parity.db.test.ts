/**
 * In-process leg of the body-size-limit parity suite.
 *
 * Runs `describe_body_size_cross_tests` against the in-process Hono app (no
 * process boundary), so the oversized → 413 / under-limit → pass contract is
 * verified under a plain `gro test` — the cross-process leg
 * (`spine_suites.cross.test.ts`) additionally drives the TS spine binary + Rust
 * `testing_spine_stub` over real HTTP behind `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * `create_test_app` applies the default 1 MiB `bodyLimit` (it does not pass
 * `max_body_size`), matching the cross-process backends' default cap, so the
 * same oversized/under-limit bodies exercise the same threshold on both legs.
 * A second run raises the app's cap and passes the suite the same value
 * (`rpc_max_body_bytes`), the shape a consumer capping its RPC path above the
 * spine default takes: its at-limit case is past the default, so it passes
 * only when the suite probes the cap it was given.
 *
 * @module
 */

import { default_in_process_setup } from '#lib/testing/cross_backend/in_process_setup.ts';
import { describe } from 'vitest';

import { describe_body_size_cross_tests } from '#lib/testing/cross_backend/body_size.ts';
import { SPINE_BODY_LIMIT_DEFAULT_BYTES } from '#lib/testing/cross_backend/spine_surface_constants.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';

const RPC_PATH = '/api/rpc';
const session_options = create_session_config('test_session');

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_rpc_endpoint({
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: create_standard_rpc_actions(ctx.deps),
		log: ctx.deps.log
	});

const setup_test = default_in_process_setup({
	session_options,
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	create_route_specs
});

describe_body_size_cross_tests({
	setup_test,
	rpc_path: RPC_PATH,
	// in-process: no socket
	base_url: null
});

/**
 * A cap above the spine default — at-limit here is over the default, so the
 * leg passes only when the suite probes the cap it is given. In-process
 * (`base_url: null`), so the over-cap bodies go whole through the transport;
 * the raw-socket chunk builder, and its remainder chunk for a cap that is no
 * multiple of the chunk size, runs only on a cross-process leg.
 */
const RAISED_CAP_BYTES = 2 * SPINE_BODY_LIMIT_DEFAULT_BYTES + 1000;

describe('a raised cap', () => {
	describe_body_size_cross_tests({
		setup_test: default_in_process_setup({
			session_options,
			roles: [ROLE_KEEPER, ROLE_ADMIN],
			create_route_specs,
			app_options: { max_body_size: RAISED_CAP_BYTES }
		}),
		rpc_path: RPC_PATH,
		base_url: null,
		rpc_max_body_bytes: RAISED_CAP_BYTES
	});
});
