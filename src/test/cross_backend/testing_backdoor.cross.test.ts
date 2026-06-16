/**
 * Cross-process negative-credential parity for the `_testing_*` backdoor
 * actions over real HTTP. Companion to `origin.cross.test.ts` /
 * `account_lifecycle.cross.test.ts`: fires `_testing_reset` /
 * `_testing_mint_session` / `_testing_put_fact` as anonymous / session /
 * bearer against each spawned backend (the TS spine binaries + the Rust
 * `testing_spine_stub`) and asserts the daemon-token gate refuses them
 * (401 / 403). Every cross backend mounts the `_testing_*` actions, so the
 * suite is ungated.
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.ts';
import {describe_testing_backdoor_cross_tests} from '$lib/testing/cross_backend/testing_backdoor.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const {capabilities, rpc_path} = handle.config;

describe_testing_backdoor_cross_tests({setup_test, capabilities, rpc_path});
