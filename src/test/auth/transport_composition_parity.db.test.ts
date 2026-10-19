/**
 * In-process leg of the front-door contract (`transport_composition.ts`).
 *
 * Runs the per-transport composition table against the in-process spine
 * surface, audit stream included, under a plain `gro test`. There is no
 * socket in-process, so the WebSocket rows skip; the cross-process leg
 * (`cross_backend/transport_composition.cross.test.ts`) runs them over real
 * HTTP against the TS spine binaries and the Rust `testing_spine_stub`.
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

const setup_test = default_in_process_setup({
	session_options: spine_session_options,
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: spine_rpc_endpoints,
	app_options: { audit_log_sse: true }
});

describe_transport_composition_cross_tests({
	setup_test,
	capabilities: in_process_capabilities,
	base_url: null
});
