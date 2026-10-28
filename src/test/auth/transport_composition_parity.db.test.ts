/**
 * In-process leg of the front-door contract (`transport_composition.ts`).
 *
 * Runs the per-transport composition table against the in-process spine
 * surface, audit stream and WebSocket path included, under a plain
 * `gro test`. There is no socket in-process, so the WebSocket upgrade rows
 * skip — the WebSocket path's requests that ask for no upgrade run, against
 * a stub upgrade helper that passes them on as the real one does; the
 * cross-process leg (`cross_backend/spine_suites.cross.test.ts`) runs every
 * row over real HTTP against the TS spine binaries and the Rust
 * `testing_spine_stub`.
 *
 * @module
 */

import { default_in_process_setup } from '#lib/testing/cross_backend/in_process_setup.ts';
import { describe_transport_composition_cross_tests } from '#lib/testing/cross_backend/transport_composition.ts';
import { in_process_capabilities } from '#lib/testing/cross_backend/capabilities.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import { SPINE_WS_PATH } from '#lib/testing/cross_backend/spine_surface_constants.ts';
import { create_stub_upgrade } from '#lib/testing/ws_round_trip.ts';

const setup_test = default_in_process_setup({
	session_options: spine_session_options,
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: spine_rpc_endpoints,
	app_options: {
		audit_log_sse: true,
		create_upgrade_websocket: () => create_stub_upgrade().upgradeWebSocket,
		ws_endpoints: [{ path: SPINE_WS_PATH }]
	}
});

describe_transport_composition_cross_tests({
	setup_test,
	capabilities: in_process_capabilities,
	base_url: null
});
