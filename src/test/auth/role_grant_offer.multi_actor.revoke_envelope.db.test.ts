/**
 * Multi-actor coverage — `role_grant_revoke` envelope on multi-actor accounts.
 *
 * The revoke audit event must name the actor the role_grant was actually
 * granted to, not whichever actor the index returns first when scanning
 * by `account_id`. Sibling actors on the recipient account exist but
 * hold no role_grants.
 *
 * @module
 */

import {assert, describe, test} from 'vitest';

import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {role_grant_revoke_action_spec} from '$lib/auth/role_grant_offer_action_specs.js';
import {query_create_role_grant} from '$lib/auth/role_grant_queries.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';

import {RPC_PATH, describe_db} from './role_grant_offer_test_helpers.js';
import {create_multi_actor_helpers} from './role_grant_offer.multi_actor.fixtures.js';

describe_db('role_grant_offer.multi_actor — revoke_envelope', (get_db) => {
	const {build_app_with_audit, add_second_actor} = create_multi_actor_helpers(get_db);

	describe('role_grant_revoke envelope on multi-actor accounts', () => {
		test('target_actor_id names the granted actor, not whichever the index returns first', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_actor_revoke'});
			// Insert a second actor on the recipient before granting the
			// role_grant to the first one. A naive `first_actor_by_account`
			// lookup would now race between the two; the revoke audit
			// must still name the actually-bound actor.
			await add_second_actor(recipient.account.id, 'unbound_sibling');

			const role_grant = await query_create_role_grant(
				{db: get_db()},
				{
					actor_id: recipient.actor.id,
					role: ROLE_ADMIN,
					granted_by: test_app.backend.actor.id,
				},
			);

			events.length = 0;
			const revoke_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: {actor_id: recipient.actor.id, role_grant_id: role_grant.id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(revoke_res.ok);

			const revoke_event = events.find((e) => e.event_type === 'role_grant_revoke');
			assert.ok(revoke_event);
			assert.strictEqual(revoke_event.target_account_id, recipient.account.id);
			assert.strictEqual(revoke_event.target_actor_id, recipient.actor.id);
		});
	});
});
