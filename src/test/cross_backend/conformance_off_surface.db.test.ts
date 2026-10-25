/**
 * In-process leg of the conformance rows on methods off the declared surface.
 *
 * The cross-process legs (`conformance.cross.test.ts`) resolve the cell verbs
 * and the actor resolvers from the spine's whole live mount; the in-process
 * spine app mounts only the declared surface, so these rows run here against
 * an app mounting the cell surface (`create_cell_parity_setup`) plus
 * `actor_lookup` and `actor_search`, with the generated auth rows for the same
 * methods.
 *
 * @module
 */

import { create_actor_lookup_actions } from '#lib/auth/actor_lookup_actions.ts';
import { create_actor_search_actions } from '#lib/auth/actor_search_actions.ts';
import type { RpcEndpointSpec } from '#lib/http/surface.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import { in_process_capabilities } from '#lib/testing/cross_backend/capabilities.ts';
import { describe_conformance_table_tests } from '#lib/testing/cross_backend/conformance_table.ts';
import { generate_rpc_auth_conformance_cases } from '#lib/testing/cross_backend/conformance_rpc_auth.ts';
import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { resolve_rpc_endpoints_for_setup } from '#lib/testing/rpc_helpers.ts';

import {
	cell_parity_rpc_endpoints,
	create_cell_parity_setup
} from '../auth/cell_parity_helpers.ts';
import { conformance_actor_cases } from './conformance_actor_cases.ts';
import { conformance_cell_cases } from './conformance_cell_cases.ts';

/** The cell parity mount plus the two actor resolvers, on one endpoint. */
const rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> =>
	cell_parity_rpc_endpoints(ctx).map((endpoint) => ({
		...endpoint,
		actions: [
			...endpoint.actions,
			...create_actor_lookup_actions(ctx.deps),
			...create_actor_search_actions(ctx.deps)
		]
	}));

const surface_source = create_spine_surface_spec();

describe_conformance_table_tests({
	cases: [
		...conformance_actor_cases,
		...conformance_cell_cases,
		...generate_rpc_auth_conformance_cases({
			surface_source,
			live_rpc_endpoints: resolve_rpc_endpoints_for_setup(rpc_endpoints, spine_session_options),
			// the declared methods' rows run in `conformance.db.test.ts`
			skip_methods: resolve_rpc_endpoints_for_setup(spine_rpc_endpoints, spine_session_options)
				.flatMap((endpoint) => endpoint.actions)
				.map((action) => action.spec.method)
		})
	],
	setup_test: create_cell_parity_setup([], rpc_endpoints),
	surface_source,
	capabilities: in_process_capabilities,
	rpc_endpoints: spine_rpc_endpoints,
	live_rpc_endpoints: rpc_endpoints,
	session_options: spine_session_options,
	suite_name: 'conformance table, off-surface methods (in-process)'
});
