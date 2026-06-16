/**
 * Cross-process integration suite for fuz_app's own spine surface against
 * the Rust `testing_spine_stub` binary.
 *
 * Calls `describe_standard_cross_process_tests` — the cross-process subset
 * of the standard fuz_app bundle (integration + admin + round-trip +
 * RPC-round-trip + data-exposure), omitting `rate_limiting` (in-process
 * fresh-`TestApp` plumbing), `audit_completeness` (FK-structural
 * introspection), and `bootstrap_success` (already consumed by
 * `globalSetup`). See the bundle's module doc for the omission rationale.
 *
 * This is fuz_app verifying its own TS spec against the Rust spine
 * end-to-end with no domain layer in the loop — the third cross-backend
 * consumer after zzz and fuz_forge, but the only one that isolates spine
 * conformance from domain behavior. Drift between the TS spec and the Rust
 * spine surfaces here as a fuz_app failure.
 *
 * @module
 */

import {inject} from 'vitest';

import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.ts';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.ts';
import {describe_standard_cross_process_tests} from '$lib/testing/cross_backend/standard.ts';

import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_roles,
	spine_session_options,
} from '$lib/testing/cross_backend/default_spine_surface.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
// Grant `ROLE_ADMIN` to the fresh-per-test keeper so the admin-observer
// tests can drive admin-gated RPC methods through the keeper's credentials.
// The stub's `_testing_reset` seeds the keeper with `[ROLE_KEEPER,
// ...extra_keeper_roles]`, so `ROLE_ADMIN` must be requested explicitly —
// `ROLE_KEEPER` alone does not grant admin reach.
//
// `extra_accounts` seeds a keeper-only (non-admin) account so the
// `keeper ≠ admin` probe can assert it's denied admin RPCs. `ROLE_KEEPER`
// is bootstrap-only (no offer/accept grant path), so it can't go through
// `create_account` — the cradle is the only way to seed it.
const setup_test = default_cross_process_setup(handle, {
	extra_keeper_roles: [ROLE_ADMIN],
	extra_accounts: [{username: 'non_admin_keeper', roles: [ROLE_KEEPER]}],
});
const {capabilities} = handle.config;

describe_standard_cross_process_tests({
	setup_test,
	surface_source: create_spine_surface_spec(),
	capabilities,
	session_options: spine_session_options,
	rpc_endpoints: spine_rpc_endpoints,
	roles: spine_roles,
});
