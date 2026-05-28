import '../assert_dev_env.js';

/**
 * Cross-backend parity suite for Origin verification.
 *
 * Origin checking is middleware that runs *before* the RPC dispatcher and
 * returns a flat REST `{error}` body — not a JSON-RPC envelope — so it
 * doesn't fit the envelope-shaped conformance-table runner. This dedicated
 * imperative suite drives raw transport calls instead, mirroring how the
 * in-process origin tests were already hand-rolled. Two cases:
 *
 * - **disallowed `Origin` → 403** `forbidden_origin`, refused before any
 *   handler runs (the allowlist rejects the cross-origin request even with
 *   a valid session cookie attached).
 * - **absent `Origin` → request passes** — non-browser / direct-access
 *   clients (curl, CLI, server-to-server) carry no `Origin` and must not be
 *   blocked; token auth is the control for those callers.
 *
 * Runs both legs via the shared `{setup_test, capabilities}` protocol: the
 * in-process leg (`auth/origin_parity.db.test.ts`, plain `gro test`) and the
 * cross-process leg (`cross_backend/origin.cross.test.ts`, the TS spine
 * binaries + Rust `testing_spine_stub` over real HTTP). Origin middleware is
 * on every spine, so the suite is ungated.
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {account_verify_action_spec} from '../../auth/account_action_specs.js';
import {ERROR_FORBIDDEN_ORIGIN} from '../../http/error_schemas.js';
import type {CellCrossTestOptions} from './cell_cross_helpers.js';
import {SPINE_RPC_PATH} from './default_spine_surface.js';

/**
 * Options for the origin parity suite. Shares the shape of the cell /
 * account-lifecycle suites (`setup_test` / `capabilities` / `rpc_path`);
 * reuses `CellCrossTestOptions` rather than minting a structural duplicate.
 */
export type OriginCrossTestOptions = CellCrossTestOptions;

/** Build the JSON-RPC envelope body for a nullary `account_verify` call. */
const verify_envelope = (id: string): string =>
	JSON.stringify({jsonrpc: '2.0', method: account_verify_action_spec.method, id});

export const describe_origin_cross_tests = (options: OriginCrossTestOptions): void => {
	const {setup_test} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('origin verification parity', () => {
		test('disallowed Origin → 403 forbidden_origin (refused before dispatch)', async () => {
			const fixture = await setup_test();
			// Keeper session cookie attached + a rogue Origin header (overrides
			// the transport's default allowed Origin). The allowlist must reject
			// before the dispatcher, returning a flat REST error body.
			const res = await fixture.transport(rpc_path, {
				method: 'POST',
				headers: {
					...fixture.create_session_headers(),
					origin: 'http://evil.com',
					'content-type': 'application/json',
				},
				body: verify_envelope('evil-origin'),
			});
			assert.strictEqual(res.status, 403, 'disallowed Origin must be rejected with 403');
			const body = (await res.json().catch(() => undefined)) as {error?: unknown} | undefined;
			assert.strictEqual(body?.error, ERROR_FORBIDDEN_ORIGIN);
		});

		test('absent Origin → request passes (non-browser direct access)', async () => {
			const fixture = await setup_test();
			// `origin: null` so no Origin header is sent at all (a header omission
			// alone wouldn't suffice cross-process — the jar auto-adds the default
			// allowed Origin). The keeper cookie rides via an explicit header.
			const res = await fixture.fresh_transport({origin: null})(rpc_path, {
				method: 'POST',
				headers: {
					...fixture.create_session_headers(),
					'content-type': 'application/json',
				},
				body: verify_envelope('no-origin'),
			});
			assert.strictEqual(res.status, 200, 'absent Origin with a valid session must pass');
		});
	});
};
