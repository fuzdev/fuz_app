/**
 * Multi-actor coverage — account-grain offers (`to_actor_id` null).
 *
 * Any actor on the recipient account may accept; the audit envelope
 * leaves `target_actor_id` null on the offer-shape events because the
 * offer itself is not yet bound to a specific actor.
 *
 * @module
 */

import {assert, describe, test} from 'vitest';

import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {permit_offer_create_action_spec} from '$lib/auth/permit_offer_action_specs.js';
import {query_accept_offer} from '$lib/auth/permit_offer_queries.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';

import {RPC_PATH, describe_db} from './permit_offer_test_helpers.js';
import {create_multi_actor_helpers} from './permit_offer.multi_actor.fixtures.js';

describe_db('permit_offer.multi_actor — account_grain', (get_db) => {
	const {build_app_with_audit, add_second_actor} = create_multi_actor_helpers(get_db);

	describe('account-grain offers (`to_actor_id` null)', () => {
		test('any actor on the recipient account may accept', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_acct_recipient'});
			const second_actor_id = await add_second_actor(recipient.account.id, 'second');

			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			assert.strictEqual(create_res.result.offer.to_actor_id, null);

			// Direct query call exercises the `to_actor_id IS NULL` branch
			// where any actor on `to_account_id` may accept.
			const accepted = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: create_res.result.offer.id,
						to_account_id: recipient.account.id,
						actor_id: second_actor_id,
						ip: null,
					},
				),
			);
			assert.strictEqual(accepted.permit.actor_id, second_actor_id);
		});

		test('audit envelope leaves target_actor_id null on offer-shape events', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_acct_envelope'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
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
			assert.strictEqual(create_event.target_actor_id, null);
		});
	});
});
