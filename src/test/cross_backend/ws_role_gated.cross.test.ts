/**
 * Cross-process role-gated WebSocket parity for fuz_app's own spine over a
 * real upgrade: both spines mount a second, role-gated endpoint beside
 * `/api/ws` (`SPINE_ROLE_GATED_WS_PATH`), and a revoked global grant of a
 * gating role closes the account's gated socket with
 * `WS_CLOSE_PERMISSION_REVOKED` while its ungated socket stays open.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import {
	SPINE_PARTICIPANT_ROLE,
	SPINE_ROLE_GATED_WS_PATH,
	SPINE_ROLE_GATED_WS_ROLES
} from '#lib/testing/cross_backend/spine_surface_constants.ts';
import { describe_ws_role_gated_cross_tests } from '#lib/testing/cross_backend/ws_role_gated.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities } = handle.config;

describe_ws_role_gated_cross_tests({
	setup_test,
	capabilities,
	base_url: handle.config.base_url,
	ws_path: handle.config.ws_path,
	gated_ws_path: SPINE_ROLE_GATED_WS_PATH,
	gated_roles: SPINE_ROLE_GATED_WS_ROLES,
	scoped_role: SPINE_PARTICIPANT_ROLE
});
