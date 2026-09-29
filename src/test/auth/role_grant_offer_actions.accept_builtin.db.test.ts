/**
 * `role_grant_offer_accept` refuses a builtin-role offer that must not mint —
 * the chokepoint where an offer becomes a `role_grant`, so a pending row no
 * current grant path creates (a direct `query_role_grant_offer_create`, or an
 * offer made under a since-closed path) still can't confer a builtin:
 *
 * - a `keeper` offer never accepts, even from a global admin (403
 *   `role_grant_offer_role_not_grantable` — the answer for a role no offer may
 *   confer);
 * - a scoped builtin offer never accepts (400 `role_grant_builtin_scoped`);
 * - a builtin offer accepts only while its grantor holds an active **global**
 *   `admin` on an active actor of an active account (403
 *   `role_grant_offer_not_authorized` otherwise — revoked, expired, scoped-only,
 *   tombstoned actor, tombstoned account).
 *
 * Each refusal leaves the offer pending and is audited as a failed
 * `role_grant_offer_accept` with `{offer_id, role, scope_id, reason}`. The
 * re-check is builtin-only: an app-role offer from a non-admin grantor still
 * accepts. Twin of the Rust `fuz_auth` accept suite.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { create_test_app, type TestApp } from '$lib/testing/app_server.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '$lib/auth/role_schema.ts';
import {
	query_accept_offer,
	query_role_grant_offer_create,
	RoleGrantOfferBuiltinRefusedError
} from '$lib/auth/role_grant_offer_queries.ts';
import {
	ERROR_ROLE_GRANT_BUILTIN_SCOPED,
	ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
	ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE,
	role_grant_offer_accept_action_spec
} from '$lib/auth/role_grant_offer_action_specs.ts';
import { JSONRPC_ERROR_CODES } from '$lib/http/jsonrpc_errors.ts';
import { install_audit_drift_guard } from '$lib/testing/audit_drift_guard.ts';
import { create_test_role_grant_direct } from '$lib/testing/db_entities.ts';
import { query_audit_log_list } from '$lib/auth/audit_log_queries.ts';
import { rpc_call_for_spec } from '$lib/testing/rpc_helpers.ts';
import type { Db } from '$lib/db/db.ts';
import {
	RPC_PATH,
	TEST_APP_ROLE,
	create_app_role_route_specs,
	describe_db,
	session_options
} from './role_grant_offer_test_helpers.ts';
import { error_reason } from './rpc_test_helpers.ts';

type TestAccount = Awaited<ReturnType<TestApp['create_account']>>;

const create_app = (get_db: () => Db): Promise<TestApp> =>
	create_test_app({
		session_options,
		create_route_specs: create_app_role_route_specs(),
		db: get_db(),
		roles: [ROLE_ADMIN]
	});

/**
 * Stand up a pending offer by direct query — the query layer has no builtin
 * guard on create (the verb does), so this is how the accept-side refusals
 * get their rows.
 */
const offer_directly = async (
	db: Db,
	grantor: TestAccount,
	recipient: TestAccount,
	role: string,
	scope_id: Uuid | null = null
): Promise<Uuid> => {
	const offer = await query_role_grant_offer_create(
		{ db },
		{
			from_actor_id: grantor.actor.id,
			to_account_id: recipient.account.id,
			role,
			scope_kind: scope_id === null ? null : 'space',
			scope_id,
			message: null,
			expires_at: new Date(Date.now() + 60 * 60 * 1000)
		}
	);
	return offer.id;
};

const accept = (test_app: TestApp, recipient: TestAccount, offer_id: Uuid) =>
	rpc_call_for_spec({
		app: test_app.app,
		path: RPC_PATH,
		spec: role_grant_offer_accept_action_spec,
		params: { offer_id },
		headers: recipient.create_session_headers()
	});

const is_pending = async (db: Db, offer_id: Uuid): Promise<boolean> => {
	const rows = await db.query<{
		accepted_at: string | null;
		resulting_role_grant_id: string | null;
	}>(`SELECT accepted_at, resulting_role_grant_id FROM role_grant_offer WHERE id = $1`, [offer_id]);
	return rows[0]?.accepted_at === null && rows[0].resulting_role_grant_id === null;
};

/** The failed `role_grant_offer_accept` audit row for `offer_id`, if one was written. */
const find_accept_failure = async (db: Db, offer_id: Uuid) => {
	const rows = await query_audit_log_list(
		{ db },
		{ event_type: 'role_grant_offer_accept', outcome: 'failure' }
	);
	return rows.find((r) => r.metadata?.offer_id === offer_id);
};

/** Grant `role` on `actor_id` directly — global unless `scope_id` is given. */
const grant = (db: Db, actor_id: Uuid, role: string, scope_id: Uuid | null = null) =>
	create_test_role_grant_direct(db, {
		actor_id,
		role,
		scope_kind: scope_id === null ? null : 'space',
		scope_id,
		granted_by: null
	});

describe_db('role_grant_offer_actions.accept_builtin', (get_db) => {
	install_audit_drift_guard();

	test('a legacy scoped builtin offer is refused with role_grant_builtin_scoped and stays pending', async () => {
		const test_app = await create_app(get_db);
		const db = get_db();
		const grantor = await test_app.create_account({ username: 'scoped_offer_grantor' });
		await grant(db, grantor.actor.id, ROLE_ADMIN);
		const recipient = await test_app.create_account({ username: 'scoped_offer_recipient' });
		const scope_id = create_uuid();
		const offer_id = await offer_directly(db, grantor, recipient, ROLE_ADMIN, scope_id);

		const res = await accept(test_app, recipient, offer_id);
		assert.ok(!res.ok);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_request);
		assert.strictEqual(error_reason(res), ERROR_ROLE_GRANT_BUILTIN_SCOPED);
		assert.ok(await is_pending(db, offer_id), 'the offer stays pending');

		const failure = await find_accept_failure(db, offer_id);
		assert.deepEqual(failure?.metadata, {
			offer_id,
			role: ROLE_ADMIN,
			scope_id,
			reason: ERROR_ROLE_GRANT_BUILTIN_SCOPED
		});

		// The query refuses it too, for a direct caller.
		const caught = await assert_rejects(() =>
			db.transaction((tx) =>
				query_accept_offer(
					{ db: tx },
					{ offer_id, to_account_id: recipient.account.id, actor_id: recipient.actor.id }
				)
			)
		);
		assert.ok(caught instanceof RoleGrantOfferBuiltinRefusedError);
		assert.strictEqual(caught.refusal, 'scoped');
		assert.strictEqual(caught.offer.id, offer_id);
	});

	test('a keeper offer never accepts, even from a global admin', async () => {
		const test_app = await create_app(get_db);
		const db = get_db();
		const grantor = await test_app.create_account({ username: 'keeper_offer_grantor' });
		await grant(db, grantor.actor.id, ROLE_ADMIN);
		const recipient = await test_app.create_account({ username: 'keeper_offer_recipient' });
		const offer_id = await offer_directly(db, grantor, recipient, ROLE_KEEPER);

		const res = await accept(test_app, recipient, offer_id);
		assert.ok(!res.ok);
		assert.strictEqual(res.status, 403);
		assert.strictEqual(error_reason(res), ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE);
		assert.ok(await is_pending(db, offer_id));
		assert.strictEqual(
			(await find_accept_failure(db, offer_id))?.metadata?.reason,
			ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE
		);
		const keepers = await db.query(`SELECT 1 FROM role_grant WHERE actor_id = $1 AND role = $2`, [
			recipient.actor.id,
			ROLE_KEEPER
		]);
		assert.strictEqual(keepers.length, 0);
	});

	test('a builtin offer accepts only once the grantor holds a global admin', async () => {
		const test_app = await create_app(get_db);
		const db = get_db();
		const grantor = await test_app.create_account({ username: 'recheck_grantor' });
		await grant(db, grantor.actor.id, ROLE_ADMIN, create_uuid());
		const recipient = await test_app.create_account({ username: 'recheck_recipient' });
		const offer_id = await offer_directly(db, grantor, recipient, ROLE_ADMIN);

		const refused = await accept(test_app, recipient, offer_id);
		assert.ok(!refused.ok);
		assert.strictEqual(refused.status, 403);
		assert.strictEqual(error_reason(refused), ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED);
		assert.ok(await is_pending(db, offer_id));
		assert.strictEqual(
			(await find_accept_failure(db, offer_id))?.metadata?.reason,
			ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED
		);

		await grant(db, grantor.actor.id, ROLE_ADMIN);
		const accepted = await accept(test_app, recipient, offer_id);
		assert.ok(accepted.ok, JSON.stringify(accepted));
	});

	describe('every grantor branch refuses a builtin accept', () => {
		const branches: Array<{
			name: string;
			break_grantor: (db: Db, grantor: TestAccount, grant_id: Uuid) => Promise<unknown>;
		}> = [
			{
				name: 'revoked global admin',
				break_grantor: (db, _grantor, grant_id) =>
					db.query(`UPDATE role_grant SET revoked_at = NOW() WHERE id = $1`, [grant_id])
			},
			{
				name: 'expired global admin',
				break_grantor: (db, _grantor, grant_id) =>
					db.query(`UPDATE role_grant SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [
						grant_id
					])
			},
			{
				name: 'tombstoned grantor actor',
				break_grantor: (db, grantor) =>
					db.query(`UPDATE actor SET deleted_at = NOW() WHERE id = $1`, [grantor.actor.id])
			},
			{
				name: 'tombstoned grantor account',
				break_grantor: (db, grantor) =>
					db.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [grantor.account.id])
			}
		];

		for (const { name, break_grantor } of branches) {
			test(name, async () => {
				const test_app = await create_app(get_db);
				const db = get_db();
				const grantor = await test_app.create_account({ username: 'branch_grantor' });
				const grant_id = (await grant(db, grantor.actor.id, ROLE_ADMIN)).id;
				const recipient = await test_app.create_account({ username: 'branch_recipient' });
				const offer_id = await offer_directly(db, grantor, recipient, ROLE_ADMIN);
				await break_grantor(db, grantor, grant_id);

				const res = await accept(test_app, recipient, offer_id);
				assert.ok(!res.ok, `${name} must refuse`);
				assert.strictEqual(res.status, 403);
				assert.strictEqual(error_reason(res), ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED);
				assert.ok(await is_pending(db, offer_id));
			});
		}
	});

	test('an app-role offer from a non-admin grantor still accepts', async () => {
		const test_app = await create_app(get_db);
		const db = get_db();
		const grantor = await test_app.create_account({ username: 'app_role_grantor' });
		const recipient = await test_app.create_account({ username: 'app_role_recipient' });
		const offer_id = await offer_directly(db, grantor, recipient, TEST_APP_ROLE);

		const res = await accept(test_app, recipient, offer_id);
		assert.ok(res.ok, JSON.stringify(res));
	});
});
