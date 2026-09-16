/**
 * Cross-process session-cookie-attribute parity for fuz_app's own spine over
 * real HTTP. Companion to `origin.cross.test.ts`: drives login / failed-login /
 * logout against each spawned backend — the TS spine binaries + the Rust
 * `testing_spine_stub` — and asserts the `Set-Cookie` attributes
 * (`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age`) match on every spine.
 * The session cookie is on every spine, so the suite is ungated.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_cookie_attributes_cross_tests } from '$lib/testing/cross_backend/cookie_attributes.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { cookie_name } = handle.config;

describe_cookie_attributes_cross_tests({ setup_test, cookie_name });
