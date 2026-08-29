/**
 * Cross-process query-string shape parity for fuz_app's own spine over real
 * HTTP. Companion to `origin.cross.test.ts`: drives the duplicate-key /
 * unknown-key / phase-order query semantics (the status route, the JSON-RPC
 * GET endpoint, and the bare-hash fact route) against each spawned backend —
 * the TS spine binaries + the Rust `testing_spine_stub`.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_query_shape_cross_tests } from '$lib/testing/cross_backend/query_shape.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities, rpc_path } = handle.config;

describe_query_shape_cross_tests({ setup_test, capabilities, rpc_path });
