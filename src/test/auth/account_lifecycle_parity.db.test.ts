/**
 * In-process leg of the account-lifecycle parity suite.
 *
 * Runs `describe_account_lifecycle_cross_tests` against the in-process Hono
 * app (no process boundary), so the soft-delete → undelete → purge wire
 * contract + keeper guard are verified under a plain `gro test` — the
 * cross-process leg (`spine_suites.cross.test.ts`) additionally drives
 * the TS spine binary + Rust `testing_spine_stub` over real HTTP behind
 * `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * The app is the spine's own: its account routes (the credential cases log in
 * and change a password) and its standard RPC endpoint, plus
 * `_testing_drain_effects` over a tracked emitter, the barrier the audit reads
 * wait on. The bootstrapped keeper is granted `ROLE_ADMIN` alongside
 * `ROLE_KEEPER` (mirroring the cross-process fresh keeper) so its session is
 * admin-capable for the delete/undelete calls while its daemon token drives
 * the purge.
 *
 * @module
 */

import { default_in_process_setup } from '#lib/testing/cross_backend/in_process_setup.ts';
import { in_process_capabilities } from '#lib/testing/cross_backend/capabilities.ts';
import { describe_account_lifecycle_cross_tests } from '#lib/testing/cross_backend/account_lifecycle.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { SPINE_RPC_PATH } from '#lib/testing/cross_backend/spine_surface_constants.ts';
import { create_testing_drain_effects_action } from '#lib/testing/cross_backend/testing_reset_actions.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';

const setup_test = default_in_process_setup({
	reject_unknown_audit_metadata_keys: true,
	session_options: spine_session_options,
	// Keeper is also admin (matches the cross-process fresh keeper) so its
	// session reaches the admin-gated delete/undelete verbs.
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	// tracked so `_testing_drain_effects` awaits the emitter, as on the binaries
	audit_factory: ({ db, log }) => create_audit_emitter({ db, log, track_inflight: true }),
	create_route_specs: create_spine_route_specs,
	rpc_endpoints: (ctx) =>
		spine_rpc_endpoints(ctx).map((endpoint) => ({
			...endpoint,
			actions: [...endpoint.actions, create_testing_drain_effects_action(ctx.deps.audit)]
		}))
});

describe_account_lifecycle_cross_tests({
	setup_test,
	capabilities: in_process_capabilities,
	rpc_path: SPINE_RPC_PATH
});
