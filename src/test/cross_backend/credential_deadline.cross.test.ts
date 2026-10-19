/**
 * Cross-process credential-deadline parity for fuz_app's own spine: a
 * WebSocket on a session or an API token closes with 4001 "Credential
 * expired" at its credential's expiry, an audit stream on a session ends
 * there, and the `_testing_shorten_credential_expiry` seam that brings the
 * expiry in only ever shortens it.
 *
 * @module
 */

import { inject } from 'vitest';

import { describe_credential_deadline_cross_tests } from '#lib/testing/cross_backend/credential_deadline.ts';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));

describe_credential_deadline_cross_tests({
	setup_test: default_cross_process_setup(handle),
	capabilities: handle.config.capabilities,
	base_url: handle.config.base_url,
	ws_path: handle.config.ws_path
});
