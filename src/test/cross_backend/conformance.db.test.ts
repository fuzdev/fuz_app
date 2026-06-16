/**
 * In-process leg of the conformance-table runner proof.
 *
 * Runs the shared `conformance_proof_cases` against the in-process Hono
 * spine surface via `default_in_process_suite_options`. The cross-process
 * leg (`conformance.cross.test.ts`) runs the *same* cases over real HTTP
 * against the spawned spines. Same-green both legs pins that the runner
 * drives both transports.
 *
 * @module
 */

import {ROLE_ADMIN} from '$lib/auth/role_schema.ts';
import {describe_conformance_table_tests} from '$lib/testing/cross_backend/conformance_table.ts';
import {default_in_process_suite_options} from '$lib/testing/cross_backend/in_process_setup.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints,
	spine_session_options,
} from '$lib/testing/cross_backend/default_spine_surface.ts';

import {conformance_proof_cases} from './conformance_proof_cases.ts';
import {conformance_security_cases} from './conformance_security_cases.ts';
import {conformance_expiry_cases} from './conformance_expiry_cases.ts';
import {conformance_app_settings_cases} from './conformance_app_settings_cases.ts';

describe_conformance_table_tests({
	...default_in_process_suite_options({
		session_options: spine_session_options,
		create_route_specs: create_spine_route_specs,
		rpc_endpoints: spine_rpc_endpoints,
		// The keeper needs `ROLE_ADMIN` to pass the admin-gated success case;
		// `ROLE_KEEPER` alone does not grant admin reach.
		extra_keeper_roles: [ROLE_ADMIN],
	}),
	cases: [
		...conformance_proof_cases,
		...conformance_security_cases,
		...conformance_expiry_cases,
		...conformance_app_settings_cases,
	],
	suite_name: 'conformance table (in-process)',
});
