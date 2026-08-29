/**
 * Cross-process API-token-lifetime parity for fuz_app's own spine over real
 * HTTP — the TS spine binaries + the Rust `testing_spine_stub`. The decisive
 * case is the ttl mint → `account_token_list` read-back: the action-manifest
 * parity gate is blind to param schemas, so a spine that silently ignored the
 * `lifetime` field would 200 with an eternal token — only this round-trip
 * catches it. Ungated (mint + list are on every spine's standard surface).
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_token_lifetime_cross_tests } from '$lib/testing/cross_backend/token_lifetime.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

describe_token_lifetime_cross_tests({ setup_test });
