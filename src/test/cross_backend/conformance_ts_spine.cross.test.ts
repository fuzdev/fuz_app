/**
 * The conformance rows only the TS spine binaries answer: the dead
 * credentials on `GET /verify`, a route the Rust account router doesn't mount.
 *
 * Runs under the TS cross projects alone — `cross_backend_projects.ts` leaves
 * this file out of `cross_backend_rust_spine_stub` (`TS_SPINE_ONLY_CROSS_TESTS`)
 * — so no row here skips by backend. The in-process leg runs the same rows in
 * `conformance.db.test.ts`, and the Node-vs-Bun differential compares them.
 *
 * @module
 */

import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { inject_backend_handle } from '#lib/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '#lib/testing/cross_backend/setup.ts';
import { describe_conformance_table_tests } from '#lib/testing/cross_backend/conformance_table.ts';
import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';

import { conformance_verify_cases } from './conformance_verify_cases.ts';

const handle = inject_backend_handle();

describe_conformance_table_tests({
	cases: conformance_verify_cases,
	setup_test: default_cross_process_setup(handle, { extra_keeper_roles: [ROLE_ADMIN] }),
	surface_source: create_spine_surface_spec(),
	capabilities: handle.config.capabilities,
	rpc_endpoints: spine_rpc_endpoints,
	session_options: spine_session_options,
	suite_name: 'conformance table, TS spine only (cross-process)'
});
