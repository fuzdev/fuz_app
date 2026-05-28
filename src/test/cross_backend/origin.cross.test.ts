/**
 * Cross-process Origin-verification parity for fuz_app's own spine over real
 * HTTP. Companion to `auth.cross.test.ts` / `account_lifecycle.cross.test.ts`:
 * drives the Origin allowlist middleware (disallowed Origin → 403, absent
 * Origin → pass) over real requests against each spawned backend — the TS
 * spine binaries + the Rust `testing_spine_stub`. Origin middleware is on
 * every spine, so the suite is ungated.
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.js';
import {describe_origin_cross_tests} from '$lib/testing/cross_backend/origin.js';

import './cross_test_types.js';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const {capabilities, rpc_path} = handle.config;

describe_origin_cross_tests({setup_test, capabilities, rpc_path});
