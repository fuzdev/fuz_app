/**
 * Cross-process outbound-overflow parity for fuz_app's own spine over a real
 * upgrade. Companion to `ws.cross.test.ts` (the round-trip suite) and
 * `ws_connection_cap.cross.test.ts` (the sibling per-account bound): floods a
 * daemon-token socket through `_testing_flood_notifications` against each
 * spawned backend — the TS spine binaries and the Rust `testing_spine_stub` —
 * and asserts a burst past the connection's outbound budget closes it with
 * `WS_CLOSE_OUTBOUND_OVERFLOW` and no response, while the account's other
 * connection keeps dispatching. Both spines run the default budget, so the
 * suite takes no override.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_ws_outbound_overflow_cross_tests } from '#lib/testing/cross_backend/ws_outbound_overflow.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities, base_url, ws_path, rpc_path } = handle.config;

describe_ws_outbound_overflow_cross_tests({
	setup_test,
	capabilities,
	base_url,
	ws_path,
	rpc_path
});
