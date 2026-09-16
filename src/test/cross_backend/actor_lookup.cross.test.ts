/**
 * Cross-process `actor_lookup` parity for fuz_app's own spine over real HTTP
 * Companion to `cell.cross.test.ts` / `origin.cross.test.ts`: drives the
 * opt-in `actor_lookup` resolver (anonymous → 401, keeper resolves own actor →
 * 200 with the info-leak-safe wire shape, empty ids → 400) over real requests
 * against each spawned backend — the TS spine binaries + the Rust
 * `testing_spine_stub`. `actor_lookup` is live-mounted (off the declared
 * surface) on every spine, so the suite is ungated.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_actor_lookup_cross_tests } from '$lib/testing/cross_backend/actor_lookup.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities, rpc_path } = handle.config;

describe_actor_lookup_cross_tests({ setup_test, capabilities, rpc_path });
