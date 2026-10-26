/**
 * Cross-runtime differential gate for fuz_app's TS spine, Node against Bun.
 *
 * The same suites as `differential.cross.test.ts`
 * (`describe_spine_differential_suites`), with the TS spine binary on Node as
 * one side and on Bun as the other: one implementation, two runtimes, so any
 * difference in an answer is the runtime's — its HTTP server, its WebSocket
 * upgrade, its `Request` / `Response` — never the spine's logic.
 *
 * The ledger is empty. The TS-vs-Rust ledger's rows are all TS-against-Rust
 * differences, and its DEV-only rows (Zod `issues` on `invalid_params`, the
 * `X-Fuz-Auth-Debug` header) show on both sides here, since both binaries run
 * the one spine under `DEV` — a ledger row naming them would fail as an entry
 * that no longer differs.
 *
 * Runs under the dual-spawn `cross_backend_ts_differential` project
 * (`ts_differential_handle_a` = Node, `ts_differential_handle_b` = Bun), both
 * on `memory://`, so it needs no Postgres and runs in the `cross-ts` CI job.
 *
 * @module
 */

import { inject } from 'vitest';

import { reconstruct_bootstrapped_handle } from '#lib/testing/cross_backend/setup.ts';

import { describe_spine_differential_suites } from './spine_differential.ts';
import './cross_test_types.ts';

describe_spine_differential_suites({
	backends: [
		{ name: 'node', handle: reconstruct_bootstrapped_handle(inject('ts_differential_handle_a')) },
		{ name: 'bun', handle: reconstruct_bootstrapped_handle(inject('ts_differential_handle_b')) }
	]
});
