/**
 * Cross-process front-door contract for fuz_app's own spine over real HTTP:
 * the per-transport composition table (`describe_transport_composition_cross_tests`)
 * against each spawned backend — the TS spine binaries and the Rust
 * `testing_spine_stub`. The WebSocket and SSE rows gate on
 * `capabilities.ws` / `capabilities.sse`, both `true` on every spine backend.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_transport_composition_cross_tests } from '#lib/testing/cross_backend/transport_composition.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities, rpc_path, base_url, ws_path, sse_path } = handle.config;

describe_transport_composition_cross_tests({
	setup_test,
	capabilities,
	rpc_path,
	base_url,
	ws_path,
	sse_path
});
