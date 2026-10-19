/**
 * Cross-process origin-scope parity for fuz_app's own spine over real HTTP:
 * the origin check covers a path outside `/api` (`GET /ready`) on each spawned
 * backend — the TS spine binaries + the Rust `testing_spine_stub` — refusing a
 * foreign `Origin` and passing an absent or allowed one — and covers an unrouted
 * path the same way, an over-cap body there answering `413` first. Companion to
 * `transport_composition.cross.test.ts`, which pins the check on the `/api`
 * transports. Gated on `capabilities.ready`, which every spine advertises.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_origin_scope_cross_tests } from '#lib/testing/cross_backend/origin_scope.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities, base_url } = handle.config;

describe_origin_scope_cross_tests({ setup_test, capabilities, base_url });
