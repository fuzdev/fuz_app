/**
 * Builtin roles are **global-only**, and every builtin gate reads the global
 * grant — driven through the dispatcher over the standard RPC surface.
 *
 * - **The escalation regression.** A caller whose only `admin` is scoped (a
 *   legacy row — no grant verb writes one) reaches no admin surface: not
 *   `role_grant_assign` (so it can't assign itself a global `admin`), not the
 *   admin listings, not another account's offer inbox, not a cross-account
 *   `account_delete`. A global admin is the positive control.
 * - `role_grant_assign` takes a paired `scope_kind` + `scope_id`, refuses a
 *   scoped builtin (`role_grant_builtin_scoped`), and lands a scoped app role
 *   with the pair on the row and in the audit metadata.
 * - `role_grant_offer_create` refuses a scoped builtin and a builtin offered by
 *   a non-global-admin **before** the consumer callback — pinned here under an
 *   admit-everything callback.
 *
 * Twin of the Rust `fuz_auth` `role_grant_offer` escalation suite. The
 * accept-side rules live in `role_grant_offer_actions.accept_builtin.db.test.ts`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';

import { create_test_app, type TestApp } from '$lib/testing/app_server.ts';
import { create_rpc_endpoint } from '$lib/actions/action_rpc.ts';
import { create_standard_rpc_actions } from '$lib/auth/standard_rpc_actions.ts';
import type { RoleGrantOfferCreateAuthorize } from '$lib/auth/role_grant_offer_actions.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '$lib/auth/role_schema.ts';
import {
	ERROR_ROLE_GRANT_BUILTIN_SCOPED,
	ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED
} from '$lib/auth/role_grant_offer_action_specs.ts';
import {
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_ROLE_NOT_WEB_GRANTABLE
} from '$lib/http/error_schemas.ts';
import { JSONRPC_ERROR_CODES } from '$lib/http/jsonrpc_errors.ts';
import { install_audit_drift_guard } from '$lib/testing/audit_drift_guard.ts';
import { create_test_role_grant_direct } from '$lib/testing/db_entities.ts';
import { query_audit_log_list } from '$lib/auth/audit_log_queries.ts';
import { rpc_call, type RpcCallResult } from '$lib/testing/rpc_helpers.ts';
import type { AppServerContext } from '$lib/server/app_server_context.ts';
import type { RouteSpec } from '$lib/http/route_spec.ts';
import type { Db } from '$lib/db/db.ts';
import {
	RPC_PATH,
	TEST_APP_ROLE,
	admit_all_authorize,
	app_roles,
	describe_db,
	session_options
} from './role_grant_offer_test_helpers.ts';
import { error_reason } from './rpc_test_helpers.ts';

/** The standard surface (admin + offer + account) over the `app_roles` registry. */
const create_standard_route_specs =
	(authorize?: RoleGrantOfferCreateAuthorize) =>
	(ctx: AppServerContext): Array<RouteSpec> => [
		...create_rpc_endpoint({
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null,
			path: RPC_PATH,
			actions: create_standard_rpc_actions(ctx.deps, { roles: app_roles, authorize }),
			log: ctx.deps.log
		})
	];

const create_app = (
	get_db: () => Db,
	authorize?: RoleGrantOfferCreateAuthorize
): Promise<TestApp> =>
	create_test_app({
		session_options,
		create_route_specs: create_standard_route_specs(authorize),
		db: get_db(),
		roles: [ROLE_ADMIN]
	});

const call = (
	test_app: TestApp,
	method: string,
	params: unknown,
	headers: Record<string, string>
): Promise<RpcCallResult> =>
	rpc_call({ app: test_app.app, path: RPC_PATH, method, params, headers });

/** Seed a scoped `admin` on `actor_id` — the legacy row no grant verb writes. */
const grant_scoped_admin = (db: Db, actor_id: Uuid): Promise<unknown> =>
	create_test_role_grant_direct(db, {
		actor_id,
		role: ROLE_ADMIN,
		scope_kind: 'space',
		scope_id: create_uuid(),
		granted_by: null
	});

const count_grants = async (
	db: Db,
	actor_id: Uuid,
	role: string
): Promise<{ global: number; scoped: number }> => {
	const rows = await db.query<{ scope_id: string | null }>(
		`SELECT scope_id FROM role_grant WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
		[actor_id, role]
	);
	return {
		global: rows.filter((r) => r.scope_id === null).length,
		scoped: rows.filter((r) => r.scope_id !== null).length
	};
};

describe_db('role_grant_offer_actions.global_only', (get_db) => {
	install_audit_drift_guard();

	describe('a scoped admin reaches no admin authority', () => {
		test('cannot assign itself a global admin, list accounts, read another inbox, or delete another account', async () => {
			const test_app = await create_app(get_db);
			const db = get_db();
			const scoped = await test_app.create_account({ username: 'scoped_admin_caller' });
			await grant_scoped_admin(db, scoped.actor.id);
			const other = await test_app.create_account({ username: 'scoped_admin_victim' });
			const headers = scoped.create_session_headers();

			// The escalation vector: a scoped admin assigning itself a global admin.
			const escalate = await call(
				test_app,
				'role_grant_assign',
				{ to_account_id: scoped.account.id, role: ROLE_ADMIN },
				headers
			);
			assert.ok(!escalate.ok);
			assert.strictEqual(escalate.status, 403);
			assert.strictEqual(error_reason(escalate), ERROR_INSUFFICIENT_PERMISSIONS);
			assert.deepEqual(await count_grants(db, scoped.actor.id, ROLE_ADMIN), {
				global: 0,
				scoped: 1
			});

			const listed = await call(test_app, 'admin_account_list', {}, headers);
			assert.strictEqual(listed.status, 403);
			assert.strictEqual(error_reason(listed), ERROR_INSUFFICIENT_PERMISSIONS);

			for (const method of ['role_grant_offer_list', 'role_grant_offer_history']) {
				const inbox = await call(test_app, method, { account_id: other.account.id }, headers);
				assert.strictEqual(inbox.status, 403, `${method} of another account`);
			}

			const deleted = await call(
				test_app,
				'account_delete',
				{ account_id: other.account.id },
				headers
			);
			assert.strictEqual(deleted.status, 403);
			assert.strictEqual(error_reason(deleted), ERROR_INSUFFICIENT_PERMISSIONS);
		});

		test('positive control: the global admin assigns through the same dispatcher path', async () => {
			const test_app = await create_app(get_db);
			const target = await test_app.create_account({ username: 'global_admin_target' });
			const res = await call(
				test_app,
				'role_grant_assign',
				{ to_account_id: target.account.id, role: ROLE_ADMIN },
				test_app.create_session_headers()
			);
			assert.ok(res.ok, JSON.stringify(res));
			assert.deepEqual(await count_grants(get_db(), target.actor.id, ROLE_ADMIN), {
				global: 1,
				scoped: 0
			});
		});
	});

	describe('role_grant_assign scope pairing', () => {
		test('an unpaired scope is -32602 on assign and offer create', async () => {
			const test_app = await create_app(get_db);
			const target = await test_app.create_account({ username: 'unpaired_target' });
			for (const method of ['role_grant_assign', 'role_grant_offer_create']) {
				for (const half of [{ scope_id: create_uuid() }, { scope_kind: 'classroom' }]) {
					const res = await call(
						test_app,
						method,
						{ to_account_id: target.account.id, role: TEST_APP_ROLE, ...half },
						test_app.create_session_headers()
					);
					assert.ok(!res.ok, `${method} ${JSON.stringify(half)}`);
					assert.strictEqual(res.status, 400);
					assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
				}
			}
			const rows = await get_db().query(`SELECT 1 FROM role_grant_offer`);
			assert.strictEqual(rows.length, 0, 'no offer written');
		});

		test('a scoped builtin is refused — admin with role_grant_builtin_scoped, keeper as not web-grantable', async () => {
			const test_app = await create_app(get_db);
			const db = get_db();
			const target = await test_app.create_account({ username: 'scoped_builtin_target' });
			const scope_id = create_uuid();

			const admin = await call(
				test_app,
				'role_grant_assign',
				{ to_account_id: target.account.id, role: ROLE_ADMIN, scope_kind: 'space', scope_id },
				test_app.create_session_headers()
			);
			assert.ok(!admin.ok);
			assert.strictEqual(admin.status, 400);
			assert.strictEqual(admin.error.code, JSONRPC_ERROR_CODES.invalid_params);
			assert.strictEqual(error_reason(admin), ERROR_ROLE_GRANT_BUILTIN_SCOPED);

			const keeper = await call(
				test_app,
				'role_grant_assign',
				{ to_account_id: target.account.id, role: ROLE_KEEPER, scope_kind: 'space', scope_id },
				test_app.create_session_headers()
			);
			assert.strictEqual(keeper.status, 403);
			assert.strictEqual(error_reason(keeper), ERROR_ROLE_NOT_WEB_GRANTABLE);

			assert.deepEqual(await count_grants(db, target.actor.id, ROLE_ADMIN), {
				global: 0,
				scoped: 0
			});
			// Both refusals are forensic-audited with the scope pair.
			// newest first: the keeper refusal, then the admin one
			const failures = await query_audit_log_list(
				{ db },
				{ event_type: 'role_grant_create', outcome: 'failure' }
			);
			assert.strictEqual(failures.length, 2);
			assert.deepEqual(failures[1]!.metadata, {
				role: ROLE_ADMIN,
				scope_kind: 'space',
				scope_id
			});
		});

		test('a scoped app role lands with the pair, idempotently, distinct from the global grant', async () => {
			const test_app = await create_app(get_db);
			const db = get_db();
			const target = await test_app.create_account({ username: 'scoped_app_target' });
			const scope_id = create_uuid();
			const params = {
				to_account_id: target.account.id,
				role: TEST_APP_ROLE,
				scope_kind: 'classroom',
				scope_id
			};

			const first = await call(
				test_app,
				'role_grant_assign',
				params,
				test_app.create_session_headers()
			);
			assert.ok(first.ok, JSON.stringify(first));
			const first_id = (first.result as { role_grant_id: Uuid }).role_grant_id;
			const rows = await db.query<{ scope_kind: string | null; scope_id: string | null }>(
				`SELECT scope_kind, scope_id FROM role_grant WHERE id = $1`,
				[first_id]
			);
			assert.deepEqual(rows[0], { scope_kind: 'classroom', scope_id });

			const again = await call(
				test_app,
				'role_grant_assign',
				params,
				test_app.create_session_headers()
			);
			assert.ok(again.ok);
			assert.strictEqual((again.result as { role_grant_id: Uuid }).role_grant_id, first_id);

			const global = await call(
				test_app,
				'role_grant_assign',
				{ to_account_id: target.account.id, role: TEST_APP_ROLE },
				test_app.create_session_headers()
			);
			assert.ok(global.ok);
			assert.notStrictEqual((global.result as { role_grant_id: Uuid }).role_grant_id, first_id);
			assert.deepEqual(await count_grants(db, target.actor.id, TEST_APP_ROLE), {
				global: 1,
				scoped: 1
			});

			// newest first: the global grant, the scoped re-assign, the scoped assign
			const successes = await query_audit_log_list(
				{ db },
				{ event_type: 'role_grant_create', outcome: 'success' }
			);
			const scoped_row = successes.at(-1)!;
			assert.strictEqual(scoped_row.metadata?.scope_kind, 'classroom');
			assert.strictEqual(scoped_row.metadata?.scope_id, scope_id);
		});
	});

	describe('role_grant_offer_create decides builtin roles before the consumer callback', () => {
		test('a scoped builtin offer is refused under an admit-all callback and writes no offer', async () => {
			const test_app = await create_app(get_db, admit_all_authorize);
			const db = get_db();
			const target = await test_app.create_account({ username: 'offer_scoped_builtin' });
			const res = await call(
				test_app,
				'role_grant_offer_create',
				{
					to_account_id: target.account.id,
					role: ROLE_ADMIN,
					scope_kind: 'space',
					scope_id: create_uuid()
				},
				test_app.create_session_headers()
			);
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
			assert.strictEqual(error_reason(res), ERROR_ROLE_GRANT_BUILTIN_SCOPED);
			assert.strictEqual((await db.query(`SELECT 1 FROM role_grant_offer`)).length, 0);
			const failures = await query_audit_log_list(
				{ db },
				{ event_type: 'role_grant_offer_create', outcome: 'failure' }
			);
			assert.strictEqual(failures.length, 1);
		});

		test('a builtin offer needs a global-admin caller, whatever the callback says', async () => {
			const test_app = await create_app(get_db, admit_all_authorize);
			const db = get_db();
			const scoped = await test_app.create_account({ username: 'offer_scoped_admin' });
			await grant_scoped_admin(db, scoped.actor.id);
			const target = await test_app.create_account({ username: 'offer_builtin_target' });

			// A scoped admin can't offer a global admin to a second account it controls.
			const denied = await call(
				test_app,
				'role_grant_offer_create',
				{ to_account_id: target.account.id, role: ROLE_ADMIN },
				scoped.create_session_headers()
			);
			assert.strictEqual(denied.status, 403);
			assert.strictEqual(error_reason(denied), ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED);
			assert.strictEqual((await db.query(`SELECT 1 FROM role_grant_offer`)).length, 0);

			// The callback still governs app roles: the same caller offers one.
			const app_role = await call(
				test_app,
				'role_grant_offer_create',
				{ to_account_id: target.account.id, role: TEST_APP_ROLE },
				scoped.create_session_headers()
			);
			assert.ok(app_role.ok, JSON.stringify(app_role));

			// The global admin offers the builtin under the same callback.
			const allowed = await call(
				test_app,
				'role_grant_offer_create',
				{ to_account_id: target.account.id, role: ROLE_ADMIN },
				test_app.create_session_headers()
			);
			assert.ok(allowed.ok, JSON.stringify(allowed));
		});
	});
});
