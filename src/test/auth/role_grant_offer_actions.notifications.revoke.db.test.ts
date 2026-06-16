/**
 * End-to-end notification fan-out tests for the `role_grant_revoke` RPC action.
 *
 * Mirrors `admin_routes.role_grant_notifications.db.test.ts` (now deleted along
 * with the REST grant/revoke routes) but drives everything through the
 * JSON-RPC endpoint. Asserts:
 *
 * - Single revoke fires one `role_grant_revoke` notification to the revokee.
 * - Revoke that supersedes pending sibling offers fires one
 *   `role_grant_offer_supersede` per grantor (in addition to `role_grant_revoke`).
 * - Revoke with no pending offers fires only `role_grant_revoke`.
 * - Revoking a non-web-grantable role_grant (keeper) fires no notifications.
 * - `reason` provided on the request rides through to the WS payload.
 *
 * @module
 */

import {test, assert} from 'vitest';

import {create_session_config} from '$lib/auth/session_cookie.ts';
import {create_test_app} from '$lib/testing/app_server.ts';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables,
} from '$lib/testing/db.ts';
import {run_migrations} from '$lib/db/migrate.ts';
import {auth_migration_ns} from '$lib/auth/migrations.ts';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.ts';
import {role_grant_revoke_action_spec} from '$lib/auth/role_grant_offer_action_specs.ts';
import {query_create_role_grant} from '$lib/auth/role_grant_queries.ts';
import {query_role_grant_offer_create} from '$lib/auth/role_grant_offer_queries.ts';
import {
	ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	ROLE_GRANT_REVOKE_NOTIFICATION_METHOD,
} from '$lib/auth/role_grant_offer_notifications.ts';
import {create_rpc_post_init} from '$lib/testing/rpc_helpers.ts';
import type {Db} from '$lib/db/db.ts';
import type {Hono} from 'hono';
import {
	NOTIFICATION_TEST_RPC_PATH,
	create_capture_sender,
	create_notification_route_specs_factory,
	type CapturedNotificationCall,
} from './notification_helpers.ts';

const session_options = create_session_config('test_session');

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

const RPC_PATH = NOTIFICATION_TEST_RPC_PATH;

const revoke_rpc = async (
	app: Hono,
	headers: Record<string, string>,
	params: {actor_id: string; role_grant_id: string; reason?: string},
): Promise<Response> => {
	const init = create_rpc_post_init(role_grant_revoke_action_spec.method, params, 'revoke-test');
	return app.request(RPC_PATH, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			host: 'localhost',
			origin: 'http://localhost:5173',
			...headers,
		},
	});
};

describe_db('role_grant_revoke notifications', (get_db) => {
	test('single revoke fires role_grant_revoke to the revokee', async () => {
		const calls: Array<CapturedNotificationCall> = [];
		const sender = create_capture_sender(calls);
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_notification_route_specs_factory(sender),
			db: get_db(),
			roles: [ROLE_ADMIN],
		});
		const target = await test_app.create_account({username: 'rpc_revoke_single_target'});
		const db = get_db();
		const {id: role_grant_id} = await query_create_role_grant(
			{db},
			{actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id},
		);

		calls.length = 0;
		const res = await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			role_grant_id,
		});
		assert.strictEqual(res.status, 200);

		const revokes = calls.filter((c) => c.method === ROLE_GRANT_REVOKE_NOTIFICATION_METHOD);
		assert.strictEqual(revokes.length, 1);
		assert.strictEqual(revokes[0]?.account_id, target.account.id);
		const params = revokes[0]?.params as {
			role_grant_id?: string;
			role?: string;
			scope_id?: string | null;
			reason?: string | null;
		};
		assert.strictEqual(params.role_grant_id, role_grant_id);
		assert.strictEqual(params.role, ROLE_ADMIN);
		assert.strictEqual(params.scope_id, null);
		assert.strictEqual(params.reason, null);
	});

	test('reason on the request rides through to the WS payload', async () => {
		const calls: Array<CapturedNotificationCall> = [];
		const sender = create_capture_sender(calls);
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_notification_route_specs_factory(sender),
			db: get_db(),
			roles: [ROLE_ADMIN],
		});
		const target = await test_app.create_account({username: 'rpc_revoke_reason_target'});
		const db = get_db();
		const role_grant = await query_create_role_grant(
			{db},
			{actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id},
		);

		calls.length = 0;
		await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			role_grant_id: role_grant.id,
			reason: 'policy violation',
		});

		const revokes = calls.filter((c) => c.method === ROLE_GRANT_REVOKE_NOTIFICATION_METHOD);
		assert.strictEqual(revokes.length, 1);
		const params = revokes[0]?.params as {reason?: string | null};
		assert.strictEqual(params.reason, 'policy violation');
	});

	test('revoke supersedes pending offers and notifies each grantor', async () => {
		const calls: Array<CapturedNotificationCall> = [];
		const sender = create_capture_sender(calls);
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_notification_route_specs_factory(sender),
			db: get_db(),
			roles: [ROLE_ADMIN],
		});
		const grantor_b = await test_app.create_account({
			username: 'rpc_revoke_grantor_b',
			roles: [ROLE_ADMIN],
		});
		const target = await test_app.create_account({username: 'rpc_revoke_supersede_target'});
		const db = get_db();
		const {id: role_grant_id} = await query_create_role_grant(
			{db},
			{actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id},
		);

		// Two pending offers for the same (target, ROLE_ADMIN, null scope).
		const expires_at = new Date(Date.now() + 60 * 60 * 1000);
		const {id: offer_a_id} = await query_role_grant_offer_create(
			{db},
			{
				from_actor_id: test_app.backend.actor.id,
				to_account_id: target.account.id,
				role: ROLE_ADMIN,
				expires_at,
			},
		);
		const {id: offer_b_id} = await query_role_grant_offer_create(
			{db},
			{
				from_actor_id: grantor_b.actor.id,
				to_account_id: target.account.id,
				role: ROLE_ADMIN,
				expires_at,
			},
		);

		calls.length = 0;
		const res = await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			role_grant_id,
		});
		assert.strictEqual(res.status, 200);

		const revokes = calls.filter((c) => c.method === ROLE_GRANT_REVOKE_NOTIFICATION_METHOD);
		assert.strictEqual(revokes.length, 1);
		assert.strictEqual(revokes[0]?.account_id, target.account.id);

		const supersedes = calls.filter(
			(c) => c.method === ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
		);
		assert.strictEqual(supersedes.length, 2);

		const supersede_targets = new Set(supersedes.map((c) => c.account_id));
		assert.ok(supersede_targets.has(test_app.backend.account.id));
		assert.ok(supersede_targets.has(grantor_b.account.id));

		for (const call of supersedes) {
			const params = call.params as {
				offer?: {id?: string};
				reason?: string;
				cause_id?: string;
			};
			assert.strictEqual(params.reason, 'role_grant_revoked');
			assert.strictEqual(params.cause_id, role_grant_id);
			assert.ok(
				params.offer?.id === offer_a_id || params.offer?.id === offer_b_id,
				`supersede payload should reference one of the pending offers; got ${params.offer?.id}`,
			);
		}
	});

	test('revoke with no pending offers fires only role_grant_revoke', async () => {
		const calls: Array<CapturedNotificationCall> = [];
		const sender = create_capture_sender(calls);
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_notification_route_specs_factory(sender),
			db: get_db(),
			roles: [ROLE_ADMIN],
		});
		const target = await test_app.create_account({username: 'rpc_revoke_no_offers_target'});
		const db = get_db();
		const role_grant = await query_create_role_grant(
			{db},
			{actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id},
		);

		calls.length = 0;
		await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			role_grant_id: role_grant.id,
		});
		const revokes = calls.filter((c) => c.method === ROLE_GRANT_REVOKE_NOTIFICATION_METHOD);
		const supersedes = calls.filter(
			(c) => c.method === ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
		);
		assert.strictEqual(revokes.length, 1);
		assert.strictEqual(supersedes.length, 0);
	});

	test('failed revoke (non-web-grantable keeper) fires no notifications', async () => {
		const calls: Array<CapturedNotificationCall> = [];
		const sender = create_capture_sender(calls);
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_notification_route_specs_factory(sender),
			db: get_db(),
			roles: [ROLE_KEEPER, ROLE_ADMIN],
		});
		// bootstrap account has the keeper role_grant.
		const keeper_rows = await get_db().query<{id: string; actor_id: string}>(
			`SELECT id, actor_id FROM role_grant WHERE role = $1 AND revoked_at IS NULL LIMIT 1`,
			[ROLE_KEEPER],
		);
		const keeper_role_grant = keeper_rows[0]!;

		calls.length = 0;
		const res = await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: keeper_role_grant.actor_id,
			role_grant_id: keeper_role_grant.id,
		});
		assert.strictEqual(res.status, 403);
		assert.strictEqual(calls.length, 0);
	});
});
