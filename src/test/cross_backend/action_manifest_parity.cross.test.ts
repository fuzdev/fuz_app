/**
 * Cross-backend action-manifest parity gate for fuz_app's own spine.
 *
 * The action-surface twin of `schema_parity.cross.test.ts`. fuz_app ships the
 * canonical TS spine and the Rust spine is its twin; the cross-backend suites
 * already prove their wire behavior converges, and the schema-parity gate
 * proves their database schema converges. This gate proves their **live RPC
 * method set** converges too: it spawns both the TS spine (Node + PGlite) and
 * the Rust `testing_spine_stub` (real Postgres) via the dual-spawn
 * `global_setup_schema_parity.ts`, dumps each backend's live RPC registry over
 * the `_testing_action_manifest` RPC (TS via `build_action_manifest`, Rust via
 * `fuz_testing::create_testing_action_manifest_action_spec`), and asserts
 * **method-set + per-method auth-shape** equality — failing loud with the
 * specific divergence.
 *
 * The manifest excludes the protocol actions (`heartbeat` / `cancel`) by
 * construction (the TS spine mounts them WS-only; the Rust stub on one shared
 * registry — see `action_manifest.ts` §Scope), so the diff stays
 * apples-to-apples. This complements the in-repo `spine_method_coverage` gate:
 * that proves *mounted ⟹ covered*; this proves *TS-mount-set ≡ Rust-mount-set*.
 *
 * The gate asserts **exact** parity — every mounted method and its full auth
 * shape (side-effects + the four auth axes) must match across the two impls,
 * with no allowlisted divergences.
 *
 * Runs under the same dual-spawn `cross_backend_parity` project as the
 * schema-parity gate — one TS-spine + Rust-stub spawn serves both gates
 * (`parity_handle_a` / `_b`). Opt-in (behind `FUZ_TEST_CROSS_BACKEND=1`);
 * the Rust side needs a Postgres the stub can reach — `npm run test:cross:parity`
 * rebuilds the stub + creates its DB by default.
 *
 * @module
 */

import {inject, describe, test} from 'vitest';

import {
	capture_action_manifest,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.js';
import {assert_action_manifests_equal} from '$lib/testing/cross_backend/action_manifest_parity.js';

import './cross_test_types.js';

describe('cross-backend action-manifest parity', () => {
	test('TS spine (node) and Rust spine_stub RPC method sets match exactly', async () => {
		const ts = reconstruct_bootstrapped_handle(inject('parity_handle_a'));
		const rust = reconstruct_bootstrapped_handle(inject('parity_handle_b'));
		const [ts_manifest, rust_manifest] = await Promise.all([
			capture_action_manifest(ts),
			capture_action_manifest(rust),
		]);
		assert_action_manifests_equal(ts_manifest, rust_manifest, {a: 'ts', b: 'rust'});
	});
});
