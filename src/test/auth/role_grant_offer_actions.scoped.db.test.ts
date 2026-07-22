/**
 * Integration tests for scope-aware role_grant offer flows — cross-cutting
 * behavior spanning create and accept where the `scope_id` invariant
 * matters (scoped role_grant materialization; sibling offers in different
 * scopes don't supersede each other).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { create_test_app } from '$lib/testing/app_server.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import {
	role_grant_offer_create_action_spec,
	role_grant_offer_accept_action_spec
} from '$lib/auth/role_grant_offer_action_specs.ts';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';
import { rpc_call_for_spec } from '$lib/testing/rpc_helpers.ts';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options
} from './role_grant_offer_test_helpers.ts';

describe_db('role_grant_offer_actions.scoped', (get_db) => {
	describe('scoped offers', () => {
		test('create-with-scope yields a scoped role_grant on accept', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const recipient = await test_app.create_account({ username: 'scope_recipient' });
			const scope_id = create_uuid();
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					role: ROLE_ADMIN,
					scope_kind: 'classroom',
					scope_id
				},
				headers: test_app.create_session_headers()
			});
			assert.ok(create_res.ok);
			assert.strictEqual(create_res.result.offer.scope_id, scope_id);
			const accept_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_accept_action_spec,
				params: { offer_id: create_res.result.offer.id },
				headers: recipient.create_session_headers()
			});
			assert.ok(accept_res.ok);
			const role_grant_rows = await get_db().query<{ scope_id: string | null }>(
				`SELECT scope_id FROM role_grant WHERE id = $1`,
				[accept_res.result.role_grant_id]
			);
			assert.strictEqual(role_grant_rows[0]?.scope_id, scope_id);
		});

		test('sibling offers in different scopes do not supersede each other', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN]
			});
			const recipient = await test_app.create_account({ username: 'scope_sibling_recipient' });
			const scope_a = create_uuid();
			const scope_b = create_uuid();
			const create_a = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					role: ROLE_ADMIN,
					scope_kind: 'classroom',
					scope_id: scope_a
				},
				headers: test_app.create_session_headers()
			});
			assert.ok(create_a.ok);
			const offer_a = create_a.result.offer.id;
			const create_b = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					role: ROLE_ADMIN,
					scope_kind: 'classroom',
					scope_id: scope_b
				},
				headers: test_app.create_session_headers()
			});
			assert.ok(create_b.ok);
			const offer_b = create_b.result.offer.id;
			const accept_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_accept_action_spec,
				params: { offer_id: offer_a },
				headers: recipient.create_session_headers()
			});
			assert.ok(accept_res.ok);
			// Sibling in a different scope stays pending.
			assert.deepStrictEqual(accept_res.result.superseded_offer_ids, []);
			const rows = await get_db().query<{ id: string; superseded_at: Date | null }>(
				`SELECT id, superseded_at FROM role_grant_offer WHERE id = ANY($1::uuid[])`,
				[[offer_a, offer_b]]
			);
			const by_id = new Map(rows.map((r) => [r.id, r]));
			assert.strictEqual(by_id.get(offer_b)?.superseded_at, null);
		});
	});
});
