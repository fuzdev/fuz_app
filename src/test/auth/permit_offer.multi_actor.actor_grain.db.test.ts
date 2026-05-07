/**
 * Multi-actor coverage — actor-grain offers (`to_actor_id` set).
 *
 * Only the named actor may accept; sibling actors on the same account
 * reject with `permit_offer_actor_mismatch`. Offers targeted at an
 * actor that doesn't belong to `to_account_id` reject up-front with
 * `offer_actor_account_mismatch`. Self-target check still fires when
 * the grantor's account has multiple actors.
 *
 * @module
 */

import {assert, describe, test} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	permit_offer_create_action_spec,
	permit_offer_accept_action_spec,
	ERROR_OFFER_ACTOR_ACCOUNT_MISMATCH,
	ERROR_OFFER_ACTOR_MISMATCH,
} from '$lib/auth/permit_offer_action_specs.js';
import {
	query_accept_offer,
	query_permit_offer_create,
	PermitOfferActorAccountMismatchError,
	PermitOfferActorMismatchError,
} from '$lib/auth/permit_offer_queries.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';

import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './permit_offer_test_helpers.js';
import {create_multi_actor_helpers} from './permit_offer.multi_actor.fixtures.js';

describe_db('permit_offer.multi_actor — actor_grain', (get_db) => {
	const {build_app_with_audit, add_second_actor} = create_multi_actor_helpers(get_db);

	describe('actor-grain offers (`to_actor_id` set)', () => {
		test('only the named actor may accept; wrong-actor rejects with permit_offer_actor_mismatch', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_target'});
			const second_actor_id = await add_second_actor(recipient.account.id, 'second');

			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: recipient.actor.id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			assert.strictEqual(create_res.result.offer.to_actor_id, recipient.actor.id);

			// Wrong actor (sibling on the same account) — must reject.
			const wrong_err = await assert_rejects(() =>
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
			assert.ok(wrong_err instanceof PermitOfferActorMismatchError);

			// Correct actor — succeeds.
			const accepted = await get_db().transaction(async (tx) =>
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
			assert.strictEqual(accepted.permit.actor_id, recipient.actor.id);
		});

		test('action-level accept succeeds when the caller passes acting: actor_b', async () => {
			// Sessions are account-grain (no actor binding); the per-request
			// `acting` field on the RPC params is what picks the acting actor.
			// With the dispatcher wired, the same recipient session can pass
			// `acting: actor_a` (rejected — wrong actor) or `acting: actor_b`
			// (accepted). Single account, two actors, one session.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_b_session'});
			const second_actor_id = await add_second_actor(recipient.account.id, 'recipient_b');

			// Offer targeted at actor B.
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: second_actor_id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);

			// Recipient passes `acting: recipient.actor.id` (the wrong actor —
			// the offer is targeted at actor B). Rejected with the action-level
			// wrong-actor reason.
			const wrong_actor_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id: create_res.result.offer.id, acting: recipient.actor.id},
				headers: recipient.create_session_headers(),
			});
			assert.ok(!wrong_actor_res.ok);
			assert.strictEqual(wrong_actor_res.status, 403);
			assert.strictEqual(
				(wrong_actor_res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_ACTOR_MISMATCH,
			);

			// Recipient passes `acting: actor_b` and retries — succeeds.
			const accept_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id: create_res.result.offer.id, acting: second_actor_id},
				headers: recipient.create_session_headers(),
			});
			assert.ok(accept_res.ok);
			assert.strictEqual(accept_res.result.offer.to_actor_id, second_actor_id);
		});

		test('action-level wrong-actor accept maps PermitOfferActorMismatchError to ERROR_OFFER_ACTOR_MISMATCH', async () => {
			// Single account, two actors. The offer is targeted at the second
			// actor; the recipient passes `acting: recipient.actor.id` (the
			// first actor on the account — the wrong actor for this offer).
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_action_wrong'});
			const second_actor_id = await add_second_actor(recipient.account.id, 'second_wrong');

			// Offer targeted at the second actor.
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: second_actor_id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);

			const accept_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id: create_res.result.offer.id, acting: recipient.actor.id},
				headers: recipient.create_session_headers(),
			});
			assert.ok(!accept_res.ok);
			assert.strictEqual(accept_res.status, 403);
			assert.strictEqual(
				(accept_res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_ACTOR_MISMATCH,
			);
		});

		test('create envelope carries the target actor on actor-grain offers', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_actor_envelope'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: recipient.actor.id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);
			const create_event = events.find(
				(e) =>
					e.event_type === 'permit_offer_create' &&
					(e.metadata as {offer_id?: string}).offer_id === res.result.offer.id,
			);
			assert.ok(create_event);
			assert.strictEqual(create_event.target_account_id, recipient.account.id);
			assert.strictEqual(create_event.target_actor_id, recipient.actor.id);
		});

		test('to_actor_id from a different account rejects with offer_actor_account_mismatch', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_xacct_recipient'});
			const stranger = await test_app.create_account({username: 'multi_actor_xacct_stranger'});

			// Direct query: throws.
			const err = await assert_rejects(() =>
				query_permit_offer_create(
					{db: get_db()},
					{
						from_actor_id: test_app.backend.actor.id,
						to_account_id: recipient.account.id,
						to_actor_id: stranger.actor.id,
						role: ROLE_ADMIN,
						expires_at: new Date(Date.now() + 60 * 60 * 1000),
					},
				),
			);
			assert.ok(err instanceof PermitOfferActorAccountMismatchError);

			// Action-level: maps to invalid_params with the new reason.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: stranger.actor.id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_ACTOR_ACCOUNT_MISMATCH,
			);
		});

		test('grantor-side self-target check still fires across multiple grantor actors', async () => {
			// Two actors on the grantor's account: the self-target check
			// resolves the offering actor's account, not the recipient's.
			// Adding a sibling actor on the grantor must not unblock a
			// self-targeted offer when the grantor picks a specific actor
			// via `acting`.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await add_second_actor(test_app.backend.account.id, 'admin_second');

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: test_app.backend.account.id,
					role: ROLE_ADMIN,
					acting: test_app.backend.actor.id,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
		});
	});
});
