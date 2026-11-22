/**
 * `account_delete` / `account_purge` delete the unclaimed invites the removed
 * account's actors issued.
 *
 * An invite records no authority, so one outliving its issuer's account would
 * still admit a signup. Soft delete deletes them; purge deletes them before its
 * cascade, which would otherwise null `invite.created_by` and leave them
 * usable — each with an `invite_delete` audit row. A claimed invite is kept.
 * Twin of the Rust `account_removal_deletes_the_accounts_unclaimed_invites`
 * (`fuz_auth`).
 *
 * @module
 */

import { test, assert } from 'vitest';

import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import {
	account_delete_action_spec,
	account_purge_action_spec
} from '#lib/auth/admin_action_specs.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { create_test_app } from '#lib/testing/test_app.ts';
import { rpc_call_for_spec } from '#lib/testing/rpc_helpers.ts';
import { create_test_extra_actor } from '#lib/testing/db_entities.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { query_create_invite, query_invite_claim_unscoped } from '#lib/auth/invite_queries.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import type { AuditLogEvent } from '#lib/auth/audit_log_schema.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';

import { describe_db } from '../auth_db_default.ts';

const session_cookie_name = 'test_session';
const RPC_PATH = '/api/rpc';

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_rpc_endpoint({
		notification_sender: ctx.deps.notification_sender,
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: create_standard_rpc_actions(ctx.deps),
		log: ctx.deps.log
	});

describe_db('account removal deletes unclaimed invites', (get_db) => {
	install_audit_drift_guard();

	test('delete and purge delete every unclaimed invite the account issued, audited; a claimed one stays', async () => {
		const events: Array<AuditLogEvent> = [];
		const test_app = await create_test_app({
			session_cookie_name,
			create_route_specs,
			db: get_db(),
			audit_factory: (params) =>
				create_audit_emitter({
					...params,
					on_audit_event: (event) => {
						events.push(event);
					}
				})
		});
		const db = get_db();
		const bystander = await test_app.create_account({ username: 'invites_bystander' });
		const control = await query_create_invite(
			{ db },
			{ username: 'invitee_control', created_by: bystander.actor.id }
		);
		const exists = async (id: string): Promise<boolean> =>
			(await db.query_one(`SELECT id FROM invite WHERE id = $1`, [id])) !== undefined;

		for (const spec of [account_delete_action_spec, account_purge_action_spec]) {
			const issuer = await test_app.create_account({ username: `issuer_${spec.method}` });
			const second_actor = await create_test_extra_actor(db, issuer.account.id, 'persona');
			const unclaimed = [
				await query_create_invite(
					{ db },
					{ username: `invitee_a_${spec.method}`, created_by: issuer.actor.id }
				),
				await query_create_invite(
					{ db },
					{ username: `invitee_b_${spec.method}`, created_by: second_actor.id }
				)
			];
			const claimed = await query_create_invite(
				{ db },
				{ username: `invitee_c_${spec.method}`, created_by: issuer.actor.id }
			);
			await query_invite_claim_unscoped({ db }, claimed.id, bystander.account.id);

			const params =
				spec === account_purge_action_spec
					? { account_id: issuer.account.id, confirm: true as const }
					: { account_id: issuer.account.id };
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec,
				params,
				// purge is daemon-token gated, sent without the default `origin`
				// (a browser context discards the daemon token)
				suppress_default_origin: spec === account_purge_action_spec,
				headers:
					spec === account_purge_action_spec
						? test_app.create_daemon_token_headers()
						: test_app.create_session_headers()
			});
			assert.ok(res.ok, `${spec.method}: ${JSON.stringify(res)}`);

			for (const invite of unclaimed) {
				assert.isFalse(await exists(invite.id), `${spec.method}: the unclaimed invite is deleted`);
				const rows = events.filter(
					(e) =>
						e.event_type === 'invite_delete' &&
						(e.metadata as { invite_id?: string }).invite_id === invite.id
				);
				assert.strictEqual(rows.length, 1, `${spec.method}: one invite_delete row`);
				// the remover's row, as an `invite_delete` call writes it
				assert.strictEqual(
					rows[0]!.actor_id,
					test_app.backend.actor.id,
					`${spec.method}: actor_id`
				);
				assert.strictEqual(
					rows[0]!.account_id,
					test_app.backend.account.id,
					`${spec.method}: account_id`
				);
			}
			assert.isTrue(await exists(claimed.id), `${spec.method}: the claimed invite stays`);
		}

		assert.isTrue(await exists(control.id), "another account's invite stays");
	});
});
