/**
 * Multi-actor coverage — cascade inheritance.
 *
 * Audit envelopes for `permit_offer_retract`, `permit_offer_decline`,
 * `permit_offer_expire`, and the in-tx `permit_offer_supersede` event
 * inherit `to_actor_id` from the offer being terminated. Decline is the
 * exception — it routes back to the grantor, so both target columns
 * carry the grantor side regardless of `to_actor_id`.
 *
 * @module
 */

import {assert, describe, test} from 'vitest';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	permit_offer_create_action_spec,
	permit_offer_decline_action_spec,
	permit_offer_retract_action_spec,
} from '$lib/auth/permit_offer_action_specs.js';
import {query_accept_offer} from '$lib/auth/permit_offer_queries.js';
import {cleanup_expired_permit_offers} from '$lib/auth/cleanup.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';

import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './permit_offer_test_helpers.js';
import {create_multi_actor_helpers} from './permit_offer.multi_actor.fixtures.js';

describe_db('permit_offer.multi_actor — cascade', (get_db) => {
	const {build_app_with_audit} = create_multi_actor_helpers(get_db);

	describe('cascade inheritance', () => {
		test('actor-targeted retract carries the actor on the audit envelope', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_actor_retract'});

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

			events.length = 0;
			const retract_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_retract_action_spec,
				params: {offer_id: create_res.result.offer.id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(retract_res.ok);

			const retract_event = events.find((e) => e.event_type === 'permit_offer_retract');
			assert.ok(retract_event);
			assert.strictEqual(retract_event.target_account_id, recipient.account.id);
			assert.strictEqual(retract_event.target_actor_id, recipient.actor.id);
		});

		test('actor-targeted decline still puts the grantor in both target columns', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_actor_decline'});

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

			events.length = 0;
			const decline_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_decline_action_spec,
				params: {offer_id: create_res.result.offer.id},
				headers: recipient.create_session_headers(),
			});
			assert.ok(decline_res.ok);

			const decline_event = events.find((e) => e.event_type === 'permit_offer_decline');
			assert.ok(decline_event);
			// Decline is *to* the offering actor — both target columns
			// carry the grantor side, regardless of `to_actor_id` semantics.
			assert.strictEqual(decline_event.target_account_id, test_app.backend.account.id);
			assert.strictEqual(decline_event.target_actor_id, test_app.backend.actor.id);
		});

		test('expired actor-targeted offer carries the actor on the permit_offer_expire envelope', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_expire'});

			// Insert an already-past actor-targeted offer directly — the
			// create helper rejects past `expires_at` indirectly through
			// the inbox sweep semantics; bypass via raw insert is the
			// existing pattern for expiry tests.
			const rows = await get_db().query<{id: Uuid}>(
				`INSERT INTO permit_offer (from_actor_id, to_account_id, to_actor_id, role, expires_at)
				 VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 minute')
				 RETURNING id`,
				[test_app.backend.actor.id, recipient.account.id, recipient.actor.id, ROLE_ADMIN],
			);
			const offer_id = rows[0]!.id;

			const captured: Array<AuditLogEvent> = [];
			const count = await cleanup_expired_permit_offers({
				db: get_db(),
				log: new Logger('test_expire', {level: 'off'}),
				on_audit_event: (event) => {
					captured.push(event);
				},
			});
			assert.ok(count >= 1);
			const expire_event = captured.find(
				(e) =>
					e.event_type === 'permit_offer_expire' &&
					(e.metadata as {offer_id?: string}).offer_id === offer_id,
			);
			assert.ok(expire_event);
			assert.strictEqual(expire_event.target_account_id, recipient.account.id);
			assert.strictEqual(expire_event.target_actor_id, recipient.actor.id);
		});

		test('supersede cascade inherits to_actor_id when the sibling was actor-targeted', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_supersede'});
			const grantor_b = await test_app.create_account({
				username: 'multi_actor_supersede_b',
				roles: [ROLE_ADMIN],
			});

			// Offer A — account-grain (no `to_actor_id`).
			const offer_a_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(offer_a_res.ok);
			// Offer B — actor-targeted at the recipient's actor; from a
			// different grantor so the partial unique index allows both
			// to coexist.
			const offer_b_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: recipient.actor.id,
					role: ROLE_ADMIN,
				},
				headers: grantor_b.create_session_headers(),
			});
			assert.ok(offer_b_res.ok);

			// Accept A — supersedes B in-tx. Audit emission is in-tx,
			// not via fire-and-forget; assert against the DB.
			const accept_result = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: offer_a_res.result.offer.id,
						to_account_id: recipient.account.id,
						actor_id: recipient.actor.id,
						ip: null,
					},
				),
			);
			assert.strictEqual(accept_result.superseded_offers.length, 1);
			const supersede_event = accept_result.audit_events.find(
				(e) => e.event_type === 'permit_offer_supersede',
			);
			assert.ok(supersede_event);
			assert.strictEqual(supersede_event.target_account_id, recipient.account.id);
			assert.strictEqual(supersede_event.target_actor_id, recipient.actor.id);
		});
	});
});
