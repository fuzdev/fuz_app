/**
 * In-process leg of the role-gated-participation capstone.
 *
 * Runs the same declarative `conformance_participation_cases` + imperative
 * success suite against the in-process Hono spine surface (fast, every
 * `gro test`). The cross-process leg (`conformance_participation.cross.test.ts`)
 * runs the *same* assertions over real HTTP against the spawned spines.
 * Same-green both legs pins that the conferral algorithm is transport- and
 * impl-independent. The offer decline/retract refusal suite rides the same
 * drained setup; its cross-process leg is
 * `role_grant_offer_lifecycle.cross.test.ts`.
 *
 * @module
 */

import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import { describe_conformance_table_tests } from '#lib/testing/cross_backend/conformance_table.ts';
import { describe_role_grant_participation_cross_tests } from '#lib/testing/cross_backend/role_grant_participation.ts';
import { describe_role_grant_offer_lifecycle_cross_tests } from '#lib/testing/cross_backend/role_grant_offer_lifecycle.ts';
import {
	default_in_process_setup,
	default_in_process_suite_options
} from '#lib/testing/cross_backend/in_process_setup.ts';
import { create_testing_drain_effects_action } from '#lib/testing/cross_backend/testing_reset_actions.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { SPINE_PARTICIPANT_ROLE } from '#lib/testing/cross_backend/spine_surface_constants.ts';

import {
	conformance_participation_cases,
	PARTICIPATION_HOLDER_USERNAME
} from './conformance_participation_cases.ts';

// Keeper needs ROLE_ADMIN to clear the dispatcher admin gate; the
// `role_holder` principal holds the admin-grantable `participant` role,
// seeded directly at the bootstrap cradle (an offer would 403 it first).
const extra_accounts = [
	{ username: PARTICIPATION_HOLDER_USERNAME, roles: [SPINE_PARTICIPANT_ROLE] }
];

const suite_options = default_in_process_suite_options({
	session_options: spine_session_options,
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: spine_rpc_endpoints,
	extra_keeper_roles: [ROLE_ADMIN],
	extra_accounts
});

describe_conformance_table_tests({
	...suite_options,
	cases: conformance_participation_cases,
	principals: { role_holder: PARTICIPATION_HOLDER_USERNAME },
	suite_name: 'role-gated participation conformance (in-process)'
});

// The success paths and the offer decline/retract refusals read audit rows
// behind `_testing_drain_effects`, which the spine binaries mount off the
// declared surface — so it is mounted here, over a tracked emitter, for these
// suites alone, leaving the table's surface as declared.
const drained_setup_test = default_in_process_setup({
	reject_unknown_audit_metadata_keys: true,
	session_options: spine_session_options,
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: (ctx) =>
		spine_rpc_endpoints(ctx).map((endpoint) => ({
			...endpoint,
			actions: [...endpoint.actions, create_testing_drain_effects_action(ctx.deps.audit)]
		})),
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	audit_factory: ({ db, log }) => create_audit_emitter({ db, log, track_inflight: true }),
	extra_accounts
});

describe_role_grant_participation_cross_tests({ setup_test: drained_setup_test });
describe_role_grant_offer_lifecycle_cross_tests({ setup_test: drained_setup_test });
