import '../assert_dev_env.js';

/**
 * Cross-backend parity suite for `actor_search`.
 *
 * `actor_search` is an opt-in case-insensitive prefix search over
 * `actor.name` (`{query, scope_ids?, limit?} → {actors: [{id, username,
 * display_name?}]}`), not folded into the standard bundle. Like
 * `actor_lookup` / cells, it's live-mounted on the spine RPC path but kept
 * off the declared surface, so this dedicated suite is its validator. The
 * security property under test is the **empty-`scope_ids` admin gate**:
 *
 * - **anonymous → 401** — the account-grain auth gate refuses an
 *   unauthenticated caller before the handler runs.
 * - **non-admin + no `scope_ids` → 400** `actor_search_scope_required` — an
 *   unbounded global search is admin-only; a non-admin must scope the query.
 *   This is the core security assertion, exercised against each impl's real
 *   auth resolution.
 * - **non-admin + `scope_ids` → 200** — passing a scope bypasses the admin
 *   requirement (results are filtered to actors holding active role_grants on
 *   those scopes); an unheld scope simply yields an empty result, not a
 *   rejection — proving the gate keys on `scope_ids` presence, not identity.
 * - **admin + no `scope_ids` → 200** — the admin path reaches the unbounded
 *   search.
 *
 * Cites `security.md` §Authorization (the `actor_search` scope gate).
 *
 * Runs both legs via the shared `{setup_test}` protocol: in-process
 * (`auth/actor_search_parity.db.test.ts`) + cross-process
 * (`cross_backend/actor_search.cross.test.ts`, TS spine binaries + Rust
 * `testing_spine_stub`). Mounted on every spine, so the suite is ungated.
 *
 * `$lib`-free by contract (relative specifiers only).
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {
	actor_search_action_spec,
	ERROR_ACTOR_SEARCH_SCOPE_REQUIRED,
} from '../../auth/actor_search_action_specs.js';
import type {CellCrossTestOptions} from './cell_cross_helpers.js';
import {SPINE_RPC_PATH} from './default_spine_surface.js';

/** Options for the actor-search parity suite (shares the cell/origin shape). */
export type ActorSearchCrossTestOptions = CellCrossTestOptions;

/** Nil UUID — an unheld scope id (no actor holds a role_grant on it). */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Build the JSON-RPC envelope body for an `actor_search` call. */
const search_envelope = (params: Record<string, unknown>, id: string): string =>
	JSON.stringify({jsonrpc: '2.0', method: actor_search_action_spec.method, params, id});

export const describe_actor_search_cross_tests = (options: ActorSearchCrossTestOptions): void => {
	const {setup_test} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('actor_search parity', () => {
		test('anonymous → 401 (account-grain auth gate)', async () => {
			const fixture = await setup_test();
			const res = await fixture.fresh_transport()(rpc_path, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: search_envelope({query: 'a'}, 'anon-search'),
			});
			assert.strictEqual(res.status, 401, 'unauthenticated actor_search must be refused');
		});

		test('non-admin + no scope_ids → 400 actor_search_scope_required', async () => {
			const fixture = await setup_test();
			const account = await fixture.create_account();
			const res = await fixture.fresh_transport()(rpc_path, {
				method: 'POST',
				headers: {...account.create_session_headers(), 'content-type': 'application/json'},
				body: search_envelope({query: 'a'}, 'nonadmin-noscope'),
			});
			assert.strictEqual(res.status, 400, 'non-admin unbounded search must be rejected');
			const body = (await res.json()) as {error?: {data?: {reason?: unknown}}};
			assert.strictEqual(
				body.error?.data?.reason,
				ERROR_ACTOR_SEARCH_SCOPE_REQUIRED,
				'rejection carries the scope-required reason',
			);
		});

		test('non-admin + scope_ids → 200 (scope bypasses admin gate)', async () => {
			const fixture = await setup_test();
			const account = await fixture.create_account();
			const res = await fixture.fresh_transport()(rpc_path, {
				method: 'POST',
				headers: {...account.create_session_headers(), 'content-type': 'application/json'},
				body: search_envelope({query: 'a', scope_ids: [NIL_UUID]}, 'nonadmin-scope'),
			});
			assert.strictEqual(res.status, 200, 'non-admin with a scope filter is allowed');
			const body = (await res.json()) as {result?: {actors?: unknown}};
			assert(Array.isArray(body.result?.actors), 'response carries an actors array');
		});

		test('admin + no scope_ids → 200 (admin reaches unbounded search)', async () => {
			const fixture = await setup_test();
			const res = await fixture.transport(rpc_path, {
				method: 'POST',
				headers: {...fixture.create_session_headers(), 'content-type': 'application/json'},
				body: search_envelope({query: 'a'}, 'admin-noscope'),
			});
			assert.strictEqual(res.status, 200, 'admin unbounded search is allowed');
			const body = (await res.json()) as {result?: {actors?: unknown}};
			assert(Array.isArray(body.result?.actors), 'response carries an actors array');
		});
	});
};
