/**
 * Cross-process `actor_search` parity for fuz_app's own spine over real HTTP
 * Companion to `actor_lookup.cross.test.ts`: drives the opt-in
 * `actor_search` resolver and its empty-`scope_ids` admin gate (anonymous →
 * 401, non-admin no-scope → 400 `actor_search_scope_required`, non-admin
 * scoped → 200, admin no-scope → 200) over real requests against each spawned
 * backend — the TS spine binaries + the Rust `testing_spine_stub`.
 * `actor_search` is live-mounted (off the declared surface) on every spine, so
 * the suite is ungated.
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.ts';
import {describe_actor_search_cross_tests} from '$lib/testing/cross_backend/actor_search.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const {capabilities, rpc_path} = handle.config;

describe_actor_search_cross_tests({setup_test, capabilities, rpc_path});
