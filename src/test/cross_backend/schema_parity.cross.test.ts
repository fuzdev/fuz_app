/**
 * Cross-backend schema-parity gate for fuz_app's own spine.
 *
 * fuz_app ships the canonical TS spine and the Rust spine is its twin;
 * the cross-backend suites already prove their wire behavior converges. This
 * gate proves their **database schema** converges too: it spawns both the TS
 * spine (Node + PGlite) and the Rust `testing_spine_stub` (real Postgres) via
 * the dual-spawn `global_setup_schema_parity.ts`, captures each backend's live
 * schema over the `_testing_schema_snapshot` RPC (TS introspects via
 * `query_schema_snapshot`, Rust via `fuz_db::query_schema_snapshot`), and
 * asserts **full** structural equality — failing loud with the specific drift.
 *
 * Both backends migrate the same namespaces (auth + `fuz_cell` + `fuz_facts`),
 * so there are no excluded tables. The snapshot now captures `CREATE TYPE ...
 * AS ENUM` types, so a `cell_visibility` label-set / ordering drift is a gated
 * fact here, not invisible.
 *
 * Runs under the dual-spawn `cross_backend_parity` project, which it shares
 * with the action-manifest parity gate (`action_manifest_parity.cross.test.ts`)
 * — one TS-spine + Rust-stub spawn serves both. Opt-in (behind
 * `FUZ_TEST_CROSS_BACKEND=1`); the Rust side needs a Postgres the stub can
 * reach — `npm run test:cross:parity` rebuilds the stub + creates its DB by
 * default.
 *
 * @module
 */

import {inject, describe, test} from 'vitest';

import {
	capture_schema_snapshot,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.js';
import {assert_schema_snapshots_equal} from '$lib/testing/schema_parity.js';

import './cross_test_types.js';

describe('cross-backend schema parity', () => {
	test('TS spine (node) and Rust spine_stub schemas match', async () => {
		const ts = reconstruct_bootstrapped_handle(inject('parity_handle_a'));
		const rust = reconstruct_bootstrapped_handle(inject('parity_handle_b'));
		const [ts_snapshot, rust_snapshot] = await Promise.all([
			capture_schema_snapshot(ts),
			capture_schema_snapshot(rust),
		]);
		assert_schema_snapshots_equal(ts_snapshot, rust_snapshot, {a: 'ts', b: 'rust'});
	});
});
