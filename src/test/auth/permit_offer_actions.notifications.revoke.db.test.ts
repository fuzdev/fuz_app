/**
 * End-to-end notification fan-out tests for the `permit_revoke` RPC action.
 *
 * Mirrors `admin_routes.permit_notifications.db.test.ts` (now deleted along
 * with the REST grant/revoke routes) but drives everything through the
 * JSON-RPC endpoint. Asserts:
 *
 * - Single revoke fires one `permit_revoke` notification to the revokee.
 * - Revoke that supersedes pending sibling offers fires one
 *   `permit_offer_supersede` per grantor (in addition to `permit_revoke`).
 * - Revoke with no pending offers fires only `permit_revoke`.
 * - Revoking a non-web-grantable permit (keeper) fires no notifications.
 * - `reason` provided on the request rides through to the WS payload.
 *
 * @module
 */

import {test, assert} from 'vitest';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {
	create_pglite_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
} from '$lib/testing/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import {permit_revoke_action_spec} from '$lib/auth/permit_offer_actions.js';
import {
	PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	PERMIT_REVOKE_NOTIFICATION_METHOD,
} from '$lib/auth/permit_offer_notifications.js';
import {create_rpc_post_init} from '$lib/testing/rpc_helpers.js';
import type {Db} from '$lib/db/db.js';
import type {Hono} from 'hono';
import {
	NOTIFICATION_TEST_RPC_PATH,
	create_capture_sender,
	create_notification_route_specs_factory,
	type CapturedNotificationCall,
} from './notification_helpers.js';

const session_options = create_session_config('test_session');

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, AUTH_INTEGRATION_TRUNCATE_TABLES);

const RPC_PATH = NOTIFICATION_TEST_RPC_PATH;

const revoke_rpc = async (
	app: Hono,
	headers: Record<string, string>,
	params: {actor_id: string; permit_id: string; reason?: string},
): Promise<Response> => {
	const init = create_rpc_post_init(permit_revoke_action_spec.method, params, 'revoke-test');
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

describe_db('permit_revoke notifications', (get_db) => {
	test('single revoke fires permit_revoke to the revokee', async () => {
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
		const permit_rows = await db.query<{id: string}>(
			`INSERT INTO permit (actor_id, role, granted_by)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
		);
		const permit_id = permit_rows[0]!.id;

		calls.length = 0;
		const res = await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			permit_id,
		});
		assert.strictEqual(res.status, 200);

		const revokes = calls.filter((c) => c.method === PERMIT_REVOKE_NOTIFICATION_METHOD);
		assert.strictEqual(revokes.length, 1);
		assert.strictEqual(revokes[0]?.account_id, target.account.id);
		const params = revokes[0]?.params as {
			permit_id?: string;
			role?: string;
			scope_id?: string | null;
			reason?: string | null;
		};
		assert.strictEqual(params.permit_id, permit_id);
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
		const permit_rows = await db.query<{id: string}>(
			`INSERT INTO permit (actor_id, role, granted_by)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
		);

		calls.length = 0;
		await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			permit_id: permit_rows[0]!.id,
			reason: 'policy violation',
		});

		const revokes = calls.filter((c) => c.method === PERMIT_REVOKE_NOTIFICATION_METHOD);
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
		const permit_rows = await db.query<{id: string}>(
			`INSERT INTO permit (actor_id, role, granted_by)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
		);
		const permit_id = permit_rows[0]!.id;

		// Two pending offers for the same (target, ROLE_ADMIN, null scope).
		const offer_a_rows = await db.query<{id: string}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
			 VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')
			 RETURNING id`,
			[test_app.backend.actor.id, target.account.id, ROLE_ADMIN],
		);
		const offer_b_rows = await db.query<{id: string}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
			 VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')
			 RETURNING id`,
			[grantor_b.actor.id, target.account.id, ROLE_ADMIN],
		);
		const offer_a_id = offer_a_rows[0]!.id;
		const offer_b_id = offer_b_rows[0]!.id;

		calls.length = 0;
		const res = await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			permit_id,
		});
		assert.strictEqual(res.status, 200);

		const revokes = calls.filter((c) => c.method === PERMIT_REVOKE_NOTIFICATION_METHOD);
		assert.strictEqual(revokes.length, 1);
		assert.strictEqual(revokes[0]?.account_id, target.account.id);

		const supersedes = calls.filter((c) => c.method === PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD);
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
			assert.strictEqual(params.reason, 'permit_revoked');
			assert.strictEqual(params.cause_id, permit_id);
			assert.ok(
				params.offer?.id === offer_a_id || params.offer?.id === offer_b_id,
				`supersede payload should reference one of the pending offers; got ${params.offer?.id}`,
			);
		}
	});

	test('revoke with no pending offers fires only permit_revoke', async () => {
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
		const permit_rows = await db.query<{id: string}>(
			`INSERT INTO permit (actor_id, role, granted_by)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
		);

		calls.length = 0;
		await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: target.actor.id,
			permit_id: permit_rows[0]!.id,
		});
		const revokes = calls.filter((c) => c.method === PERMIT_REVOKE_NOTIFICATION_METHOD);
		const supersedes = calls.filter((c) => c.method === PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD);
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
		// bootstrap account has the keeper permit.
		const keeper_rows = await get_db().query<{id: string; actor_id: string}>(
			`SELECT id, actor_id FROM permit WHERE role = $1 AND revoked_at IS NULL LIMIT 1`,
			[ROLE_KEEPER],
		);
		const keeper_permit = keeper_rows[0]!;

		calls.length = 0;
		const res = await revoke_rpc(test_app.app, test_app.create_session_headers(), {
			actor_id: keeper_permit.actor_id,
			permit_id: keeper_permit.id,
		});
		assert.strictEqual(res.status, 403);
		assert.strictEqual(calls.length, 0);
	});
});
