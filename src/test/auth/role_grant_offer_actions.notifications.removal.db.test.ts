/**
 * The `role_grant_offer_supersede` notifications an account removal sends —
 * `account_delete` (by an admin, and of one's own account) and
 * `account_purge`.
 *
 * A removal supersedes the account's pending offers both ways
 * (`reason: 'account_deleted'`), and each offer's other party is told: the
 * recipient of an offer the account made, sent its grantor's actor as
 * `cause_id` (an id it already holds — never the account id), and the grantor
 * of one made to it, sent the removed account. The removed account hears none
 * of it — its connections close with it. Sent after the commit, in the order of the
 * audit rows: the outgoing offers, then the incoming ones.
 *
 * @module
 */

import { test, assert } from 'vitest';

import { create_test_app } from '#lib/testing/test_app.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import {
	account_delete_action_spec,
	account_purge_action_spec
} from '#lib/auth/admin_action_specs.ts';
import { query_role_grant_offer_create } from '#lib/auth/role_grant_offer_queries.ts';
import { rpc_call_for_spec } from '#lib/testing/rpc_helpers.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { describe_db } from '../auth_db_default.ts';
import {
	NOTIFICATION_TEST_RPC_PATH,
	create_capture_sender,
	create_notification_app_options,
	to_captured_supersedes,
	type CapturedNotificationCall
} from './notification_helpers.ts';

const session_cookie_name = 'test_session';

const REMOVALS = ['admin delete', 'self delete', 'purge'] as const;

describe_db('account removal supersede notifications', (get_db) => {
	install_audit_drift_guard();

	for (const removal of REMOVALS) {
		test(`${removal} tells each offer's other party, and the removed account nothing`, async () => {
			const calls: Array<CapturedNotificationCall> = [];
			const test_app = await create_test_app({
				session_cookie_name,
				...create_notification_app_options(create_capture_sender(calls)),
				db: get_db()
			});
			const db = get_db();
			const removed = await test_app.create_account({ username: 'removal_removed' });
			const recipient = await test_app.create_account({ username: 'removal_recipient' });
			const grantor = await test_app.create_account({ username: 'removal_grantor' });
			const bystander = await test_app.create_account({ username: 'removal_bystander' });
			const offer = async (from: Uuid, to: Uuid): Promise<Uuid> =>
				(
					await query_role_grant_offer_create(
						{ db },
						{
							from_actor_id: from,
							to_account_id: to,
							role: ROLE_ADMIN,
							expires_at: new Date(Date.now() + 60 * 60 * 1000)
						}
					)
				).id;
			const outgoing = await offer(removed.actor.id, recipient.account.id);
			const incoming = await offer(grantor.actor.id, removed.account.id);
			// a party to neither offer: its own offer stays pending, unannounced
			await offer(grantor.actor.id, bystander.account.id);

			calls.length = 0;
			const purge = removal === 'purge';
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: NOTIFICATION_TEST_RPC_PATH,
				spec: purge ? account_purge_action_spec : account_delete_action_spec,
				params: purge
					? { account_id: removed.account.id, confirm: true as const }
					: removal === 'self delete'
						? {}
						: { account_id: removed.account.id },
				// purge is daemon-token gated, sent without the default `origin`
				suppress_default_origin: purge,
				headers: purge
					? test_app.create_daemon_token_headers()
					: removal === 'self delete'
						? removed.create_session_headers()
						: test_app.create_session_headers()
			});
			assert.ok(res.ok, `${removal}: ${JSON.stringify(res)}`);

			assert.deepStrictEqual(to_captured_supersedes(calls), [
				{
					account_id: recipient.account.id,
					offer_id: outgoing,
					reason: 'account_deleted',
					cause_id: removed.actor.id
				},
				{
					account_id: grantor.account.id,
					offer_id: incoming,
					reason: 'account_deleted',
					cause_id: removed.account.id
				}
			]);
			assert.deepStrictEqual(
				calls.filter((c) => c.account_id === removed.account.id),
				[],
				'the removed account is sent nothing'
			);
		});
	}
});
