/**
 * End-to-end notification fan-out tests for the `role_grant_revoke` RPC action.
 *
 * Mirrors `admin_routes.role_grant_notifications.db.test.ts` (now deleted along
 * with the REST grant/revoke routes) but drives everything through the
 * JSON-RPC endpoint. Asserts:
 *
 * - Single revoke fires one `role_grant_revoked` notification to the revokee.
 * - Revoke that supersedes pending sibling offers fires one
 *   `role_grant_offer_supersede` per grantor (in addition to `role_grant_revoked`).
 * - Revoke with no pending offers fires only `role_grant_revoked`.
 * - Revoking a non-web-grantable role_grant (keeper) fires no notifications.
 * - `reason` provided on the request rides through to the WS payload.
 * - The payload carries the grant's `scope_kind` with its `scope_id`: both
 *   `null` for a global grant, the pair for a scoped one.
 * - Under DEV a payload off its params schema (a stored `scope_kind` off the
 *   grammar) is still sent, and the mismatch is logged.
 *
 * @module
 */

import { test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_test_app } from '#lib/testing/app_server.ts';
import { TEST_ORIGIN } from '#lib/testing/test_origin.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import { role_grant_revoke_action_spec } from '#lib/auth/role_grant_offer_action_specs.ts';
import { query_create_role_grant } from '#lib/auth/role_grant_queries.ts';
import { query_role_grant_offer_create } from '#lib/auth/role_grant_offer_queries.ts';
import {
	ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	ROLE_GRANT_REVOKED_NOTIFICATION_METHOD
} from '#lib/auth/role_grant_offer_notifications.ts';
import { create_rpc_post_init } from '#lib/testing/rpc_helpers.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { create_role_grant_offer_actions } from '#lib/auth/role_grant_offer_actions.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import type { Hono } from 'hono';
import { describe_db } from '../auth_db_default.ts';
import {
	NOTIFICATION_TEST_RPC_PATH,
	create_capture_sender,
	create_notification_route_specs_factory,
	type CapturedNotificationCall
} from './notification_helpers.ts';

const session_options = create_session_config('test_session');

const RPC_PATH = NOTIFICATION_TEST_RPC_PATH;

const revoke_rpc = async (
	app: Hono,
	headers: Record<string, string>,
	params: { actor_id: string; role_grant_id: string; reason?: string }
): Promise<Response> => {
	const init = create_rpc_post_init(role_grant_revoke_action_spec.method, params, 'revoke-test');
	return app.request(RPC_PATH, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			host: 'localhost',
			origin: TEST_ORIGIN,
			...headers
		}
	});
};

describe_db('role_grant_revoke notifications', (get_db) => {
	test('single revoke fires role_grant_revoked to the revokee', async () => {
		const calls: Array<CapturedNotificationCall> = [];
		const sender = create_capture_sender(calls);
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_notification_route_specs_factory(sender),
			db: get_db(),
			roles: [ROLE_ADMIN]
		});
		const target = await test_app.create_account({ username: 'rpc_revoke_single_target' });
		const db = get_db();
		const { id: role_grant_id } = await query_create_role_grant(
			{ db },
			{ actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id }
		);

		calls.length = 0;
		const res = await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			role_grant_id
		});
		assert.strictEqual(res.status, 200);

		const revokes = calls.filter((c) => c.method === ROLE_GRANT_REVOKED_NOTIFICATION_METHOD);
		assert.strictEqual(revokes.length, 1);
		assert.strictEqual(revokes[0]?.account_id, target.account.id);
		const params = revokes[0]?.params as {
			role_grant_id?: string;
			role?: string;
			scope_kind?: string | null;
			scope_id?: string | null;
			reason?: string | null;
		};
		assert.strictEqual(params.role_grant_id, role_grant_id);
		assert.strictEqual(params.role, ROLE_ADMIN);
		assert.strictEqual(params.scope_kind, null);
		assert.strictEqual(params.scope_id, null);
		assert.strictEqual(params.reason, null);
	});

	test('a scoped revoke carries the scope_kind with the scope_id', async () => {
		const calls: Array<CapturedNotificationCall> = [];
		const sender = create_capture_sender(calls);
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_notification_route_specs_factory(sender),
			db: get_db(),
			roles: [ROLE_ADMIN]
		});
		const target = await test_app.create_account({ username: 'rpc_revoke_scoped_target' });
		const db = get_db();
		const scope_id = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as Uuid;
		// a scoped row written by the query, which no grant path refuses
		const { id: role_grant_id } = await query_create_role_grant(
			{ db },
			{
				actor_id: target.actor.id,
				role: ROLE_ADMIN,
				scope_kind: 'classroom',
				scope_id,
				granted_by: test_app.backend.actor.id
			}
		);

		calls.length = 0;
		const res = await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			role_grant_id
		});
		assert.strictEqual(res.status, 200);

		const revokes = calls.filter((c) => c.method === ROLE_GRANT_REVOKED_NOTIFICATION_METHOD);
		assert.strictEqual(revokes.length, 1);
		assert.deepStrictEqual(revokes[0]?.params, {
			role_grant_id,
			role: ROLE_ADMIN,
			scope_kind: 'classroom',
			scope_id,
			reason: null
		});
	});

	test('under DEV a payload off its params schema is sent and logged', async () => {
		const calls: Array<CapturedNotificationCall> = [];
		const sender = create_capture_sender(calls);
		const errors: Array<Array<unknown>> = [];
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args);
		};
		const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
			create_rpc_endpoint({
				action_ip_rate_limiter: null,
				action_account_rate_limiter: null,
				path: RPC_PATH,
				actions: create_role_grant_offer_actions({ ...ctx.deps, log, notification_sender: sender }),
				log: ctx.deps.log
			});
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
			roles: [ROLE_ADMIN]
		});
		const target = await test_app.create_account({ username: 'rpc_revoke_off_schema_target' });
		const db = get_db();
		// the index-side token, off the `ScopeKindName` grammar: no grant input
		// takes it, but a row written by other means can hold it
		const { id: role_grant_id } = await query_create_role_grant(
			{ db },
			{
				actor_id: target.actor.id,
				role: ROLE_ADMIN,
				scope_kind: 'GLOBAL',
				scope_id: '00000000-0000-0000-0000-000000000000' as Uuid,
				granted_by: test_app.backend.actor.id
			}
		);

		calls.length = 0;
		const res = await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			role_grant_id
		});
		assert.strictEqual(res.status, 200);

		const revokes = calls.filter((c) => c.method === ROLE_GRANT_REVOKED_NOTIFICATION_METHOD);
		assert.strictEqual(revokes.length, 1);
		assert.strictEqual((revokes[0]?.params as { scope_kind?: unknown }).scope_kind, 'GLOBAL');
		assert.deepStrictEqual(
			errors.map(([message]) => message),
			[`notification params schema mismatch: ${ROLE_GRANT_REVOKED_NOTIFICATION_METHOD}`]
		);
	});

	test('reason on the request rides through to the WS payload', async () => {
		const calls: Array<CapturedNotificationCall> = [];
		const sender = create_capture_sender(calls);
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_notification_route_specs_factory(sender),
			db: get_db(),
			roles: [ROLE_ADMIN]
		});
		const target = await test_app.create_account({ username: 'rpc_revoke_reason_target' });
		const db = get_db();
		const role_grant = await query_create_role_grant(
			{ db },
			{ actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id }
		);

		calls.length = 0;
		await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			role_grant_id: role_grant.id,
			reason: 'policy violation'
		});

		const revokes = calls.filter((c) => c.method === ROLE_GRANT_REVOKED_NOTIFICATION_METHOD);
		assert.strictEqual(revokes.length, 1);
		const params = revokes[0]?.params as { reason?: string | null };
		assert.strictEqual(params.reason, 'policy violation');
	});

	test('revoke supersedes pending offers and notifies each grantor', async () => {
		const calls: Array<CapturedNotificationCall> = [];
		const sender = create_capture_sender(calls);
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_notification_route_specs_factory(sender),
			db: get_db(),
			roles: [ROLE_ADMIN]
		});
		const grantor_b = await test_app.create_account({
			username: 'rpc_revoke_grantor_b',
			roles: [ROLE_ADMIN]
		});
		const target = await test_app.create_account({ username: 'rpc_revoke_supersede_target' });
		const db = get_db();
		const { id: role_grant_id } = await query_create_role_grant(
			{ db },
			{ actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id }
		);

		// Two pending offers for the same (target, ROLE_ADMIN, null scope).
		const expires_at = new Date(Date.now() + 60 * 60 * 1000);
		const { id: offer_a_id } = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: test_app.backend.actor.id,
				to_account_id: target.account.id,
				role: ROLE_ADMIN,
				expires_at
			}
		);
		const { id: offer_b_id } = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: grantor_b.actor.id,
				to_account_id: target.account.id,
				role: ROLE_ADMIN,
				expires_at
			}
		);

		calls.length = 0;
		const res = await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			role_grant_id
		});
		assert.strictEqual(res.status, 200);

		const revokes = calls.filter((c) => c.method === ROLE_GRANT_REVOKED_NOTIFICATION_METHOD);
		assert.strictEqual(revokes.length, 1);
		assert.strictEqual(revokes[0]?.account_id, target.account.id);

		const supersedes = calls.filter(
			(c) => c.method === ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD
		);
		assert.strictEqual(supersedes.length, 2);

		const supersede_targets = new Set(supersedes.map((c) => c.account_id));
		assert.ok(supersede_targets.has(test_app.backend.account.id));
		assert.ok(supersede_targets.has(grantor_b.account.id));

		for (const call of supersedes) {
			const params = call.params as {
				offer?: { id?: string };
				reason?: string;
				cause_id?: string;
			};
			assert.strictEqual(params.reason, 'role_grant_revoked');
			assert.strictEqual(params.cause_id, role_grant_id);
			assert.ok(
				params.offer?.id === offer_a_id || params.offer?.id === offer_b_id,
				`supersede payload should reference one of the pending offers; got ${params.offer?.id}`
			);
		}
	});

	test('revoke with no pending offers fires only role_grant_revoked', async () => {
		const calls: Array<CapturedNotificationCall> = [];
		const sender = create_capture_sender(calls);
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_notification_route_specs_factory(sender),
			db: get_db(),
			roles: [ROLE_ADMIN]
		});
		const target = await test_app.create_account({ username: 'rpc_revoke_no_offers_target' });
		const db = get_db();
		const role_grant = await query_create_role_grant(
			{ db },
			{ actor_id: target.actor.id, role: ROLE_ADMIN, granted_by: test_app.backend.actor.id }
		);

		calls.length = 0;
		await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			role_grant_id: role_grant.id
		});
		const revokes = calls.filter((c) => c.method === ROLE_GRANT_REVOKED_NOTIFICATION_METHOD);
		const supersedes = calls.filter(
			(c) => c.method === ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD
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
			roles: [ROLE_KEEPER, ROLE_ADMIN]
		});
		// bootstrap account has the keeper role_grant.
		const keeper_rows = await get_db().query<{ id: string; actor_id: string }>(
			`SELECT id, actor_id FROM role_grant WHERE role = $1 AND revoked_at IS NULL LIMIT 1`,
			[ROLE_KEEPER]
		);
		const keeper_role_grant = keeper_rows[0]!;

		calls.length = 0;
		const res = await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: keeper_role_grant.actor_id,
			role_grant_id: keeper_role_grant.id
		});
		assert.strictEqual(res.status, 403);
		assert.strictEqual(calls.length, 0);
	});
});
