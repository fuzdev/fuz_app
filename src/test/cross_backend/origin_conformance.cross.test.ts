/**
 * Cross-process origin allowlist conformance for fuz_app's own spine: every
 * row of the committed `origin_conformance.json` table, sent to each spawned
 * backend's `_testing_origin_check` action — the TS spine binaries and the
 * Rust `testing_spine_stub` — must get the answer the table names. The TS unit
 * leg is `http/origin.conformance.test.ts`.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_origin_conformance_cross_tests } from '#lib/testing/cross_backend/origin_conformance.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { rpc_path } = handle.config;

describe_origin_conformance_cross_tests({ setup_test, rpc_path });
