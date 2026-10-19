import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for Origin verification.
 *
 * Origin checking is middleware that runs *before* the RPC dispatcher and
 * refuses only an `Origin` it doesn't allow. The case here needs a transport
 * that sends no `Origin` at all (`fresh_transport({origin: null})`), so this
 * is an imperative suite rather than a conformance-table row. The case:
 *
 * - **absent `Origin` → request passes** — non-browser / direct-access
 *   clients (curl, CLI, server-to-server) carry no `Origin` and must not be
 *   blocked; token auth is the control for those callers.
 *
 * A disallowed `Origin` → 403 `forbidden_origin`, on every transport, is
 * pinned by the front-door table (`transport_composition.ts`).
 *
 * Runs both legs via the shared `setup_test` protocol: the
 * in-process leg (`auth/origin_parity.db.test.ts`, plain `gro test`) and the
 * cross-process leg (`cross_backend/origin.cross.test.ts`, the TS spine
 * binaries + Rust `testing_spine_stub` over real HTTP). Origin middleware is
 * on every spine, so the suite is ungated.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { account_verify_action_spec } from '../../auth/account_action_specs.ts';
import type { RpcPathCrossSuiteOptions } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/**
 * Options for the origin parity suite. The standard RPC-dispatched
 * cross-suite shape (`setup_test` / `rpc_path`); aliases the shared
 * `RpcPathCrossSuiteOptions` rather than minting a duplicate. Origin
 * middleware is on every spine, so no case is capability-gated and the flag
 * bundle is not on the shape.
 */
export type OriginCrossTestOptions = RpcPathCrossSuiteOptions;

/** Build the JSON-RPC envelope body for a nullary `account_verify` call. */
const verify_envelope = (id: string): string =>
	JSON.stringify({ jsonrpc: '2.0', method: account_verify_action_spec.method, id });

export const describe_origin_cross_tests = (options: OriginCrossTestOptions): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('origin verification parity', () => {
		test('absent Origin → request passes (non-browser direct access)', async () => {
			const fixture = await setup_test();
			// `origin: null` so no Origin header is sent at all (a header omission
			// alone wouldn't suffice cross-process — the jar auto-adds the default
			// allowed Origin). The keeper cookie rides via an explicit header.
			const res = await fixture.fresh_transport({ origin: null })(rpc_path, {
				method: 'POST',
				headers: {
					...fixture.create_session_headers(),
					'content-type': 'application/json'
				},
				body: verify_envelope('no-origin')
			});
			assert.strictEqual(res.status, 200, 'absent Origin with a valid session must pass');
		});
	});
};
