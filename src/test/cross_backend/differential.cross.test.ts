/**
 * Cross-backend differential gate for fuz_app's own spine, TS against Rust.
 *
 * Sends every conformance case to both the TS spine (Node) and the Rust
 * `testing_spine_stub`, and asserts the two normalized responses are equal
 * (`describe_spine_differential_suites`, over
 * `describe_differential_conformance_tests`): status, header names and the
 * whole body, ids and timestamps placeholdered by position. Each impl is the
 * oracle for the other, so an extra field one spine sends — which a loose
 * output schema passes — or any body difference on a case pinned by status
 * alone fails here. Tracked differences are the ledger in
 * `differential_known_divergences.ts`.
 *
 * Runs under the dual-spawn `cross_backend_parity` project (`parity_handle_a`
 * = TS, `parity_handle_b` = Rust), both spines on Postgres, so no engine
 * difference can show up as a body difference.
 *
 * @module
 */

import { inject } from 'vitest';

import { reconstruct_bootstrapped_handle } from '#lib/testing/cross_backend/setup.ts';

import {
	differential_known_divergences,
	differential_participation_known_divergences,
	differential_ws_known_divergences
} from './differential_known_divergences.ts';
import { describe_spine_differential_suites } from './spine_differential.ts';
import './cross_test_types.ts';

describe_spine_differential_suites({
	backends: [
		{ name: 'ts', handle: reconstruct_bootstrapped_handle(inject('parity_handle_a')) },
		{ name: 'rust', handle: reconstruct_bootstrapped_handle(inject('parity_handle_b')) }
	],
	known_divergences: {
		http: differential_known_divergences,
		ws: differential_ws_known_divergences,
		participation: differential_participation_known_divergences
	}
});
