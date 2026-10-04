/**
 * Cross-process per-account WebSocket connection-cap parity for fuz_app's own
 * spine over a real upgrade. Companion to `ws.cross.test.ts` (the round-trip
 * suite) and `session_cap.cross.test.ts` (the sibling cap, on sessions): opens
 * one socket past the cap against each spawned backend — the TS spine binaries
 * and the Rust `testing_spine_stub` — and asserts the account's oldest socket
 * closes with `WS_CLOSE_CONNECTION_LIMIT` while the rest keep dispatching.
 * Both spines run the default cap (`DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT`), so
 * the suite takes no override.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_ws_connection_cap_cross_tests } from '$lib/testing/cross_backend/ws_connection_cap.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities } = handle.config;

describe_ws_connection_cap_cross_tests({
	setup_test,
	capabilities,
	base_url: handle.config.base_url,
	ws_path: handle.config.ws_path
});
