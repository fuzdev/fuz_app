/**
 * Multi-actor coverage — dispatcher-level 400 `actor_required`.
 *
 * Authenticated requests on a multi-actor account must hit the
 * dispatcher's authorization phase and surface
 * `400 actor_required` (with the available actor list) before the
 * handler runs — never silently pick. Single-actor accounts must
 * still resolve transparently. The third test asserts the full
 * JSON-RPC envelope wrap (regression guard for the dispatcher fold).
 *
 * @module
 */

import {assert, describe, test} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {role_grant_offer_list_action_spec} from '$lib/auth/role_grant_offer_action_specs.js';
import {ERROR_ACTOR_REQUIRED} from '$lib/http/error_schemas.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';

import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './role_grant_offer_test_helpers.js';
import {create_multi_actor_helpers} from './role_grant_offer.multi_actor.fixtures.js';

describe_db('role_grant_offer.multi_actor — dispatcher_400', (get_db) => {
	const {add_second_actor} = create_multi_actor_helpers(get_db);

	describe('dispatcher-level multi-actor 400', () => {
		test('authenticated request with multi-actor account hits 400 actor_required envelope before the handler runs', async () => {
			// The dispatcher's authorization phase enforces the multi-actor
			// contract: when the account has 2+ actors and the request
			// doesn't supply `acting`, surface 400 `actor_required` with
			// the available actor list before handler dispatch — never
			// silently pick. Single-actor accounts still resolve
			// transparently via `resolve_acting_actor` (regression guard
			// in the sibling test). `rpc_call_for_spec` rejects non-
			// envelope bodies, so reaching the data assertions is itself
			// the regression guard for the dispatcher's envelope wrap.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({
				username: 'multi_actor_middleware_400',
			});
			await add_second_actor(recipient.account.id, 'middleware_second');

			// `role_grant_offer_list` is `side_effects: false` so it exercises
			// the dispatcher's authorization-phase path without depending
			// on handler logic.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_list_action_spec,
				params: {},
				headers: recipient.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.error.message, ERROR_ACTOR_REQUIRED);
			const data = res.error.data as
				| {reason?: string; available?: Array<{id: string; name: string}>}
				| undefined;
			assert.strictEqual(data?.reason, ERROR_ACTOR_REQUIRED);
			assert.ok(Array.isArray(data?.available));
			assert.strictEqual(data.available.length, 2);
			const ids = new Set(data.available.map((a) => a.id));
			assert.ok(ids.has(recipient.actor.id));
		});

		test('authenticated single-actor account passes middleware (no false positive)', async () => {
			// Regression guard for the v1 1:1 default — middleware must
			// transparently pick the unique actor and not 400.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({
				username: 'multi_actor_single_passes',
			});

			const list_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_list_action_spec,
				params: {},
				headers: recipient.create_session_headers(),
			});
			assert.ok(list_res.ok);
		});

		test('actor_required body is wrapped in a full JSON-RPC envelope (regression for the dispatcher fold)', async () => {
			// Hits the dispatcher with an `acting`-declaring method on a
			// multi-actor account and asserts every envelope field by
			// hand. Pre-fold the response body was the plain
			// `{error, available}` shape `apply_authorization_phase`
			// produces — this test is the regression guard ensuring the
			// dispatcher's wrap continues to populate `jsonrpc`, `id`,
			// `error.code`, `error.message`, `error.data.reason`, and
			// `error.data.available`.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({
				username: 'multi_actor_envelope_regression',
			});
			await add_second_actor(recipient.account.id, 'envelope_second');

			const post_init = {
				method: 'POST' as const,
				headers: {
					...recipient.create_session_headers(),
					host: 'localhost',
					origin: 'http://localhost:5173',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'envelope_regression_id',
					method: role_grant_offer_list_action_spec.method,
					params: {},
				}),
			};
			const res = await test_app.app.request(RPC_PATH, post_init);
			assert.strictEqual(res.status, 400);
			const body = (await res.json()) as {
				jsonrpc?: string;
				id?: string;
				error?: {
					code?: number;
					message?: string;
					data?: {reason?: string; available?: Array<{id: string; name: string}>};
				};
			};
			assert.strictEqual(body.jsonrpc, '2.0');
			assert.strictEqual(body.id, 'envelope_regression_id');
			// 400 maps to `invalid_params` (-32602) via http_status_to_jsonrpc_error_code.
			assert.strictEqual(body.error?.code, -32602);
			assert.strictEqual(body.error?.message, ERROR_ACTOR_REQUIRED);
			assert.strictEqual(body.error?.data?.reason, ERROR_ACTOR_REQUIRED);
			assert.ok(Array.isArray(body.error?.data?.available));
			assert.strictEqual(body.error.data.available.length, 2);
			const ids = new Set(body.error.data.available.map((a) => a.id));
			assert.ok(ids.has(recipient.actor.id));
		});
	});
});
