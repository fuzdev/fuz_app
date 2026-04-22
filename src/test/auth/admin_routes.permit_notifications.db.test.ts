/**
 * End-to-end tests for the WS notification send sites in the admin
 * permit-revoke handler. Injects a capturing `NotificationSender` into
 * `create_admin_account_route_specs` and asserts that a successful revoke
 * fires a `permit_revoke` notification to the revokee's sockets plus one
 * `permit_offer_supersede` per pending offer that was superseded by the
 * revoke.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

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
import {create_admin_account_route_specs} from '$lib/auth/admin_routes.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import {
	PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	PERMIT_REVOKE_NOTIFICATION_METHOD,
	type NotificationSender,
} from '$lib/auth/permit_offer_notifications.js';
import type {Db} from '$lib/db/db.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {Uuid} from '$lib/uuid.js';
import type {JsonrpcNotification} from '$lib/http/jsonrpc.js';

const session_options = create_session_config('test_session');

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, AUTH_INTEGRATION_TRUNCATE_TABLES);

interface CapturedCall {
	account_id: string;
	method: string;
	params: unknown;
}

const create_capture_sender = (calls: Array<CapturedCall>): NotificationSender => ({
	send_to_account: (account_id: Uuid, message: JsonrpcNotification): number => {
		calls.push({account_id: account_id as string, method: message.method, params: message.params});
		return 1;
	},
});

const route_specs_factory = (sender: NotificationSender) => (ctx: AppServerContext) =>
	prefix_route_specs('/api/admin', [
		...create_admin_account_route_specs({...ctx.deps, notification_sender: sender}),
	]) satisfies Array<RouteSpec>;

describe_db('admin permit revoke notifications', (get_db) => {
	describe('permit_revoke fan-out', () => {
		test('single revoke fires permit_revoke to the revokee', async () => {
			const calls: Array<CapturedCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: route_specs_factory(sender),
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'admin_revoke_single_target'});

			// Grant an admin permit via the admin route so the revoke has a target.
			const grant_res = await test_app.app.request(
				`/api/admin/accounts/${target.account.id}/permits/grant`,
				{
					method: 'POST',
					headers: {
						...test_app.create_session_headers(),
						'content-type': 'application/json',
					},
					body: JSON.stringify({role: ROLE_ADMIN}),
				},
			);
			const {permit} = (await grant_res.json()) as {permit: {id: string}};

			calls.length = 0;
			const revoke_res = await test_app.app.request(
				`/api/admin/accounts/${target.account.id}/permits/${permit.id}/revoke`,
				{method: 'POST', headers: test_app.create_session_headers()},
			);
			assert.strictEqual(revoke_res.status, 200);

			const revokes = calls.filter((c) => c.method === PERMIT_REVOKE_NOTIFICATION_METHOD);
			assert.strictEqual(revokes.length, 1);
			assert.strictEqual(revokes[0]?.account_id, target.account.id);
			const params = revokes[0]?.params as {
				permit_id?: string;
				role?: string;
				scope_id?: string | null;
				reason?: string | null;
			};
			assert.strictEqual(params.permit_id, permit.id);
			assert.strictEqual(params.role, ROLE_ADMIN);
			assert.strictEqual(params.scope_id, null);
			assert.strictEqual(params.reason, null);
		});

		test('revoke supersedes pending offers and notifies each grantor', async () => {
			const calls: Array<CapturedCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: route_specs_factory(sender),
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const grantor_b = await test_app.create_account({
				username: 'admin_revoke_grantor_b',
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'admin_revoke_supersede_target'});

			const grant_res = await test_app.app.request(
				`/api/admin/accounts/${target.account.id}/permits/grant`,
				{
					method: 'POST',
					headers: {
						...test_app.create_session_headers(),
						'content-type': 'application/json',
					},
					body: JSON.stringify({role: ROLE_ADMIN}),
				},
			);
			const {permit} = (await grant_res.json()) as {permit: {id: string}};

			// Insert two pending offers for the same (target account, admin, null scope)
			// — one from the bootstrap grantor, one from grantor_b. The admin revoke
			// must supersede both and fire one supersede notification per grantor.
			const db = get_db();
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
			const revoke_res = await test_app.app.request(
				`/api/admin/accounts/${target.account.id}/permits/${permit.id}/revoke`,
				{method: 'POST', headers: test_app.create_session_headers()},
			);
			assert.strictEqual(revoke_res.status, 200);

			const revokes = calls.filter((c) => c.method === PERMIT_REVOKE_NOTIFICATION_METHOD);
			assert.strictEqual(revokes.length, 1);
			assert.strictEqual(revokes[0]?.account_id, target.account.id);

			const supersedes = calls.filter(
				(c) => c.method === PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
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
				assert.strictEqual(params.reason, 'permit_revoked');
				assert.strictEqual(params.cause_id, permit.id);
				assert.ok(
					params.offer?.id === offer_a_id || params.offer?.id === offer_b_id,
					`supersede payload should reference one of the pending offers; got ${params.offer?.id}`,
				);
			}
		});

		test('revoke with no pending offers fires only permit_revoke', async () => {
			const calls: Array<CapturedCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: route_specs_factory(sender),
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'admin_revoke_no_offers_target'});

			const grant_res = await test_app.app.request(
				`/api/admin/accounts/${target.account.id}/permits/grant`,
				{
					method: 'POST',
					headers: {
						...test_app.create_session_headers(),
						'content-type': 'application/json',
					},
					body: JSON.stringify({role: ROLE_ADMIN}),
				},
			);
			const {permit} = (await grant_res.json()) as {permit: {id: string}};

			calls.length = 0;
			await test_app.app.request(
				`/api/admin/accounts/${target.account.id}/permits/${permit.id}/revoke`,
				{method: 'POST', headers: test_app.create_session_headers()},
			);
			const revokes = calls.filter((c) => c.method === PERMIT_REVOKE_NOTIFICATION_METHOD);
			const supersedes = calls.filter(
				(c) => c.method === PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
			);
			assert.strictEqual(revokes.length, 1);
			assert.strictEqual(supersedes.length, 0);
		});

		test('failed revoke (non-web-grantable) fires no notifications', async () => {
			const calls: Array<CapturedCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: route_specs_factory(sender),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
			});
			// bootstrap account has the keeper permit. That role is not
			// web_grantable, so the admin revoke must fail with 403 and fire no
			// WS notifications.
			const keeper_rows = await get_db().query<{id: string}>(
				`SELECT id FROM permit WHERE actor_id = $1 AND role = 'keeper' AND revoked_at IS NULL`,
				[test_app.backend.actor.id],
			);
			const keeper_permit_id = keeper_rows[0]?.id;
			assert.ok(keeper_permit_id, 'expected bootstrap actor to hold keeper permit');

			const res = await test_app.app.request(
				`/api/admin/accounts/${test_app.backend.account.id}/permits/${keeper_permit_id}/revoke`,
				{method: 'POST', headers: test_app.create_session_headers()},
			);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(calls.length, 0);
		});
	});
});
