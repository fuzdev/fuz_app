/**
 * `account_delete` / `account_purge` end the pending offers the removed
 * account's actors made.
 *
 * An offer records no authority, so one outliving its grantor's account would
 * still confer its role on accept. Soft delete supersedes them; purge
 * supersedes them before its cascade deletes the rows — each with a
 * `role_grant_offer_supersede` audit row (`reason: 'account_deleted'`,
 * `cause_id`: the account). Twin of the Rust
 * `account_removal_supersedes_the_accounts_outgoing_offers` (`fuz_auth`).
 *
 * @module
 */

import { test, assert } from 'vitest';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import {
	account_delete_action_spec,
	account_purge_action_spec
} from '#lib/auth/admin_action_specs.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { auth_migration_ns } from '#lib/auth/migrations.ts';
import { create_test_app } from '#lib/testing/app_server.ts';
import {
	create_default_db_factory,
	create_describe_db,
	auth_integration_truncate_tables
} from '#lib/testing/db.ts';
import { run_migrations } from '#lib/db/migrate.ts';
import { rpc_call_for_spec } from '#lib/testing/rpc_helpers.ts';
import { create_test_extra_actor } from '#lib/testing/db_entities.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { query_role_grant_offer_create } from '#lib/auth/role_grant_offer_queries.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import type { AuditLogEvent } from '#lib/auth/audit_log_schema.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const factory = create_default_db_factory(async (db) => {
	await run_migrations(db, [auth_migration_ns]);
});
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_rpc_endpoint({
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: create_standard_rpc_actions(ctx.deps),
		log: ctx.deps.log
	});

describe_db('account removal ends outgoing offers', (get_db) => {
	install_audit_drift_guard();

	test('delete and purge supersede every pending offer the account made, audited', async () => {
		const events: Array<AuditLogEvent> = [];
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
			// the keeper deletes and purges
			roles: [ROLE_KEEPER, ROLE_ADMIN],
			audit_factory: (params) =>
				create_audit_emitter({
					...params,
					on_audit_event: (event) => {
						events.push(event);
					}
				})
		});
		const db = get_db();
		const recipient = await test_app.create_account({ username: 'outgoing_recipient' });
		const bystander = await test_app.create_account({ username: 'outgoing_bystander' });
		const offer = (from: Uuid, to: Uuid) =>
			query_role_grant_offer_create(
				{ db },
				{
					from_actor_id: from,
					to_account_id: to,
					role: ROLE_ADMIN,
					expires_at: new Date(Date.now() + 60 * 60 * 1000)
				}
			);
		const control = await offer(bystander.actor.id, recipient.account.id);

		for (const spec of [account_delete_action_spec, account_purge_action_spec]) {
			const grantor = await test_app.create_account({ username: `grantor_${spec.method}` });
			const second_actor = await create_test_extra_actor(db, grantor.account.id, 'persona');
			const offers = [
				await offer(grantor.actor.id, recipient.account.id),
				await offer(second_actor.id, bystander.account.id)
			];
			const params =
				spec === account_purge_action_spec
					? { account_id: grantor.account.id, confirm: true as const }
					: { account_id: grantor.account.id };
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

			for (const o of offers) {
				const rows = events.filter(
					(e) =>
						e.event_type === 'role_grant_offer_supersede' &&
						(e.metadata as { offer_id?: string }).offer_id === o.id
				);
				assert.strictEqual(rows.length, 1, `${spec.method}: one supersede row`);
				assert.include(
					rows[0]!.metadata,
					{ reason: 'account_deleted', cause_id: grantor.account.id },
					spec.method
				);
				const row = await db.query_one<{ superseded: boolean }>(
					`SELECT superseded_at IS NOT NULL AS superseded FROM role_grant_offer WHERE id = $1`,
					[o.id]
				);
				if (spec === account_purge_action_spec) {
					assert.strictEqual(row, undefined, 'the purge cascade removed the offer');
				} else {
					assert.isTrue(row?.superseded, 'the soft delete superseded the offer');
				}
			}
		}

		const control_row = await db.query_one<{ superseded_at: string | null }>(
			`SELECT superseded_at FROM role_grant_offer WHERE id = $1`,
			[control.id]
		);
		assert.strictEqual(control_row?.superseded_at, null, "another grantor's offer stays pending");
	});
});
