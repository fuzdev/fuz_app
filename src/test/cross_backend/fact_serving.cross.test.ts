/**
 * Cross-process fact-serving parity for fuz_app's own spine over real HTTP.
 *
 * Companion to `cell.cross.test.ts`: drives the cell-gated fact-serving routes
 * (`GET /api/cells/:cell_id/facts/:hash` + the admin-only `GET /api/facts/:hash`)
 * against the spawned backend via `describe_fact_serving_cross_tests` (gated on
 * `capabilities.fact_serving`). Runs under every `cross_backend_*` project — the
 * TS spine binary and the Rust `testing_spine_stub` both mount the serve routes
 * and the `_testing_put_fact` seeder, so the cases run on all backends (no
 * `.skip`). The serve routes stay off the standard declared surface, like cells.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_fact_serving_cross_tests } from '$lib/testing/cross_backend/fact_serving.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
// Second setup whose keeper carries an extra actor — drives the multi-actor
// fallthrough case (a single-actor keeper can't reach the multi-actor branch).
// Every spine resolves the acting actor at the authorization phase from
// account-grain credentials, so this runs on TS and Rust alike. The rest of the
// suite runs against the single-actor `setup_test`.
const setup_test_multi_actor = default_cross_process_setup(handle, {
	extra_actors: ['second_persona']
});
const { capabilities, rpc_path } = handle.config;

describe_fact_serving_cross_tests({ setup_test, setup_test_multi_actor, capabilities, rpc_path });
