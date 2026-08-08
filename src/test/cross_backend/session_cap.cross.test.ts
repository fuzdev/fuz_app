/**
 * Cross-process per-account session-cap parity for fuz_app's own spine over
 * real HTTP. Companion to `cookie_attributes.cross.test.ts`: logs in past the
 * cap against each spawned backend — the TS spine binaries + the Rust
 * `testing_spine_stub` — and asserts the oldest session is evicted while the
 * newest still resolves. Both spines enforce the cap (TS `DEFAULT_MAX_SESSIONS`,
 * Rust's `const` of the same name), so the suite is ungated.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_session_cap_cross_tests } from '$lib/testing/cross_backend/session_cap.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

describe_session_cap_cross_tests({ setup_test });
