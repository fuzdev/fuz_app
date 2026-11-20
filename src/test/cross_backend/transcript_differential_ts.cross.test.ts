/**
 * The transcript differential's calibration leg: the TS spine binary on Node
 * against itself on Bun, both on `memory://`, under the dual-spawn
 * `cross_backend_ts_differential` project (`cross_backend_projects.ts`). One
 * implementation on two runtimes, so its ledger is empty and any difference
 * is normalizer noise or a runtime quirk. The dump directory is
 * `transcript_differential.cross.test.ts`'s.
 *
 * @module
 */

import { inject } from 'vitest';

import { reconstruct_bootstrapped_handle } from '#lib/testing/cross_backend/setup.ts';

import {
	describe_transcript_differential,
	TRANSCRIPT_DUMP_DIR_ENV
} from './transcript_differential.ts';
import './cross_test_types.ts';

describe_transcript_differential({
	sides: [
		{ name: 'node', handle: reconstruct_bootstrapped_handle(inject('ts_differential_handle_a')) },
		{ name: 'bun', handle: reconstruct_bootstrapped_handle(inject('ts_differential_handle_b')) }
	],
	ledger: [],
	dump_dir: process.env[TRANSCRIPT_DUMP_DIR_ENV]
});
