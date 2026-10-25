/**
 * In-process leg of the standard admin integration suite over the spine
 * surface, wired the way a consumer wires it (`default_in_process_suite_options`
 * plus `roles`). The cross-process leg is `auth.cross.test.ts`, through the
 * standard bundle; this leg holds the suite to the in-process fixture, whose
 * `create_account` inserts rows directly rather than signing up.
 *
 * @module
 */

import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { describe_standard_admin_integration_tests } from '#lib/testing/admin_integration.ts';
import { default_in_process_suite_options } from '#lib/testing/cross_backend/in_process_setup.ts';
import {
	create_spine_route_specs,
	spine_roles,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';

describe_standard_admin_integration_tests({
	...default_in_process_suite_options({
		reject_unknown_audit_metadata_keys: true,
		session_options: spine_session_options,
		create_route_specs: create_spine_route_specs,
		rpc_endpoints: spine_rpc_endpoints,
		extra_keeper_roles: [ROLE_ADMIN]
	}),
	roles: spine_roles
});
