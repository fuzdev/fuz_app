/**
 * In-process leg of the conformance-table runner proof.
 *
 * Runs the shared conformance cases (plus the generated per-method auth rows)
 * against the in-process Hono
 * spine surface via `default_in_process_suite_options`. The cross-process
 * leg (`conformance.cross.test.ts`) runs the *same* cases over real HTTP
 * against the spawned spines. Same-green both legs pins that the runner
 * drives both transports.
 *
 * @module
 */

import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { describe_conformance_table_tests } from '#lib/testing/cross_backend/conformance_table.ts';
import { generate_rpc_auth_conformance_cases } from '#lib/testing/cross_backend/conformance_rpc_auth.ts';
import { default_in_process_suite_options } from '#lib/testing/cross_backend/in_process_setup.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';

import { conformance_proof_cases } from './conformance_proof_cases.ts';
import { conformance_security_cases } from './conformance_security_cases.ts';
import { conformance_expiry_cases } from './conformance_expiry_cases.ts';
import { conformance_app_settings_cases } from './conformance_app_settings_cases.ts';
import { conformance_void_params_cases } from './conformance_void_params_cases.ts';
import { conformance_admin_cases } from './conformance_admin_cases.ts';
import { ACTING_EXTRA_ACTOR_NAME, conformance_acting_cases } from './conformance_acting_cases.ts';
import { describe_invite_duplicate_tests } from './invite_duplicate.ts';
import { describe_offer_cross_account_tests } from './offer_cross_account.ts';

const suite_options = default_in_process_suite_options({
	session_options: spine_session_options,
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: spine_rpc_endpoints,
	// The keeper needs `ROLE_ADMIN` to pass the admin-gated success case;
	// `ROLE_KEEPER` alone does not grant admin reach.
	extra_keeper_roles: [ROLE_ADMIN]
});

describe_conformance_table_tests({
	...suite_options,
	cases: [
		...conformance_proof_cases,
		...conformance_security_cases,
		...conformance_expiry_cases,
		...conformance_app_settings_cases,
		...conformance_void_params_cases,
		...conformance_admin_cases,
		...generate_rpc_auth_conformance_cases({ surface_source: suite_options.surface_source })
	],
	suite_name: 'conformance table (in-process)'
});

// a keeper with a second actor: the `acting` rows, and the generated rows,
// which bind `acting` to their principal's actor so they hold here too
const multi_actor_suite_options = default_in_process_suite_options({
	session_options: spine_session_options,
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: spine_rpc_endpoints,
	extra_keeper_roles: [ROLE_ADMIN],
	extra_actors: [ACTING_EXTRA_ACTOR_NAME]
});

describe_conformance_table_tests({
	...multi_actor_suite_options,
	cases: [
		...conformance_acting_cases,
		...generate_rpc_auth_conformance_cases({
			surface_source: multi_actor_suite_options.surface_source
		})
	],
	suite_name: 'conformance table (in-process, multi-actor keeper)'
});

describe_invite_duplicate_tests({ setup_test: suite_options.setup_test });
describe_offer_cross_account_tests({ setup_test: suite_options.setup_test });
