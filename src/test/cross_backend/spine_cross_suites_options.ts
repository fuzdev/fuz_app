/**
 * The options fuz_app's own spine runs the shipped cross suites with — the
 * declared surface, the whole live mount, the success fixtures, and every
 * audit row held to a closed world (`reject_unknown_audit_metadata_keys`).
 * Shared by `spine_suites.cross.test.ts` (`describe_spine_cross_suites`) and
 * the transcript differential (`register_spine_suites`), so the two run the
 * suites alike.
 *
 * @module
 */

import { SESSION_COOKIE_NAME } from '#lib/auth/session_cookie.ts';
import { create_spine_live_rpc_endpoints } from '#lib/testing/cross_backend/full_spine_mount.ts';
import { create_spine_rpc_success_fixtures } from '#lib/testing/cross_backend/rpc_success_fixtures.ts';
import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_roles
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import type { SpineCrossSuitesOptions } from '#lib/testing/cross_backend/spine_suites.ts';

/**
 * Build the spine's suite options, fresh per call.
 *
 * @returns the options every spine runner shares, no excludes, overrides or declared skips
 */
export const create_spine_cross_suites_options = (): SpineCrossSuitesOptions => ({
	surface_source: create_spine_surface_spec(),
	session_cookie_name: SESSION_COOKIE_NAME,
	rpc_endpoints: spine_rpc_endpoints,
	live_rpc_endpoints: create_spine_live_rpc_endpoints(),
	roles: spine_roles,
	rpc_success_fixtures: create_spine_rpc_success_fixtures(),
	setup: { reject_unknown_audit_metadata_keys: true }
});
