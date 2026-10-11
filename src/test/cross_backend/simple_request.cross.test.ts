/**
 * Cross-process CORS simple-request parity for fuz_app's own spine over real
 * HTTP. Companion to `origin.cross.test.ts`: an untyped, `text/plain`, or
 * form-encoded `POST` — what a browser sends cross-origin without a
 * preflight — is refused with 415 by each spawned backend, the TS spine
 * binaries + the Rust `testing_spine_stub`. Every spine has the gate, so the
 * suite is ungated.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_simple_request_cross_tests } from '#lib/testing/cross_backend/simple_request.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { rpc_path } = handle.config;

describe_simple_request_cross_tests({ setup_test, rpc_path });
