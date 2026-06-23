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
 * A second test asserts **migration-identity** parity over the
 * `_testing_migration_tracker` RPC: the two spines must record byte-identical
 * `schema_version` rows (namespace + name + sequence). The schema snapshot
 * excludes that tracker by design (provenance-agnostic), so this is the gate
 * that catches a migration-name or partitioning divergence — the gap that let
 * the visiones cutover break.
 *
 * Both backends migrate the same namespaces (auth + `fuz_cell` +
 * `fuz_cell_history` + `fuz_facts`), so there are no excluded tables. The
 * snapshot now captures `CREATE TYPE ... AS ENUM` types, so a `cell_visibility`
 * label-set / ordering drift is a gated fact here, not invisible.
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
	capture_migration_tracker,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.ts';
import {
	assert_schema_snapshots_equal,
	assert_migration_trackers_equal,
} from '$lib/testing/schema_parity.ts';

import './cross_test_types.ts';

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

	// The migration-identity gate the schema snapshot is blind to: the two
	// spines must record byte-identical `schema_version` rows (namespace + name
	// + sequence) so a consumer can swap TS↔Rust over one DB without
	// re-bootstrapping. A name rename or partitioning change that yields an
	// identical schema passes the snapshot test above but breaks the runner's
	// positional name-prefix check at boot — exactly the divergence
	// (`cell_v0` vs `full_cell_schema`) that crashed the 2026-06-23 visiones
	// cutover and that the snapshot gate (which excludes `schema_version`)
	// could not see.
	test('TS spine (node) and Rust spine_stub record identical migration identity', async () => {
		const ts = reconstruct_bootstrapped_handle(inject('parity_handle_a'));
		const rust = reconstruct_bootstrapped_handle(inject('parity_handle_b'));
		const [ts_tracker, rust_tracker] = await Promise.all([
			capture_migration_tracker(ts),
			capture_migration_tracker(rust),
		]);
		assert_migration_trackers_equal(ts_tracker, rust_tracker, {a: 'ts', b: 'rust'});
	});
});
