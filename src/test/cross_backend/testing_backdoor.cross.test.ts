/**
 * Cross-process negative-credential parity for the `_testing_*` backdoor
 * actions over real HTTP and WebSocket. Companion to `origin.cross.test.ts` /
 * `account_lifecycle.cross.test.ts`: fires every `_testing_*` action except
 * `_testing_drain_effects` as
 * anonymous / session / bearer over HTTP RPC, and on a session socket, against
 * each spawned backend (the TS spine binaries + the Rust `testing_spine_stub`)
 * and asserts the daemon-token gate refuses them. Every cross backend mounts
 * the `_testing_*` actions on RPC, and every fuz_app spine on WS too, so only
 * the WS cases are gated, on `capabilities.ws`.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_testing_backdoor_cross_tests } from '$lib/testing/cross_backend/testing_backdoor.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { rpc_path, capabilities, base_url, ws_path } = handle.config;

describe_testing_backdoor_cross_tests({
	setup_test,
	rpc_path,
	ws: capabilities.ws ? { base_url, ws_path } : undefined
});
