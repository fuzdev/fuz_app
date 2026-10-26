/**
 * Every shipped single-backend cross suite against fuz_app's own spine, in one
 * `describe_spine_cross_suites` call — under each single-backend project, so
 * against the TS spine binaries (Node, Deno, Bun) and the Rust
 * `testing_spine_stub`. The spines mount everything, so nothing is excluded;
 * the overrides are the Rust stub's tracked divergences. `live_rpc_endpoints`
 * is the spine binary's whole mount, so `rpc_adversarial` also walks the
 * methods kept off the declared surface — the cell verbs, the actor
 * resolvers and the `_testing_*` backdoors.
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

import { create_spine_live_rpc_endpoints } from '#lib/testing/cross_backend/full_spine_mount.ts';
import { create_spine_rpc_success_fixtures } from '#lib/testing/cross_backend/rpc_success_fixtures.ts';
import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_roles,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { inject_backend_handle } from '#lib/testing/cross_backend/provided_context.ts';
import { RUST_SPINE_STUB_DEFAULT_NAME } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import {
	describe_spine_cross_suites,
	type SuiteOverrides
} from '#lib/testing/cross_backend/spine_suites.ts';

const handle = inject_backend_handle();

/** The Rust stub's tracked divergences, each `xfail_until` its tracking id. */
const rust_overrides: SuiteOverrides = {
	// on the derived multi-actor setup, so its seeding stays the one call's
	transport_composition: (derived) => ({
		multi_actor: derived.multi_actor && {
			...derived.multi_actor,
			xfail: {
				tracking_id: 'rust-ws-upgrade-acting-fail-open',
				reason:
					'the Rust upgrade resolves an account, not an actor, so it admits a multi-actor ' +
					'upgrade that names no actor; per-frame dispatch still resolves each frame'
			}
		}
	})
};

describe_spine_cross_suites(handle, {
	surface_source: create_spine_surface_spec(),
	session_options: spine_session_options,
	rpc_endpoints: spine_rpc_endpoints,
	live_rpc_endpoints: create_spine_live_rpc_endpoints(),
	roles: spine_roles,
	rpc_success_fixtures: create_spine_rpc_success_fixtures(),
	setup: { reject_unknown_audit_metadata_keys: true },
	overrides: handle.config.name === RUST_SPINE_STUB_DEFAULT_NAME ? rust_overrides : undefined
});
