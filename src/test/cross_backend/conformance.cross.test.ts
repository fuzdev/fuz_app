/**
 * Cross-process leg of the conformance-table runner proof.
 *
 * Runs the shared `conformance_proof_cases` over real HTTP against each
 * spawned spine (TS node/deno/bun + the Rust `testing_spine_stub`),
 * exercising each impl's real auth resolution. Same cases as the
 * in-process leg (`conformance.db.test.ts`) — same-green pins that the
 * runner drives both transports.
 *
 * The same cases run again over the WebSocket endpoint (the WS leg —
 * `ws` on the runner), where each frame meets the per-message gates on an
 * admitted socket, and a keeper seeded with a second actor runs the
 * multi-actor `acting` rows and the generated auth rows, which bind `acting`
 * to their principal's actor, on both transports.
 *
 * The rows reach the methods the spines mount off the declared surface too
 * (cell verbs, the actor resolvers, the `_testing_*` backdoors): the runner
 * resolves them from the spine's whole live mount (`live_rpc_endpoints`), and
 * the generated auth rows cover them from the same list.
 *
 * @module
 */

import { inject } from 'vitest';

import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_conformance_table_tests } from '#lib/testing/cross_backend/conformance_table.ts';
import { generate_rpc_auth_conformance_cases } from '#lib/testing/cross_backend/conformance_rpc_auth.ts';
import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { create_spine_live_rpc_endpoints } from '#lib/testing/cross_backend/full_spine_mount.ts';

import { conformance_proof_cases } from './conformance_proof_cases.ts';
import { conformance_security_cases } from './conformance_security_cases.ts';
import { conformance_expiry_cases } from './conformance_expiry_cases.ts';
import { conformance_app_settings_cases } from './conformance_app_settings_cases.ts';
import { conformance_void_params_cases } from './conformance_void_params_cases.ts';
import { conformance_admin_cases } from './conformance_admin_cases.ts';
import { conformance_actor_cases } from './conformance_actor_cases.ts';
import { conformance_cell_cases } from './conformance_cell_cases.ts';
import { ACTING_EXTRA_ACTOR_NAME, conformance_acting_cases } from './conformance_acting_cases.ts';
import { describe_invite_duplicate_tests } from './invite_duplicate.ts';
import { describe_offer_cross_account_tests } from './offer_cross_account.ts';
import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
// `ROLE_ADMIN` on the fresh-per-test keeper so the success case can list
// accounts; `ROLE_KEEPER` alone does not grant admin reach.
const setup_test = default_cross_process_setup(handle, { extra_keeper_roles: [ROLE_ADMIN] });
const { capabilities, base_url, ws_path } = handle.config;
const surface_source = create_spine_surface_spec();
const live_rpc_endpoints = create_spine_live_rpc_endpoints();
const generated_auth_cases = generate_rpc_auth_conformance_cases({
	surface_source,
	live_rpc_endpoints
});
const cases = [
	...conformance_proof_cases,
	...conformance_security_cases,
	...conformance_expiry_cases,
	...conformance_app_settings_cases,
	...conformance_void_params_cases,
	...conformance_admin_cases,
	...conformance_actor_cases,
	...conformance_cell_cases,
	...generated_auth_cases
];
const table_options = {
	surface_source,
	capabilities,
	rpc_endpoints: spine_rpc_endpoints,
	live_rpc_endpoints,
	session_options: spine_session_options
};
// The WS leg sends every case's method on the socket — account, admin and
// keeper methods alike. `ws_account_actions` stands in for "the WS endpoint
// mounts them" because fuz_app's spines mount their full RPC registry on WS;
// a consumer gates on what its own WS endpoint mounts.
const ws = capabilities.ws && capabilities.ws_account_actions ? { base_url, ws_path } : undefined;

describe_conformance_table_tests({
	...table_options,
	cases,
	setup_test,
	suite_name: 'conformance table (cross-process)'
});

if (ws) {
	describe_conformance_table_tests({
		...table_options,
		cases,
		setup_test,
		ws,
		suite_name: 'conformance table (cross-process, WS)'
	});
}

const multi_actor_setup_test = default_cross_process_setup(handle, {
	extra_keeper_roles: [ROLE_ADMIN],
	extra_actors: [ACTING_EXTRA_ACTOR_NAME]
});
const multi_actor_cases = [...conformance_acting_cases, ...generated_auth_cases];

describe_conformance_table_tests({
	...table_options,
	cases: multi_actor_cases,
	setup_test: multi_actor_setup_test,
	suite_name: 'conformance table (cross-process, multi-actor keeper)'
});

if (ws) {
	describe_conformance_table_tests({
		...table_options,
		cases: multi_actor_cases,
		setup_test: multi_actor_setup_test,
		ws,
		suite_name: 'conformance table (cross-process, WS, multi-actor keeper)'
	});
}

describe_invite_duplicate_tests({ setup_test });
describe_offer_cross_account_tests({ setup_test });
