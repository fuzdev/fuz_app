/**
 * Cross-process body-size-limit parity for fuz_app's own spine over real HTTP.
 * Companion to `origin.cross.test.ts`: drives the 1 MiB request body cap
 * (over-limit POST → 413 `payload_too_large`, at-limit / under-limit → pass)
 * over real requests against each spawned backend — the TS spine binaries + the
 * Rust `testing_spine_stub`. Plus the raw-socket request-smuggling probe
 * (`describe_body_size_smuggling_cross_tests`), which pins that the 413 closes
 * the connection rather than reusing it with the unread body. The body-size
 * limit is on every spine, so the suite is ungated.
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.js';
import {describe_body_size_cross_tests} from '$lib/testing/cross_backend/body_size.js';
import {describe_body_size_smuggling_cross_tests} from '$lib/testing/cross_backend/body_size_smuggling.js';

import './cross_test_types.js';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const {capabilities, rpc_path, base_url} = handle.config;

describe_body_size_cross_tests({setup_test, capabilities, rpc_path});
describe_body_size_smuggling_cross_tests({base_url, rpc_path});
