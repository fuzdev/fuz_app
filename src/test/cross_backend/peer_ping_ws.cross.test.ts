/**
 * Cross-process server-initiated `peer/ping` suite for fuz_app's own spine
 * over real HTTP.
 *
 * The server→client request/response sibling of
 * `role_grant_offer_notification_ws.cross.test.ts` (server→client
 * notifications): it drives the ActionPeer round-trip — a client invokes
 * the `peer/ping` action, the server pings back over the same socket, the
 * client's `on_request` responder echoes, and the server validates + returns
 * — plus the security negatives (unsolicited-response rejection,
 * per-connection id isolation, never-reply `Timeout`, wrong-shape rejection,
 * client-error forwarding, HTTP no-transport).
 *
 * Runs under every `cross_backend_*` project but gates each case on
 * `capabilities.peer_request` — `true` only for the Rust `testing_spine_stub`
 * (server-initiated requests are Rust-first canonical), `false` for the TS
 * spine binaries (the TS server's request transport is the deferred twin-impl
 * convergence item), so the TS projects register the cases as `.skip`.
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.ts';
import {describe_peer_ping_ws_tests} from '$lib/testing/cross_backend/peer_ping_ws.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const {capabilities, base_url, ws_path} = handle.config;

describe_peer_ping_ws_tests({
	setup_test,
	capabilities,
	base_url,
	ws_path,
});
