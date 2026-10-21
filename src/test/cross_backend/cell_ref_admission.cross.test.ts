/**
 * Cross-process parity for possession-gated cell ref admission over real HTTP.
 *
 * Companion to `fact_serving.cross.test.ts`: drives
 * `describe_cell_ref_admission_cross_tests` (gated on
 * `capabilities.fact_serving` — it seeds facts through `_testing_put_fact` and
 * reads them back through the cell-scoped serve route). Runs under every
 * `cross_backend_*` project — the TS spine binaries and the Rust
 * `testing_spine_stub` mount the cell verbs, the seeder, and the serve routes.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_cell_ref_admission_cross_tests } from '#lib/testing/cross_backend/cell_ref_admission.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities, rpc_path } = handle.config;

describe_cell_ref_admission_cross_tests({ setup_test, capabilities, rpc_path });
