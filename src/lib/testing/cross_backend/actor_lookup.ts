import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for `actor_lookup`.
 *
 * `actor_lookup` is an opt-in batched id → label resolver
 * (`{ids} → {actors: [{id, username, display_name?}]}`), not folded into the
 * standard bundle. It's live-mounted on the spine RPC path but kept off the
 * declared surface (`create_spine_surface_spec`) — like cells / ws / sse — so
 * the standard cross suite's generic round-trip never drives it; this
 * dedicated suite is its validator. Three cases over raw transport calls:
 *
 * - **anonymous → 401** — the account-grain auth gate refuses an
 *   unauthenticated caller before the handler runs.
 * - **keeper resolves own actor → 200** — the populated round trip: the
 *   returned row carries the keeper's `id` + `username`, and **no**
 *   `account_id` / `email` / timestamp / role field (the wire shape's
 *   deliberate info-leak posture). This is the assertion that exercises the
 *   Rust row→JSON mapping against the TS canonical shape.
 * - **empty `ids` → 400** — the `min(1)` input bound is enforced on both
 *   spines (TS Zod, Rust `parse_ids`).
 *
 * Runs both legs via the shared `{setup_test}` protocol: the in-process leg
 * (`auth/actor_lookup_parity.db.test.ts`, plain `gro test`) and the
 * cross-process leg (`cross_backend/actor_lookup.cross.test.ts`, the TS spine
 * binaries + Rust `testing_spine_stub` over real HTTP). `actor_lookup` is
 * mounted on every spine, so the suite is ungated.
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {actor_lookup_action_spec} from '../../auth/actor_lookup_action_specs.ts';
import type {RpcPathCrossSuiteOptions} from './setup.ts';
import {SPINE_RPC_PATH} from './default_spine_surface.ts';

/**
 * Options for the actor-lookup parity suite. The standard RPC-dispatched
 * cross-suite shape (`setup_test` / `capabilities` / `rpc_path`); aliases
 * the shared `RpcPathCrossSuiteOptions` rather than minting a duplicate.
 */
export type ActorLookupCrossTestOptions = RpcPathCrossSuiteOptions;

/** Keys that must never appear on an `actor_lookup` result row. */
const forbidden_row_keys = ['account_id', 'email', 'created_at', 'updated_at', 'role'] as const;

/** Build the JSON-RPC envelope body for an `actor_lookup` call. */
const lookup_envelope = (ids: ReadonlyArray<string>, id: string): string =>
	JSON.stringify({jsonrpc: '2.0', method: actor_lookup_action_spec.method, params: {ids}, id});

export const describe_actor_lookup_cross_tests = (options: ActorLookupCrossTestOptions): void => {
	const {setup_test} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('actor_lookup parity', () => {
		test('anonymous → 401 (account-grain auth gate)', async () => {
			const fixture = await setup_test();
			const res = await fixture.fresh_transport()(rpc_path, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: lookup_envelope([fixture.actor.id], 'anon-lookup'),
			});
			assert.strictEqual(res.status, 401, 'unauthenticated actor_lookup must be refused');
		});

		test('keeper resolves own actor → 200 with id + username, no control fields', async () => {
			const fixture = await setup_test();
			const res = await fixture.transport(rpc_path, {
				method: 'POST',
				headers: {...fixture.create_session_headers(), 'content-type': 'application/json'},
				body: lookup_envelope([fixture.actor.id], 'keeper-lookup'),
			});
			assert.strictEqual(res.status, 200, 'authenticated actor_lookup must succeed');
			const body = (await res.json()) as {result?: {actors?: Array<Record<string, unknown>>}};
			const actors = body.result?.actors;
			assert(Array.isArray(actors), 'response carries an actors array');
			assert.strictEqual(actors.length, 1, 'the keeper actor resolves to exactly one row');
			const row = actors[0];
			assert(row !== undefined, 'the resolved row is present');
			assert.strictEqual(row.id, fixture.actor.id, 'resolved row id matches the requested actor');
			assert.strictEqual(
				row.username,
				fixture.account.username,
				'resolved row carries the keeper username',
			);
			for (const key of forbidden_row_keys) {
				assert(!(key in row), `actor_lookup row must not leak '${key}'`);
			}
		});

		test('empty ids → 400 (min(1) input bound)', async () => {
			const fixture = await setup_test();
			const res = await fixture.transport(rpc_path, {
				method: 'POST',
				headers: {...fixture.create_session_headers(), 'content-type': 'application/json'},
				body: lookup_envelope([], 'empty-lookup'),
			});
			assert.strictEqual(res.status, 400, 'empty ids must fail input validation');
		});
	});
};
