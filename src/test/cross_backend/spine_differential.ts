/**
 * The differential suites fuz_app runs over a pair of its own spines — shared
 * by the TS-vs-Rust gate (`differential.cross.test.ts`) and the TS-vs-TS one
 * (`differential_ts.cross.test.ts`), which differ only in their backends and
 * their ledgers.
 *
 * Every conformance case — the shared `conformance_*_cases.ts` arrays plus the
 * generated per-method auth rows, over the spine's whole live mount
 * (`live_rpc_endpoints`, so the cell verbs, the actor resolvers and the
 * `_testing_*` backdoors are compared too) — goes to both backends over HTTP
 * and again over WS; the multi-actor `acting` rows run with the generated rows
 * on a keeper seeded with a second actor, on both transports; the
 * participation cases run with their `role_holder` seed.
 *
 * With `compare_db_state`, every case also compares the databases the two
 * backends are left in (`create_db_state_probe`) — both must then be on
 * PostgreSQL the test process reaches, so the TS-vs-TS pair on `memory://`
 * leaves it off.
 *
 * @module
 */

import {
	default_cross_process_setup,
	type ReconstructedBootstrappedBackendHandle
} from '#lib/testing/cross_backend/setup.ts';
import {
	describe_differential_conformance_tests,
	type KnownDivergence
} from '#lib/testing/cross_backend/differential.ts';
import { generate_rpc_auth_conformance_cases } from '#lib/testing/cross_backend/conformance_rpc_auth.ts';
import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { create_db_state_probe } from '#lib/testing/cross_backend/db_state_diff.ts';
import { SPINE_PARTICIPANT_ROLE } from '#lib/testing/cross_backend/spine_surface_constants.ts';
import { create_spine_live_rpc_endpoints } from '#lib/testing/cross_backend/full_spine_mount.ts';

import { conformance_proof_cases } from './conformance_proof_cases.ts';
import { conformance_security_cases } from './conformance_security_cases.ts';
import { conformance_expiry_cases } from './conformance_expiry_cases.ts';
import { conformance_dead_credential_cases } from './conformance_dead_credential_cases.ts';
import { conformance_app_settings_cases } from './conformance_app_settings_cases.ts';
import { conformance_void_params_cases } from './conformance_void_params_cases.ts';
import { conformance_nul_params_cases } from './conformance_nul_params_cases.ts';
import { conformance_proto_params_cases } from './conformance_proto_params_cases.ts';
import { conformance_admin_cases } from './conformance_admin_cases.ts';
import { conformance_actor_cases } from './conformance_actor_cases.ts';
import { conformance_cell_cases } from './conformance_cell_cases.ts';
import { ACTING_EXTRA_ACTOR_NAME, conformance_acting_cases } from './conformance_acting_cases.ts';
import {
	conformance_participation_cases,
	PARTICIPATION_HOLDER_USERNAME
} from './conformance_participation_cases.ts';

/** One side of the pair: the label its diffs print, and its handle. */
export interface SpineDifferentialBackend {
	readonly name: string;
	readonly handle: ReconstructedBootstrappedBackendHandle;
}

/** The ledgers the suites check against; an omitted one is empty. */
export interface SpineDifferentialLedgers {
	/** The main cases over HTTP. */
	readonly http?: ReadonlyArray<KnownDivergence>;
	/** The main cases over WS. */
	readonly ws?: ReadonlyArray<KnownDivergence>;
	/** The participation cases. */
	readonly participation?: ReadonlyArray<KnownDivergence>;
}

export interface DescribeSpineDifferentialOptions {
	readonly backends: readonly [SpineDifferentialBackend, SpineDifferentialBackend];
	readonly known_divergences?: SpineDifferentialLedgers;
	/** Compare each case's database state too (module doc). */
	readonly compare_db_state?: boolean;
}

/**
 * Register the differential suites over two spines.
 */
export const describe_spine_differential_suites = (
	options: DescribeSpineDifferentialOptions
): void => {
	const [a, b] = options.backends;
	const ledgers = options.known_divergences ?? {};
	const pair = `${a.name} vs ${b.name}`;

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
		...conformance_dead_credential_cases,
		...conformance_app_settings_cases,
		...conformance_void_params_cases,
		...conformance_proto_params_cases,
		...conformance_nul_params_cases,
		...conformance_admin_cases,
		...conformance_actor_cases,
		...conformance_cell_cases,
		...generated_auth_cases
	];
	const shared = {
		surface_source,
		rpc_endpoints: spine_rpc_endpoints,
		live_rpc_endpoints,
		session_options: spine_session_options
	};
	const ws_target = (
		handle: ReconstructedBootstrappedBackendHandle
	): { base_url: string; ws_path: string } => ({
		base_url: handle.config.base_url,
		ws_path: handle.config.ws_path
	});

	// the same fixture options as the single-backend conformance legs
	const a_setup = default_cross_process_setup(a.handle);
	const b_setup = default_cross_process_setup(b.handle);
	// one probe per backend, shared by every suite; each suite closes it after
	// its cases and the next reopens it
	const a_db = options.compare_db_state ? { db_state: create_db_state_probe(a.handle) } : {};
	const b_db = options.compare_db_state ? { db_state: create_db_state_probe(b.handle) } : {};

	describe_differential_conformance_tests({
		...shared,
		cases,
		backends: [
			{ name: a.name, setup_test: a_setup, ...a_db },
			{ name: b.name, setup_test: b_setup, ...b_db }
		],
		known_divergences: ledgers.http,
		suite_name: `differential conformance (${pair})`
	});

	describe_differential_conformance_tests({
		...shared,
		cases,
		backends: [
			{ name: a.name, setup_test: a_setup, ws: ws_target(a.handle), ...a_db },
			{ name: b.name, setup_test: b_setup, ws: ws_target(b.handle), ...b_db }
		],
		known_divergences: ledgers.ws,
		suite_name: `differential conformance over WS (${pair})`
	});

	const multi_actor_setup = { extra_actors: [ACTING_EXTRA_ACTOR_NAME] };
	const a_multi_actor_setup = default_cross_process_setup(a.handle, multi_actor_setup);
	const b_multi_actor_setup = default_cross_process_setup(b.handle, multi_actor_setup);
	const multi_actor_cases = [...conformance_acting_cases, ...generated_auth_cases];

	describe_differential_conformance_tests({
		...shared,
		cases: multi_actor_cases,
		backends: [
			{ name: a.name, setup_test: a_multi_actor_setup, ...a_db },
			{ name: b.name, setup_test: b_multi_actor_setup, ...b_db }
		],
		suite_name: `differential multi-actor conformance (${pair})`
	});

	describe_differential_conformance_tests({
		...shared,
		cases: multi_actor_cases,
		backends: [
			{ name: a.name, setup_test: a_multi_actor_setup, ws: ws_target(a.handle), ...a_db },
			{ name: b.name, setup_test: b_multi_actor_setup, ws: ws_target(b.handle), ...b_db }
		],
		suite_name: `differential multi-actor conformance over WS (${pair})`
	});

	const participation_setup = {
		extra_accounts: [{ username: PARTICIPATION_HOLDER_USERNAME, roles: [SPINE_PARTICIPANT_ROLE] }]
	};

	describe_differential_conformance_tests({
		...shared,
		cases: conformance_participation_cases,
		backends: [
			{
				name: a.name,
				setup_test: default_cross_process_setup(a.handle, participation_setup),
				...a_db
			},
			{
				name: b.name,
				setup_test: default_cross_process_setup(b.handle, participation_setup),
				...b_db
			}
		],
		principals: { role_holder: PARTICIPATION_HOLDER_USERNAME },
		known_divergences: ledgers.participation,
		suite_name: `differential participation conformance (${pair})`
	});
};
