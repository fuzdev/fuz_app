/**
 * Cross-process `/ready` readiness-probe parity for fuz_app's own spine over
 * real HTTP. Companion to `origin.cross.test.ts` / `auth.cross.test.ts`: drives
 * an anonymous `GET /ready` against each spawned backend — the TS spine binaries
 * + the Rust `testing_spine_stub` — and asserts `200 {ready: true}`, the
 * wire-identical success path of the schema-drift deploy gate. Both backends
 * read the same committed `expected_schema.json` (the TS spine via an
 * `import.meta.url` URL, the Rust stub via the absolute path
 * `rust_spine_stub_backend_config` passes through env). Gated on `capabilities.ready`,
 * which every spine advertises.
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.ts';
import {describe_ready_cross_tests} from '$lib/testing/cross_backend/ready.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const {capabilities} = handle.config;

describe_ready_cross_tests({setup_test, capabilities});
