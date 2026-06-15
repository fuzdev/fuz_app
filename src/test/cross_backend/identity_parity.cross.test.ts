/**
 * Cross-process identity-primitive parity for fuz_app's own spine over real
 * HTTP. Companion to `origin.cross.test.ts`: drives the case-insensitive +
 * whitespace-trim login lookup, the no-Unicode-fold-collision negative, the
 * username-or-email login lookup, login/signup input validation, and the
 * username + email creation rules (ASCII-only, length/format regex, loose
 * `local@domain.tld` email shape) over real requests against each spawned
 * backend — the TS spine binaries + the Rust `testing_spine_stub`. Login +
 * signup are on every spine, so the suite is ungated.
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.js';
import {describe_identity_parity_cross_tests} from '$lib/testing/cross_backend/identity_parity.js';

import './cross_test_types.js';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

describe_identity_parity_cross_tests({setup_test});
