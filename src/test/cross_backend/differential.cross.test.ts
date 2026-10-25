/**
 * Cross-backend differential gate for fuz_app's own spine.
 *
 * Sends every conformance case — the shared `conformance_*_cases.ts` arrays
 * plus the generated per-method auth rows — to both the TS spine (Node) and
 * the Rust `testing_spine_stub`, and asserts the two normalized responses are
 * equal (`describe_differential_conformance_tests`): status, header names and
 * the whole body, ids and timestamps placeholdered by position. Each impl is
 * the oracle for the other, so an extra field one spine sends — which a loose
 * output schema passes — or any body difference on a case pinned by status
 * alone fails here. Tracked differences are the ledger in
 * `differential_known_divergences.ts`.
 *
 * Runs under the dual-spawn `cross_backend_parity` project (`parity_handle_a`
 * = TS, `parity_handle_b` = Rust), both spines on Postgres, so no engine
 * difference can show up as a body difference.
 *
 * The main cases run again over each spine's WebSocket endpoint, and a keeper
 * seeded with a second actor runs the multi-actor `acting` rows with the
 * generated auth rows on both transports.
 *
 * @module
 */

import { inject } from 'vitest';

import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_differential_conformance_tests } from '#lib/testing/cross_backend/differential.ts';
import { generate_rpc_auth_conformance_cases } from '#lib/testing/cross_backend/conformance_rpc_auth.ts';
import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { SPINE_PARTICIPANT_ROLE } from '#lib/testing/cross_backend/spine_surface_constants.ts';

import { conformance_proof_cases } from './conformance_proof_cases.ts';
import { conformance_security_cases } from './conformance_security_cases.ts';
import { conformance_expiry_cases } from './conformance_expiry_cases.ts';
import { conformance_app_settings_cases } from './conformance_app_settings_cases.ts';
import { conformance_void_params_cases } from './conformance_void_params_cases.ts';
import { conformance_admin_cases } from './conformance_admin_cases.ts';
import { ACTING_EXTRA_ACTOR_NAME, conformance_acting_cases } from './conformance_acting_cases.ts';
import {
	conformance_participation_cases,
	PARTICIPATION_HOLDER_USERNAME
} from './conformance_participation_cases.ts';
import {
	differential_known_divergences,
	differential_participation_known_divergences,
	differential_ws_known_divergences
} from './differential_known_divergences.ts';
import './cross_test_types.ts';

const ts = reconstruct_bootstrapped_handle(inject('parity_handle_a'));
const rust = reconstruct_bootstrapped_handle(inject('parity_handle_b'));
const surface_source = create_spine_surface_spec();

const cases = [
	...conformance_proof_cases,
	...conformance_security_cases,
	...conformance_expiry_cases,
	...conformance_app_settings_cases,
	...conformance_void_params_cases,
	...conformance_admin_cases,
	...generate_rpc_auth_conformance_cases({ surface_source })
];
const shared = {
	surface_source,
	rpc_endpoints: spine_rpc_endpoints,
	session_options: spine_session_options
};
const ws_target = (handle: typeof ts): { base_url: string; ws_path: string } => ({
	base_url: handle.config.base_url,
	ws_path: handle.config.ws_path
});

// the same fixture options as the single-backend conformance legs
const keeper_setup = { extra_keeper_roles: [ROLE_ADMIN] };
const ts_setup = default_cross_process_setup(ts, keeper_setup);
const rust_setup = default_cross_process_setup(rust, keeper_setup);

describe_differential_conformance_tests({
	...shared,
	cases,
	backends: [
		{ name: 'ts', setup_test: ts_setup },
		{ name: 'rust', setup_test: rust_setup }
	],
	known_divergences: differential_known_divergences,
	suite_name: 'differential conformance (ts vs rust)'
});

describe_differential_conformance_tests({
	...shared,
	cases,
	backends: [
		{ name: 'ts', setup_test: ts_setup, ws: ws_target(ts) },
		{ name: 'rust', setup_test: rust_setup, ws: ws_target(rust) }
	],
	known_divergences: differential_ws_known_divergences,
	suite_name: 'differential conformance over WS (ts vs rust)'
});

const multi_actor_setup = { ...keeper_setup, extra_actors: [ACTING_EXTRA_ACTOR_NAME] };
const ts_multi_actor_setup = default_cross_process_setup(ts, multi_actor_setup);
const rust_multi_actor_setup = default_cross_process_setup(rust, multi_actor_setup);
const multi_actor_cases = [
	...conformance_acting_cases,
	...generate_rpc_auth_conformance_cases({ surface_source })
];

describe_differential_conformance_tests({
	...shared,
	cases: multi_actor_cases,
	backends: [
		{ name: 'ts', setup_test: ts_multi_actor_setup },
		{ name: 'rust', setup_test: rust_multi_actor_setup }
	],
	suite_name: 'differential multi-actor conformance (ts vs rust)'
});

describe_differential_conformance_tests({
	...shared,
	cases: multi_actor_cases,
	backends: [
		{ name: 'ts', setup_test: ts_multi_actor_setup, ws: ws_target(ts) },
		{ name: 'rust', setup_test: rust_multi_actor_setup, ws: ws_target(rust) }
	],
	suite_name: 'differential multi-actor conformance over WS (ts vs rust)'
});

const participation_setup = {
	extra_keeper_roles: [ROLE_ADMIN],
	extra_accounts: [{ username: PARTICIPATION_HOLDER_USERNAME, roles: [SPINE_PARTICIPANT_ROLE] }]
};

describe_differential_conformance_tests({
	cases: conformance_participation_cases,
	backends: [
		{ name: 'ts', setup_test: default_cross_process_setup(ts, participation_setup) },
		{ name: 'rust', setup_test: default_cross_process_setup(rust, participation_setup) }
	],
	surface_source,
	rpc_endpoints: spine_rpc_endpoints,
	session_options: spine_session_options,
	principals: { role_holder: PARTICIPATION_HOLDER_USERNAME },
	known_divergences: differential_participation_known_divergences,
	suite_name: 'differential participation conformance (ts vs rust)'
});
