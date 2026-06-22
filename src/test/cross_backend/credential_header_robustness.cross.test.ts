/**
 * Cross-process credential-header robustness for fuz_app's own spine over real
 * HTTP. Companion to `body_size.cross.test.ts`'s smuggling probe: a raw-socket
 * suite that drives duplicate / oversized credential headers
 * (`Authorization`, `X-Daemon-Token`) against each spawned backend — the TS
 * spine binaries + the Rust `testing_spine_stub` — and asserts the
 * framework-agnostic auth invariants (no escalation, no desync, survives an
 * oversized header). The auth middleware is on every spine, so the suite is
 * ungated.
 *
 * @module
 */

import {inject} from 'vitest';

import {reconstruct_bootstrapped_handle} from '$lib/testing/cross_backend/setup.ts';
import {describe_credential_header_robustness_cross_tests} from '$lib/testing/cross_backend/credential_header_robustness.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const {base_url, rpc_path} = handle.config;

describe_credential_header_robustness_cross_tests({
	base_url,
	rpc_path,
	daemon_token: handle.daemon_token,
});
