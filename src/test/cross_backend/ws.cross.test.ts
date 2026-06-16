/**
 * Cross-process WebSocket suite for fuz_app's own spine over real HTTP.
 *
 * Companion to `auth.cross.test.ts`: that file drives the standard
 * cross-process bundle (HTTP + RPC), this one drives the live WebSocket
 * path via a real upgrade against the spawned spine binary. Runs under
 * every `cross_backend_*` project (ts_node / ts_deno / ts_bun, and the
 * Rust spine_stub when its binary is available), so it is the in-repo
 * proof that fuz_app's WS upgrade + per-connection auth + dispatch work
 * over the wire on each runtime — the standard bundle omits WS by design.
 *
 * The spine mounts only `protocol_actions` on `/api/ws`, and the suite
 * drives `heartbeat` (present on every WS endpoint), so no domain layer is
 * involved.
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.ts';
import {describe_cross_process_ws_tests} from '$lib/testing/cross_backend/ws_round_trip.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const {capabilities} = handle.config;

describe_cross_process_ws_tests({
	setup_test,
	capabilities,
	base_url: handle.config.base_url,
	ws_path: handle.config.ws_path,
	rpc_path: handle.config.rpc_path,
});
