import '../assert_dev_env.js';

/**
 * Cross-backend parity suite for the `/ready` schema-drift deploy gate.
 *
 * The `/ready` mechanism already ships on both twins (TS `create_ready_route_spec`
 * / `db/schema_ready.ts`; Rust `fuz_http::ready` / `fuz_db::schema_ready`), each
 * with its own drift → `503` unit tests. This suite is the missing automated
 * cross-impl gate: an anonymous `GET /ready` returns `200 {ready: true}` over
 * real HTTP on **both** spine test servers, proving the success path is wire-
 * identical and that both backends read the same committed `expected_schema.json`
 * (column-presence is engine-portable, so one fixture is the cross-impl contract).
 *
 * `/ready` is a plain public REST route — not an RPC method, not one of the six
 * REST auth routes — and it's deliberately **off** the declared spine surface
 * (`create_spine_surface_spec`), like ws/sse/cells/fact-serving. So it needs a
 * bespoke imperative suite (à la `origin.cross.test.ts`), gated on
 * `capabilities.ready`, rather than a `conformance_table` row or generic
 * round-trip enumeration. The drift → `503` path stays per-impl unit tests.
 *
 * Runs both legs via the shared `{setup_test, capabilities}` protocol: the
 * in-process leg (`cross_backend/ready_parity.db.test.ts`, plain `gro test`) and
 * the cross-process leg (`cross_backend/ready.cross.test.ts`, the TS spine
 * binaries + Rust `testing_spine_stub` over real HTTP).
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import {describe, assert} from 'vitest';

import {test_if} from './capabilities.js';
import type {CrossSuiteOptions} from './setup.js';

/** Options for the readiness-probe parity suite. */
export interface ReadyCrossTestOptions extends CrossSuiteOptions {
	/** Readiness probe path. Default `/ready`. */
	readonly ready_path?: string;
}

export const describe_ready_cross_tests = (options: ReadyCrossTestOptions): void => {
	const {setup_test, capabilities} = options;
	const ready_path = options.ready_path ?? '/ready';

	describe('readiness probe parity', () => {
		test_if(
			capabilities.ready,
			'anonymous GET /ready → 200 {ready: true} on a clean spine bootstrap',
			async () => {
				const fixture = await setup_test();
				// Anonymous deploy-poll shape: cookie-jar-free, no Origin, no auth.
				// `/ready` is public and outside `/api`, so neither the session /
				// bearer middleware nor the RPC dispatcher sits in the path — exactly
				// how a deploy gate (zap) polls it post-deploy. A freshly bootstrapped
				// spine covers the committed expected column map, so the drift check
				// passes.
				const res = await fixture.fresh_transport({origin: null})(ready_path, {method: 'GET'});
				assert.strictEqual(res.status, 200, 'a clean spine bootstrap must report ready');
				const body = (await res.json().catch(() => undefined)) as {ready?: unknown} | undefined;
				assert.strictEqual(body?.ready, true);
			},
		);
	});
};
