/**
 * Cross-process account-lifecycle parity for fuz_app's own spine over real
 * HTTP. Companion to `auth.cross.test.ts` / `cell.cross.test.ts`: drives the
 * destructive admin verbs (`account_delete` / `account_undelete` /
 * `account_purge`) + the keeper guard over real JSON-RPC against the spawned
 * backend, gated on `capabilities.account_lifecycle`. These verbs live-mount
 * on every spine but stay off the declared surface (the generic round-trip
 * can't drive them), so this dedicated suite is their cross-impl validator.
 * Runs on every `cross_backend_*` project (TS spine binaries + Rust
 * `testing_spine_stub`).
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.ts';
import {describe_account_lifecycle_cross_tests} from '$lib/testing/cross_backend/account_lifecycle.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const {capabilities, rpc_path} = handle.config;

describe_account_lifecycle_cross_tests({setup_test, capabilities, rpc_path});
