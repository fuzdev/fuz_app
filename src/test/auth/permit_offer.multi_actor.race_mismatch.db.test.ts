/**
 * Multi-actor coverage — account-grain accept race-loser actor mismatch.
 *
 * Two actors on the same recipient account both attempt to accept the
 * same account-grain offer. The race winner binds the permit to actor
 * A; the loser must hit `PermitOfferAlreadyTerminalError` rather than
 * silently receive actor A's permit. Same-actor retry on an already-
 * accepted offer must continue to return the existing permit
 * idempotently.
 *
 * @module
 */

import {assert, describe, test} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {permit_offer_create_action_spec} from '$lib/auth/permit_offer_action_specs.js';
import {
	query_accept_offer,
	PermitOfferAlreadyTerminalError,
} from '$lib/auth/permit_offer_queries.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';

import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './permit_offer_test_helpers.js';
import {create_multi_actor_helpers} from './permit_offer.multi_actor.fixtures.js';

describe_db('permit_offer.multi_actor — race_mismatch', (get_db) => {
	const {add_second_actor} = create_multi_actor_helpers(get_db);

	describe('account-grain accept race-loser actor mismatch', () => {
		test("losing actor on the same account gets PermitOfferAlreadyTerminalError, not someone else's permit", async () => {
			// Two actors on the recipient account both attempt to accept
			// the same account-grain offer. The race winner binds the
			// permit to actor_A; the loser must not silently receive
			// "you got the permit" with actor_A's permit row attached.
			// Under v1 1:1 this branch is unreachable; under multi-actor
			// it's the difference between truthful "offer is terminal"
			// and misleading "permit obtained" UI.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'race_loser_recipient'});
			const second_actor_id = await add_second_actor(recipient.account.id, 'race_loser_b');

			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);

			// Actor A wins the race.
			const winner = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: create_res.result.offer.id,
						to_account_id: recipient.account.id,
						actor_id: recipient.actor.id,
						ip: null,
					},
				),
			);
			assert.strictEqual(winner.permit.actor_id, recipient.actor.id);

			// Actor B (the loser) tries to accept the same offer. The
			// offer is now accepted; the locked.accepted_at branch fires.
			// permit.actor_id !== actor_id → terminal error.
			const err = await assert_rejects(() =>
				get_db().transaction(async (tx) =>
					query_accept_offer(
						{db: tx},
						{
							offer_id: create_res.result.offer.id,
							to_account_id: recipient.account.id,
							actor_id: second_actor_id,
							ip: null,
						},
					),
				),
			);
			assert.ok(
				err instanceof PermitOfferAlreadyTerminalError,
				`expected PermitOfferAlreadyTerminalError, got ${err.constructor.name}: ${err.message}`,
			);
		});

		test('same-actor retry on accepted offer still returns idempotent permit (no spurious terminal)', async () => {
			// Retry path — same actor attempts twice, second call observes
			// the already-accepted offer and returns the existing permit.
			// Must not be broken by the loser-mismatch guard: actor matches.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'race_idempotent_retry'});

			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);

			const first = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: create_res.result.offer.id,
						to_account_id: recipient.account.id,
						actor_id: recipient.actor.id,
						ip: null,
					},
				),
			);
			const second = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: create_res.result.offer.id,
						to_account_id: recipient.account.id,
						actor_id: recipient.actor.id,
						ip: null,
					},
				),
			);
			assert.strictEqual(first.created, true);
			assert.strictEqual(second.created, false);
			assert.strictEqual(second.permit.id, first.permit.id);
			assert.strictEqual(second.permit.actor_id, recipient.actor.id);
		});
	});
});
