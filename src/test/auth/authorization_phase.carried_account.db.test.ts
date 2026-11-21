/**
 * The authorization phase builds on the account the credential leg read and
 * reads it no second time — on every transport that runs the phase: the REST
 * route wrapper, HTTP RPC, and (through the same `perform_action`) each WS
 * message, as the Rust spine's phase takes the resolved account. The window
 * is made exact here: the next account read after the leg's own is stalled.
 * It must never come — the request is answered with the stall still armed.
 * Were it to come, the account is soft-deleted while it is held, which is what
 * the stall makes observable.
 *
 * An account removed in the window is still met by the actor-grain phase,
 * whose actor list finds the account's actors gone: that answers the dead
 * credential's 401, as a request arriving after the removal does, never a 500.
 * Two answers that hand out the account itself, `account_verify` and
 * `GET /account/status`, read it again on purpose, live, and answer that 401
 * too.
 *
 * Runs on every driver: the stall holds a query before it reaches the
 * database, so one connection is enough.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { create_test_app, type TestApp } from '#lib/testing/test_app.ts';
import type { DbInvariantExclusions } from '#lib/testing/db_invariant_queries.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_account_route_specs } from '#lib/auth/account_routes.ts';
import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { prefix_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import { query_account_soft_delete, query_purge_account } from '#lib/auth/account_queries.ts';
import { ERROR_AUTHENTICATION_REQUIRED } from '#lib/http/error_schemas.ts';
import { rpc_call } from '#lib/testing/rpc_helpers.ts';
import { TEST_ORIGIN } from '#lib/testing/test_origin.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { Db } from '#lib/db/db.ts';

import { describe_db } from '../db_fixture.ts';
import { create_gated_db, type GatedDb } from '../gated_db.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...prefix_route_specs(
		'/api/account',
		create_account_route_specs(ctx.deps, {
			session_options,
			login_ip_rate_limiter: null,
			login_account_rate_limiter: null,
			login_fail_floor_ms: 0
		})
	),
	...create_rpc_endpoint({
		notification_sender: ctx.deps.notification_sender,
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: create_standard_rpc_actions(ctx.deps),
		log: ctx.deps.log
	})
];

/** `query_account_by_id` — the read the credential leg and a second read share. */
const is_account_read = (sql: string): boolean =>
	/\bFROM account WHERE id = \$1 AND deleted_at IS NULL$/.test(sql.trim());

/**
 * Send `request` with the account read after the credential leg's stalled.
 * Returns the answer, and whether the phase read the account again — in which
 * case the account was soft-deleted under the held read before it ran.
 */
const send_with_second_read_stalled = async <T>(
	gated: GatedDb,
	db: Db,
	account_id: string,
	request: () => Promise<T>
): Promise<{ answer: T; read_again: boolean }> => {
	const second_read = gated.stall(is_account_read, { skip: 1 });
	const answer = request();
	const first = await Promise.race([
		answer.then(() => 'answered' as const),
		second_read.reached.then(() => 'read_again' as const)
	]);
	if (first === 'read_again') await query_account_soft_delete({ db }, account_id, null);
	// disarms an unreached stall too: a later matching read passes at once
	second_read.release();
	return { answer: await answer, read_again: first === 'read_again' };
};

const setup = async (
	db: Db,
	exclude_db_invariants?: DbInvariantExclusions
): Promise<{ test_app: TestApp; gated: GatedDb }> => {
	const gated = create_gated_db(db);
	const test_app = await create_test_app({
		session_options,
		db: gated.db,
		create_route_specs,
		exclude_db_invariants
	});
	return { test_app, gated };
};

describe_db('authorization phase: the carried account', (get_db) => {
	test('an account-grain RPC call reads no account after the credential leg', async () => {
		// `account_session_list`: account-grain, and its answer is the account's
		// sessions, not the account
		const { test_app, gated } = await setup(get_db());
		try {
			const user = await test_app.create_account({ username: 'carried_rpc' });
			for (const headers of [user.create_session_headers(), user.create_bearer_headers()]) {
				const { answer, read_again } = await send_with_second_read_stalled(
					gated,
					get_db(),
					user.account.id,
					() =>
						rpc_call({
							app: test_app.app,
							path: RPC_PATH,
							method: 'account_session_list',
							headers,
							suppress_default_origin: 'authorization' in headers
						})
				);
				assert.ok(!read_again, 'the authorization phase read the account again');
				assert.ok(answer.ok, JSON.stringify(answer));
				assert.ok(Array.isArray((answer.result as { sessions: unknown }).sessions));
			}
		} finally {
			await test_app.cleanup();
		}
	});

	test('an actor-grain RPC call reads no account after the credential leg', async () => {
		const { test_app, gated } = await setup(get_db());
		try {
			const user = await test_app.create_account({ username: 'carried_actor' });
			const { answer, read_again } = await send_with_second_read_stalled(
				gated,
				get_db(),
				user.account.id,
				() =>
					rpc_call({
						app: test_app.app,
						path: RPC_PATH,
						method: 'role_grant_offer_list',
						params: {},
						headers: user.create_session_headers()
					})
			);
			assert.ok(!read_again, 'the authorization phase read the account again');
			assert.ok(answer.ok, JSON.stringify(answer));
		} finally {
			await test_app.cleanup();
		}
	});

	test('a REST route reads no account after the credential leg', async () => {
		const { test_app, gated } = await setup(get_db());
		try {
			const user = await test_app.create_account({ username: 'carried_rest' });
			const { answer, read_again } = await send_with_second_read_stalled(
				gated,
				get_db(),
				user.account.id,
				async () =>
					test_app.app.request('/api/account/logout', {
						method: 'POST',
						headers: {
							...user.create_session_headers(),
							'content-type': 'application/json',
							origin: TEST_ORIGIN
						},
						body: 'null'
					})
			);
			assert.ok(!read_again, 'the authorization phase read the account again');
			assert.strictEqual(answer.status, 200, await answer.clone().text());
		} finally {
			await test_app.cleanup();
		}
	});

	// The window, made exact: the account's actor list is the first read the
	// authorization phase makes, held while the account is removed.
	for (const removal of ['delete', 'purge'] as const) {
		test(`an actor-grain call whose account is removed (${removal}) after the credential leg answers 401`, async () => {
			// the delete leg tombstones by query, without the handler's cascade
			const { test_app, gated } = await setup(
				get_db(),
				removal === 'delete'
					? {
							credential_of_tombstoned_account:
								'the account is tombstoned by query, its sessions and tokens left live — the handler revokes them'
						}
					: undefined
			);
			try {
				const user = await test_app.create_account({ username: `removed_${removal}` });
				const actor_list = gated.stall((sql) => /\bFROM actor WHERE account_id = \$1/.test(sql));
				const answer = rpc_call({
					app: test_app.app,
					path: RPC_PATH,
					method: 'role_grant_offer_list',
					params: {},
					headers: user.create_session_headers()
				});
				await actor_list.reached;
				if (removal === 'delete') {
					await query_account_soft_delete({ db: get_db() }, user.account.id, null);
					await get_db().query(`UPDATE actor SET deleted_at = NOW() WHERE account_id = $1`, [
						user.account.id
					]);
				} else {
					await query_purge_account({ db: get_db() }, user.account.id);
				}
				actor_list.release();
				const result = await answer;
				assert.ok(!result.ok, `${removal}: ${JSON.stringify(result)}`);
				assert.strictEqual(result.status, 401, removal);
				assert.deepStrictEqual(
					result.error.data,
					{ reason: ERROR_AUTHENTICATION_REQUIRED },
					`${removal}: the dead credential's 401`
				);
			} finally {
				await test_app.cleanup();
			}
		});
	}

	// `account_verify` and `GET /account/status` answer with the account
	// itself, so they read it again, live: one deleted or purged after the
	// credential leg answers the dead credential's 401 there. The window is
	// that second read, held while the account is removed.
	for (const removal of ['delete', 'purge'] as const) {
		// the delete tombstones by query, without the handler's cascade
		const exclude_db_invariants: DbInvariantExclusions | undefined =
			removal === 'delete'
				? {
						credential_of_tombstoned_account:
							'the account is tombstoned by query, its sessions and tokens left live — the handler revokes them',
						actor_tombstone_disagrees_with_account:
							'the account is tombstoned by query, its actor left live — the handler tombstones it'
					}
				: undefined;
		const remove = async (db: Db, account_id: string): Promise<void> => {
			if (removal === 'delete') await query_account_soft_delete({ db }, account_id, null);
			else await query_purge_account({ db }, account_id);
		};
		const with_second_read_held = async <T>(
			gated: GatedDb,
			account_id: string,
			request: () => Promise<T>
		): Promise<T> => {
			const second_read = gated.stall(is_account_read, { skip: 1 });
			const answer = request();
			const first = await Promise.race([
				answer.then(() => 'answered' as const),
				second_read.reached.then(() => 'read_again' as const)
			]);
			if (first === 'read_again') await remove(get_db(), account_id);
			second_read.release();
			assert.strictEqual(first, 'read_again', 'the answer read the account again');
			return answer;
		};

		test(`account_verify on an account removed (${removal}) after the credential leg answers 401`, async () => {
			const { test_app, gated } = await setup(get_db(), exclude_db_invariants);
			try {
				const user = await test_app.create_account({ username: `verify_${removal}` });
				const answer = await with_second_read_held(gated, user.account.id, () =>
					rpc_call({
						app: test_app.app,
						path: RPC_PATH,
						method: 'account_verify',
						headers: user.create_session_headers()
					})
				);
				assert.ok(!answer.ok, JSON.stringify(answer));
				assert.strictEqual(answer.status, 401);
				assert.deepStrictEqual(answer.error.data, { reason: ERROR_AUTHENTICATION_REQUIRED });
			} finally {
				await test_app.cleanup();
			}
		});

		test(`account status on an account removed (${removal}) after the credential leg answers 401`, async () => {
			const { test_app, gated } = await setup(get_db(), exclude_db_invariants);
			try {
				const user = await test_app.create_account({ username: `status_${removal}` });
				const answer = await with_second_read_held(gated, user.account.id, async () =>
					test_app.app.request('/api/account/status', { headers: user.create_session_headers() })
				);
				assert.strictEqual(answer.status, 401, await answer.clone().text());
				assert.strictEqual(
					((await answer.json()) as { error: string }).error,
					ERROR_AUTHENTICATION_REQUIRED
				);
			} finally {
				await test_app.cleanup();
			}
		});
	}
});
