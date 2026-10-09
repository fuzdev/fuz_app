/**
 * Cross-process suite for the WebSocket refusals ahead of dispatch — a request
 * reusing a live id, and one past the per-socket in-flight ceiling — over a
 * real upgrade against fuz_app's own spine binaries and the Rust
 * `testing_spine_stub`, so both spines are pinned to the same answers.
 *
 * Gated on `capabilities.peer_request`: the cases hold requests in flight with
 * `peer/ping`.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_ws_inbound_dispatch_cross_tests } from '$lib/testing/cross_backend/ws_inbound_dispatch.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities, base_url, ws_path } = handle.config;

describe_ws_inbound_dispatch_cross_tests({
	setup_test,
	capabilities,
	base_url,
	ws_path
});
