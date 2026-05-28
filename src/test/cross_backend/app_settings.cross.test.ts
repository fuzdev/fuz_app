/**
 * Cross-process `open_signup` effect parity for fuz_app's own spine over
 * real HTTP. Drives the admin `app_settings_update` toggle and the
 * subsequent anonymous `POST /signup` against each spawned backend — the TS
 * spine binaries + the Rust `testing_spine_stub` — proving the signup
 * handler reads the toggle fresh from the database. The app-settings methods
 * and signup are on the standard surface of every spine, so the suite is
 * ungated.
 *
 * @module
 */

import {inject} from 'vitest';

import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.js';
import {describe_app_settings_cross_tests} from '$lib/testing/cross_backend/app_settings.js';

import './cross_test_types.js';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
// The keeper needs `ROLE_ADMIN` to call the admin-gated `app_settings_update`.
const setup_test = default_cross_process_setup(handle, {extra_keeper_roles: [ROLE_ADMIN]});
const {capabilities, rpc_path} = handle.config;

describe_app_settings_cross_tests({setup_test, capabilities, rpc_path});
