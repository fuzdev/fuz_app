/**
 * The role-grant-offer WS notification suite over the spine binaries'
 * role-gated endpoint (`SPINE_ROLE_GATED_WS_PATH`), declared through
 * `ws_required_roles` — the shape a consumer whose only socket is role-gated
 * runs. Every notification still arrives, and the revoke case expects the
 * revokee's gated socket to close with `WS_CLOSE_PERMISSION_REVOKED`. Gated on
 * `capabilities.ws_role_gated`.
 *
 * @module
 */

import { inject_backend_handle } from '#lib/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '#lib/testing/cross_backend/setup.ts';
import { describe_role_grant_offer_notification_ws_tests } from '#lib/testing/cross_backend/role_grant_offer_notification_ws.ts';
import {
	SPINE_ROLE_GATED_WS_PATH,
	SPINE_ROLE_GATED_WS_ROLES
} from '#lib/testing/cross_backend/spine_surface_constants.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);
const { capabilities, base_url } = handle.config;

describe_role_grant_offer_notification_ws_tests({
	setup_test,
	capabilities: { ...capabilities, ws: capabilities.ws && capabilities.ws_role_gated },
	base_url,
	ws_path: SPINE_ROLE_GATED_WS_PATH,
	ws_required_roles: SPINE_ROLE_GATED_WS_ROLES
});
