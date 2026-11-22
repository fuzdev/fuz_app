/**
 * Every shipped single-backend cross suite against fuz_app's own spine, in one
 * `describe_spine_cross_suites` call — under each single-backend project, so
 * against the TS spine binaries (Node, Bun) and the Rust
 * `testing_spine_stub`. The spines mount everything, so nothing is excluded,
 * and the two spines agree, so the one override holds the standard bundle's
 * error coverage to the exact set it leaves uncovered on these spines, so a
 * dropped record fails the run. `live_rpc_endpoints`
 * is the spine binary's whole mount, so `rpc_adversarial` also walks the
 * methods kept off the declared surface — the cell verbs, the actor
 * resolvers and the `_testing_*` backdoors.
 *
 * Each backend declares the cases it skips (`EXPECTED_SKIPS`), so a skip
 * no backend owes fails the run.
 *
 * The audit-reading suites hold every row to a closed world
 * (`reject_unknown_audit_metadata_keys`), so neither spine can add an
 * undeclared metadata key.
 *
 * Spine-specific extras stay in files of their own: the conformance runner
 * over fuz_app's case files (`conformance.cross.test.ts`,
 * `conformance_participation.cross.test.ts`), the notification suite again on
 * the role-gated endpoint (`role_grant_offer_notification_ws_gated.cross.test.ts`),
 * the reset-isolation pair, and the bootstrap-token probe.
 *
 * @module
 */

import { assert } from 'vitest';

import { create_spine_live_rpc_endpoints } from '#lib/testing/cross_backend/full_spine_mount.ts';
import { create_spine_rpc_success_fixtures } from '#lib/testing/cross_backend/rpc_success_fixtures.ts';
import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_roles,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { inject_backend_handle } from '#lib/testing/cross_backend/provided_context.ts';
import { describe_spine_cross_suites } from '#lib/testing/cross_backend/spine_suites.ts';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';

const handle = inject_backend_handle();

/**
 * Each backend's gated skips, by backend name — keyed by name, not read off
 * the capabilities, so a capability flipped by mistake fails the run instead
 * of declaring its own skips.
 */
const EXPECTED_SKIPS: Record<string, Record<string, string>> = {
	[CROSS_PROJECT_RESOURCES.cross_backend_ts_node.node.name]: {},
	[CROSS_PROJECT_RESOURCES.cross_backend_ts_bun.bun.name]: {
		'cross-process websocket > frames sent with the handshake are answered once the connection is admitted':
			'Bun.serve answers 400 to an upgrade carrying frames in its TCP write when the handler ' +
			"upgrades after yielding to the event loop, as the spine's does behind its auth reads " +
			'(ws_handshake_pipelining: false)'
	},
	[CROSS_PROJECT_RESOURCES.cross_backend_rust_spine_stub.stub.name]: {}
};

const expected_skips = EXPECTED_SKIPS[handle.config.name];
if (expected_skips === undefined) {
	throw new Error(
		`spine_suites.cross.test.ts: no expected skips for backend '${handle.config.name}'`
	);
}

/**
 * The counted routes' declared errors the standard bundle drives on no spine:
 * the body 400s and the limiters' 429s (limiters are off in these binaries),
 * the credential-type 403s, and the unreadable `Content-Length`, which a
 * socket's HTTP parser answers before the application.
 */
const SPINE_UNCOVERED_ERRORS: Array<string> = [
	'POST /api/account/login 400 invalid_request_body',
	'POST /api/account/login 400 invalid_json_body',
	'POST /api/account/login 429 rate_limit_exceeded',
	'POST /api/account/login 400 invalid_content_length',
	'POST /api/account/logout 403 credential_type_required',
	'POST /api/account/logout 400 invalid_content_length',
	'POST /api/account/password 400 invalid_request_body',
	'POST /api/account/password 400 invalid_json_body',
	'POST /api/account/password 403 credential_type_required',
	'POST /api/account/password 429 rate_limit_exceeded',
	'POST /api/account/password 400 invalid_content_length',
	'POST /api/account/signup 400 invalid_request_body',
	'POST /api/account/signup 400 invalid_json_body',
	'POST /api/account/signup 429 rate_limit_exceeded',
	'POST /api/account/signup 400 invalid_content_length',
	'POST /api/rpc 400 invalid_content_length',
	'GET /api/rpc 400 invalid_content_length'
];

describe_spine_cross_suites(handle, {
	surface_source: create_spine_surface_spec(),
	session_options: spine_session_options,
	rpc_endpoints: spine_rpc_endpoints,
	live_rpc_endpoints: create_spine_live_rpc_endpoints(),
	roles: spine_roles,
	rpc_success_fixtures: create_spine_rpc_success_fixtures(),
	setup: { reject_unknown_audit_metadata_keys: true },
	expected_skips,
	// exactly what the standard bundle leaves uncovered on every spine, so a
	// dropped record or one covered code swapped for another fails; a code the
	// suite comes to cover leaves this list, and a newly declared one is driven
	overrides: {
		standard: {
			check_uncovered_errors: (uncovered) => {
				assert.deepStrictEqual(
					uncovered.map(({ method, path, status, code }) => `${method} ${path} ${status} ${code}`),
					SPINE_UNCOVERED_ERRORS
				);
			}
		}
	}
});
