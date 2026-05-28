/**
 * Cross-process SSE suite for fuz_app's own spine over real HTTP.
 *
 * Companion to `auth.cross.test.ts` (HTTP + RPC) and `ws.cross.test.ts` (live
 * WebSocket): this one drives the live audit-log SSE path via a real
 * streaming `fetch` against the spawned spine binary. Runs under every
 * `cross_backend_*` project — the TS spines wire `audit_log_sse` and the Rust
 * `spine_stub` serves the same `/api/admin/audit/stream` from the spine
 * `fuz_realtime::SseRegistry`, so all advertise `capabilities.sse` and the
 * suite's three cases run on every backend.
 *
 * The fresh-per-test keeper holds `ROLE_ADMIN` by default, so it can
 * subscribe to the admin-gated stream and drive the revoke RPCs the
 * data-frame + close cases need.
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.js';
import {describe_cross_process_sse_tests} from '$lib/testing/cross_backend/sse_round_trip.js';

import './cross_test_types.js';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const {capabilities} = handle.config;
const base_url = handle.config.base_url;

describe_cross_process_sse_tests({
	setup_test,
	capabilities,
	base_url,
	sse_path: handle.config.sse_path,
	rpc_path: handle.config.rpc_path,
});
