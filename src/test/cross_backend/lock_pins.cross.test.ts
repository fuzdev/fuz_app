/**
 * The row locks that order a write against a concurrent one, pinned on both
 * spines over real PostgreSQL.
 *
 * Each case plays the other transaction itself, over a raw `pg` connection to
 * the backend's own database: its writes run and are left uncommitted, the
 * request is sent, the transaction commits once the request is either waiting
 * on a lock or has answered, and the final state is asserted. A lock that holds
 * makes the request wait and then meet the committed writes; a lock removed or
 * too weak lets the request through ahead of them, and the final state shows
 * it. Nothing here asserts a wait or a duration — the commit only waits for the
 * request to reach a lock or finish, so a request that never waits is judged by
 * what it left behind.
 *
 * - **A credential mint across a password change or a delete** — a login and
 *   an `account_token_create` are refused, and nothing they could have minted
 *   survives.
 * - **An offer or an invite across a delete of its account** — an offer to a
 *   deleted recipient or from a deleted grantor, and an invite from a deleted
 *   issuer, are refused and leave nothing pending.
 * - **The last-admin guard** — two removals of the last two admins, one
 *   played (its count share-locked, its write made once the other waits) and
 *   one requested, for every pairing of delete, revoke and purge: the
 *   requested one is refused as the last admin's and one admin is left.
 * - **The caps** — a login and a token create at the cap wait on another mint
 *   of the account (one holding even a share lock on the account row) and
 *   evict counting its row, so the account ends at the cap.
 * - **An admin-offer accept against the guard** — the accept's share lock on
 *   its grantor's grant, then its key share on the grantor's actor, played
 *   around a removal of the grantor whose guard locks the actor then the grant:
 *   both commit.
 * - **A purge against the account's writers** — a purge of an account at its
 *   session or token cap across a login or token create, and across a
 *   password change: the purge takes the account row first, so both commit;
 *   across an offer create from the account, it waits and supersedes the
 *   offer.
 * - **Multi-row credential deletes in id order** — the session and token
 *   revoke-alls and both cap evictions, against a transaction holding the
 *   lowest of their rows and then taking the rest: none deadlocks. The
 *   expiry sweep takes its rows the same way; no spine serves it over the
 *   wire, so its pin is in-process (`auth/session_sweep.order.db.test.ts`).
 * - **An admin-offer accept against a removal of its grantor** — the removal
 *   played (its guard, its write, then the end of the grantor's offers once
 *   the accept waits) and the accept sent: the accept takes the grantor's
 *   grant before it claims the offer, so it waits holding nothing and is
 *   refused.
 *
 * Runs in `cross_backend_parity` alone, where both spines are on PostgreSQL
 * (`cross_backend_projects.ts` lists it there, which keeps it out of every
 * single-backend project, `memory://` ones included). Every case also refuses
 * a backend whose `DATABASE_URL` is not a PostgreSQL URL: one connection would
 * queue the request behind the held transaction whatever it locks, and pass.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import pg from 'pg';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { inject_parity_handles } from '#lib/testing/cross_backend/provided_context.ts';
import {
	default_cross_process_setup,
	type ReconstructedBootstrappedBackendHandle,
	type TestFixture
} from '#lib/testing/cross_backend/setup.ts';
import { cross_rpc_call, type RpcResult } from '#lib/testing/cross_backend/cross_rpc.ts';
import { SPINE_ACCOUNT_LOGIN_PATH } from '#lib/testing/cross_backend/spine_surface_constants.ts';
import { DEFAULT_MAX_SESSIONS, DEFAULT_MAX_TOKENS } from '#lib/auth/account_route_schema.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { ERROR_CANNOT_DELETE_LAST_ADMIN } from '#lib/auth/admin_action_specs.ts';
import { ERROR_CANNOT_REVOKE_LAST_ADMIN } from '#lib/auth/role_grant_offer_action_specs.ts';

const PASSWORD = 'lock-pin-password-1';

/** How long the request gets to reach a lock or answer, a bound on a hang only. */
const SETTLE_BOUND_MS = 10_000;

const parity = inject_parity_handles();

const describe_lock_pins = (side: string, handle: ReconstructedBootstrappedBackendHandle): void => {
	const setup_test = default_cross_process_setup(handle);
	const rpc_path = handle.config.rpc_path;
	const database_url = handle.config.env.DATABASE_URL ?? '';

	const connect = async (): Promise<pg.Client> => {
		assert.match(database_url, /^postgres(ql)?:\/\//, `${side}: the backend runs on PostgreSQL`);
		const client = new pg.Client({ connectionString: database_url });
		await client.connect();
		return client;
	};

	/** One value from the backend's database. */
	const read = async <T>(sql: string, params: Array<unknown> = []): Promise<T> => {
		const client = await connect();
		try {
			return (await client.query(sql, params)).rows[0] as T;
		} finally {
			await client.end();
		}
	};
	/** One statement on the backend's database, committed. */
	const write = async (sql: string, params: Array<unknown> = []): Promise<void> => {
		await read(sql, params);
	};
	const count = async (sql: string, params: Array<unknown> = []): Promise<number> =>
		Number((await read<{ n: string | number }>(sql, params)).n);

	/**
	 * Run `held` in a transaction left open, send `request`, then commit once the
	 * request is waiting on a lock or has answered — `then` runs on the held
	 * transaction just before its commit. Returns the request's answer.
	 */
	const against_held = async <T>(
		held: (tx: pg.Client) => Promise<void>,
		request: () => Promise<T>,
		then?: (tx: pg.Client) => Promise<void>
	): Promise<T> => {
		const tx = await connect();
		const probe = await connect();
		try {
			await tx.query('BEGIN');
			await held(tx);
			const state = { settled: false };
			const answer = request().finally(() => {
				state.settled = true;
			});
			const bound = Date.now() + SETTLE_BOUND_MS;
			while (!state.settled) {
				const waiters = await probe.query<{ n: number }>(
					`SELECT COUNT(*)::int AS n FROM pg_stat_activity
					 WHERE wait_event_type = 'Lock' AND datname = current_database()`
				);
				if (waiters.rows[0]!.n > 0) break;
				assert.ok(Date.now() < bound, `${side}: the request neither reached a lock nor answered`);
				await wait(10);
			}
			if (then) await then(tx);
			await tx.query('COMMIT');
			return await answer;
		} finally {
			await tx.query('ROLLBACK').catch(() => {});
			await tx.end();
			await probe.end();
		}
	};

	const login = async (f: TestFixture, username: string) => {
		const res = await f.fresh_transport()(SPINE_ACCOUNT_LOGIN_PATH, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ username, password: PASSWORD })
		});
		await res.text();
		const line = res.headers.getSetCookie()[0];
		return { status: res.status, cookie: res.status === 200 && line ? line.split(';')[0]! : null };
	};
	const rpc = (
		f: TestFixture,
		method: string,
		params: unknown,
		headers: Record<string, string>
	): Promise<RpcResult> => cross_rpc_call(f.fresh_transport(), rpc_path, method, params, headers);
	const daemon_rpc = (f: TestFixture, method: string, params: unknown): Promise<RpcResult> =>
		cross_rpc_call(
			f.fresh_transport({ origin: null }),
			rpc_path,
			method,
			params,
			f.create_daemon_token_headers()
		);
	const token_create = (f: TestFixture, cookie: string) =>
		rpc(
			f,
			'account_token_create',
			{ name: 'pin', scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
			{ cookie }
		);

	// a password change and a delete, as each writes: the account row, then the revokes
	const change_password = (account_id: string) => async (tx: pg.Client) => {
		await tx.query(`UPDATE account SET password_hash = 'x' || password_hash WHERE id = $1`, [
			account_id
		]);
		await tx.query(`DELETE FROM auth_session WHERE account_id = $1`, [account_id]);
		await tx.query(`DELETE FROM api_token WHERE account_id = $1`, [account_id]);
	};
	const delete_account = (account_id: string) => async (tx: pg.Client) => {
		await tx.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [account_id]);
		await tx.query(`UPDATE actor SET deleted_at = NOW() WHERE account_id = $1`, [account_id]);
		await tx.query(`DELETE FROM auth_session WHERE account_id = $1`, [account_id]);
		await tx.query(`DELETE FROM api_token WHERE account_id = $1`, [account_id]);
	};
	const credentials_of = (account_id: string) =>
		count(
			`SELECT (SELECT COUNT(*) FROM auth_session WHERE account_id = $1)
			      + (SELECT COUNT(*) FROM api_token WHERE account_id = $1) AS n`,
			[account_id]
		);

	// a cap eviction and a revoke-all, as both spines write them
	const EVICT_SQL = (table: 'auth_session' | 'api_token') => `DELETE FROM ${table}
		WHERE id IN (
		  SELECT id FROM ${table}
		  WHERE id IN (
		    SELECT id FROM ${table} WHERE account_id = $1
		    ORDER BY created_at DESC, id DESC OFFSET $2
		  )
		  ORDER BY id
		  FOR UPDATE
		)`;
	const REVOKE_ALL_SQL = (table: 'auth_session' | 'api_token') => `DELETE FROM ${table}
		WHERE id IN (SELECT id FROM ${table} WHERE account_id = $1 ORDER BY id FOR UPDATE)`;

	describe(`lock pins (${side})`, () => {
		test('the backend runs on PostgreSQL', () => {
			assert.match(database_url, /^postgres(ql)?:\/\//);
		});

		// -- a credential mint across a password change or a delete --------------

		for (const [writer, play] of [
			['password change', change_password],
			['delete', delete_account]
		] as const) {
			test(`a login across an uncommitted ${writer} is refused and leaves no session`, async () => {
				const f = await setup_test();
				const a = await f.create_account({ username: 'pin_login', password_value: PASSWORD });
				const answer = await against_held(play(a.account.id), () => login(f, 'pin_login'));
				assert.strictEqual(answer.status, 401, 'the login waited and met the committed write');
				assert.strictEqual(await credentials_of(a.account.id), 0);
			});

			test(`a token create across an uncommitted ${writer} is refused and leaves no token`, async () => {
				const f = await setup_test();
				const a = await f.create_account({ username: 'pin_token', password_value: PASSWORD });
				const session = await login(f, 'pin_token');
				assert.ok(session.cookie);
				const answer = await against_held(play(a.account.id), () =>
					token_create(f, session.cookie!)
				);
				assert.ok(!answer.ok, 'the mint waited and met the committed write');
				assert.strictEqual(await credentials_of(a.account.id), 0);
			});
		}

		// -- an offer or an invite across a delete of its account ----------------

		const pending_offers = (account_id: string) =>
			count(
				`SELECT COUNT(*) AS n FROM role_grant_offer o JOIN actor act ON act.id = o.from_actor_id
				 WHERE (o.to_account_id = $1 OR act.account_id = $1)
				   AND o.accepted_at IS NULL AND o.declined_at IS NULL
				   AND o.retracted_at IS NULL AND o.superseded_at IS NULL`,
				[account_id]
			);

		test('an offer across an uncommitted delete of its recipient is refused', async () => {
			const f = await setup_test();
			const recipient = await f.create_account({ username: 'pin_recipient' });
			const answer = await against_held(delete_account(recipient.account.id), () =>
				rpc(
					f,
					'role_grant_offer_create',
					{ to_account_id: recipient.account.id, role: ROLE_ADMIN },
					f.create_session_headers()
				)
			);
			assert.ok(!answer.ok, 'the offer waited and met the tombstone');
			assert.strictEqual(await pending_offers(recipient.account.id), 0);
		});

		test('an offer across an uncommitted delete of its grantor is refused', async () => {
			const f = await setup_test();
			const grantor = await f.create_account({ username: 'pin_grantor', roles: [ROLE_ADMIN] });
			const recipient = await f.create_account({ username: 'pin_recipient' });
			const answer = await against_held(delete_account(grantor.account.id), () =>
				rpc(
					f,
					'role_grant_offer_create',
					{ to_account_id: recipient.account.id, role: ROLE_ADMIN },
					grantor.create_session_headers()
				)
			);
			assert.ok(!answer.ok, 'the offer waited and met the tombstone');
			assert.strictEqual(await pending_offers(grantor.account.id), 0);
		});

		test('an invite across an uncommitted delete of its issuer is refused', async () => {
			const f = await setup_test();
			const issuer = await f.create_account({ username: 'pin_issuer', roles: [ROLE_ADMIN] });
			const answer = await against_held(delete_account(issuer.account.id), () =>
				rpc(f, 'invite_create', { username: 'pin_invitee' }, issuer.create_session_headers())
			);
			assert.ok(!answer.ok, 'the invite waited and met the tombstone');
			assert.strictEqual(
				await count(`SELECT COUNT(*) AS n FROM invite WHERE created_by = $1`, [issuer.actor.id]),
				0
			);
		});

		// -- the last-admin guard, per pairing of removals -----------------------

		// The played removal takes the guard's count share-locked — the weakest
		// lock a guard could hold — and makes its write only once the requested
		// removal is waiting on it. A requested guard that conflicts with a share
		// lock waits there, then counts one admin and refuses; one that doesn't
		// counts two and goes on, and the played write meets its lock (a
		// deadlock, one of the two aborted) or none (both commit, no admin left).
		const PLAYED_GUARD_SQL = `SELECT a.id FROM account a
			JOIN actor act ON act.account_id = a.id
			JOIN role_grant rg ON rg.actor_id = act.id
			WHERE a.deleted_at IS NULL AND act.deleted_at IS NULL
			  AND rg.role = $1 AND rg.scope_id IS NULL
			  AND rg.revoked_at IS NULL AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
			ORDER BY a.id, act.id, rg.id
			FOR SHARE`;
		const admin_grant_of = async (actor_id: string): Promise<string> =>
			(
				await read<{ id: string }>(
					`SELECT id FROM role_grant WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
					[actor_id, ROLE_ADMIN]
				)
			).id;
		const REMOVALS = ['delete', 'revoke', 'purge'] as const;
		const REFUSALS = {
			delete: ERROR_CANNOT_DELETE_LAST_ADMIN,
			revoke: ERROR_CANNOT_REVOKE_LAST_ADMIN,
			purge: ERROR_CANNOT_DELETE_LAST_ADMIN
		} as const;
		for (const [i, played] of REMOVALS.entries()) {
			for (const requested of REMOVALS.slice(i)) {
				test(`two removals of the last two admins (${played} played, ${requested} requested): one admin is left`, async () => {
					const f = await setup_test();
					const a = await f.create_account({ username: 'pin_admin_a', roles: [ROLE_ADMIN] });
					const b = await f.create_account({ username: 'pin_admin_b', roles: [ROLE_ADMIN] });
					const a_grant = await admin_grant_of(a.actor.id);
					const b_grant = await admin_grant_of(b.actor.id);
					// the keeper's own admin grant goes, so a and b are the last two
					await write(
						`UPDATE role_grant SET revoked_at = NOW() WHERE actor_id = $1 AND role = $2`,
						[f.actor.id, ROLE_ADMIN]
					);
					// b removes itself (a purge is the keeper's), so the played removal of
					// a never touches the requester
					const answer = await against_held(
						async (tx) => {
							await tx.query(PLAYED_GUARD_SQL, [ROLE_ADMIN]);
						},
						() =>
							requested === 'delete'
								? rpc(f, 'account_delete', {}, b.create_session_headers())
								: requested === 'revoke'
									? rpc(
											f,
											'role_grant_revoke',
											{ actor_id: b.actor.id, role_grant_id: b_grant },
											b.create_session_headers()
										)
									: daemon_rpc(f, 'account_purge', { account_id: b.account.id, confirm: true }),
						async (tx) => {
							if (played === 'delete') await delete_account(a.account.id)(tx);
							else if (played === 'revoke')
								await tx.query(`UPDATE role_grant SET revoked_at = NOW() WHERE id = $1`, [a_grant]);
							else await tx.query(`DELETE FROM account WHERE id = $1`, [a.account.id]);
						}
					);
					assert.ok(!answer.ok, `the requested removal went through: ${JSON.stringify(answer)}`);
					assert.deepStrictEqual(
						(answer.error?.data as { reason?: unknown } | undefined)?.reason,
						REFUSALS[requested],
						`the requested removal waited, counted one, and was refused: ${JSON.stringify(answer)}`
					);
					assert.strictEqual(
						await count(
							`SELECT COUNT(DISTINCT a.id) AS n FROM account a
							 JOIN actor act ON act.account_id = a.id
							 JOIN role_grant rg ON rg.actor_id = act.id
							 WHERE a.deleted_at IS NULL AND act.deleted_at IS NULL
							   AND rg.role = $1 AND rg.scope_id IS NULL AND rg.revoked_at IS NULL`,
							[ROLE_ADMIN]
						),
						1,
						'one admin is left'
					);
				});
			}
		}

		// -- the caps ------------------------------------------------------------

		// another mint of the account in flight: a share lock on its row (the
		// weakest a mint takes), its credential inserted, the oldest evicted
		const another_mint =
			(account_id: string, table: 'auth_session' | 'api_token', cap: number) =>
			async (tx: pg.Client) => {
				await tx.query(`SELECT id FROM account WHERE id = $1 FOR SHARE`, [account_id]);
				if (table === 'auth_session') {
					await tx.query(
						`INSERT INTO auth_session (id, account_id, expires_at)
						 VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
						[`pin_${crypto.randomUUID()}`, account_id]
					);
				} else {
					await tx.query(
						`INSERT INTO api_token (id, account_id, name, token_hash, scope)
						 VALUES ($1, $2, 'pin', $3, '{"version":1,"kind":"full"}'::jsonb)`,
						[`tok_${crypto.randomUUID().slice(0, 12)}`, account_id, crypto.randomUUID()]
					);
				}
				await tx.query(
					`DELETE FROM ${table} WHERE id IN (
					   SELECT id FROM ${table} WHERE account_id = $1
					   ORDER BY created_at DESC, id DESC OFFSET $2)`,
					[account_id, cap]
				);
			};

		test('a login at the cap waits on another mint of the account and ends at the cap', async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_cap', password_value: PASSWORD });
			while (
				(await count(`SELECT COUNT(*) AS n FROM auth_session WHERE account_id = $1`, [
					a.account.id
				])) < DEFAULT_MAX_SESSIONS
			) {
				assert.strictEqual((await login(f, 'pin_cap')).status, 200);
			}
			const answer = await against_held(
				another_mint(a.account.id, 'auth_session', DEFAULT_MAX_SESSIONS),
				() => login(f, 'pin_cap')
			);
			assert.strictEqual(answer.status, 200);
			assert.strictEqual(
				await count(`SELECT COUNT(*) AS n FROM auth_session WHERE account_id = $1`, [a.account.id]),
				DEFAULT_MAX_SESSIONS
			);
		});

		test('a token create at the cap waits on another mint of the account and ends at the cap', async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_token_cap', password_value: PASSWORD });
			const session = await login(f, 'pin_token_cap');
			assert.ok(session.cookie);
			while (
				(await count(`SELECT COUNT(*) AS n FROM api_token WHERE account_id = $1`, [a.account.id])) <
				DEFAULT_MAX_TOKENS
			) {
				assert.ok((await token_create(f, session.cookie)).ok);
			}
			const answer = await against_held(
				another_mint(a.account.id, 'api_token', DEFAULT_MAX_TOKENS),
				() => token_create(f, session.cookie!)
			);
			assert.ok(answer.ok, JSON.stringify(answer));
			assert.strictEqual(
				await count(`SELECT COUNT(*) AS n FROM api_token WHERE account_id = $1`, [a.account.id]),
				DEFAULT_MAX_TOKENS
			);
		});

		// -- an admin-offer accept against the guard -----------------------------

		test("an admin-offer accept's key share and a removal of its grantor both commit", async () => {
			const f = await setup_test();
			const grantor = await f.create_account({
				username: 'pin_accept_grantor',
				roles: [ROLE_ADMIN]
			});
			const recipient = await f.create_account({ username: 'pin_accept_recipient' });
			const grant = await admin_grant_of(grantor.actor.id);
			// the accept's two locks: its grantor's grant shared before the removal
			// is sent, then — once the removal's guard waits on that grant, holding
			// the grantor's actor — a grant naming the grantor, a key share on it
			const answer = await against_held(
				async (tx) => {
					await tx.query(`SELECT id FROM role_grant WHERE id = $1 FOR SHARE`, [grant]);
				},
				() =>
					rpc(f, 'account_delete', { account_id: grantor.account.id }, f.create_session_headers()),
				async (tx) => {
					await tx.query(
						`INSERT INTO role_grant (actor_id, role, granted_by) VALUES ($1, 'lock_pin', $2)`,
						[recipient.actor.id, grantor.actor.id]
					);
				}
			);
			assert.ok(answer.ok, `the removal: ${JSON.stringify(answer)}`);
			assert.strictEqual(
				await count(
					`SELECT COUNT(*) AS n FROM role_grant WHERE actor_id = $1 AND granted_by = $2`,
					[recipient.actor.id, grantor.actor.id]
				),
				1,
				'the accept side committed'
			);
			assert.strictEqual(
				await count(`SELECT COUNT(*) AS n FROM account WHERE id = $1 AND deleted_at IS NOT NULL`, [
					grantor.account.id
				]),
				1,
				'the grantor is deleted'
			);
		});

		// -- a purge against the account's own writers ---------------------------

		// A purge takes the account row before any other write, as every writer
		// of the account does, so it waits on a writer holding that row rather
		// than holding the account's credential rows the writer reaches next.

		// a login at the cap in flight: its account lock, its session inserted;
		// its eviction runs once the purge waits
		test('a purge of an account at its session cap across an uncommitted login: both commit', async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_purge_cap', password_value: PASSWORD });
			while (
				(await count(`SELECT COUNT(*) AS n FROM auth_session WHERE account_id = $1`, [
					a.account.id
				])) < DEFAULT_MAX_SESSIONS
			) {
				assert.strictEqual((await login(f, 'pin_purge_cap')).status, 200);
			}
			const answer = await against_held(
				async (tx) => {
					await tx.query(
						`SELECT id FROM account WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`,
						[a.account.id]
					);
					await tx.query(
						`INSERT INTO auth_session (id, account_id, expires_at)
						 VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
						[`pin_${crypto.randomUUID()}`, a.account.id]
					);
				},
				() => daemon_rpc(f, 'account_purge', { account_id: a.account.id, confirm: true }),
				async (tx) => {
					await tx.query(EVICT_SQL('auth_session'), [a.account.id, DEFAULT_MAX_SESSIONS]);
				}
			);
			assert.ok(answer.ok, `the purge: ${JSON.stringify(answer)}`);
			assert.strictEqual(
				await count(`SELECT COUNT(*) AS n FROM account WHERE id = $1`, [a.account.id]),
				0
			);
			assert.strictEqual(await credentials_of(a.account.id), 0);
		});

		test('a purge of an account at its token cap across an uncommitted token create: both commit', async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_purge_tok', password_value: PASSWORD });
			const session = await login(f, 'pin_purge_tok');
			assert.ok(session.cookie);
			while (
				(await count(`SELECT COUNT(*) AS n FROM api_token WHERE account_id = $1`, [a.account.id])) <
				DEFAULT_MAX_TOKENS
			) {
				assert.ok((await token_create(f, session.cookie)).ok);
			}
			const answer = await against_held(
				async (tx) => {
					await tx.query(
						`SELECT id FROM account WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`,
						[a.account.id]
					);
					await tx.query(
						`INSERT INTO api_token (id, account_id, name, token_hash, scope)
						 VALUES ($1, $2, 'pin', $3, '{"version":1,"kind":"full"}'::jsonb)`,
						[`tok_${crypto.randomUUID().slice(0, 12)}`, a.account.id, crypto.randomUUID()]
					);
				},
				() => daemon_rpc(f, 'account_purge', { account_id: a.account.id, confirm: true }),
				async (tx) => {
					await tx.query(EVICT_SQL('api_token'), [a.account.id, DEFAULT_MAX_TOKENS]);
				}
			);
			assert.ok(answer.ok, `the purge: ${JSON.stringify(answer)}`);
			assert.strictEqual(await credentials_of(a.account.id), 0);
		});

		// a password change in flight: its account write, then (once the purge
		// waits) its revoke-all, as the handler orders them
		test('a purge across an uncommitted password change of the account: both commit', async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_purge_pw', password_value: PASSWORD });
			assert.strictEqual((await login(f, 'pin_purge_pw')).status, 200);
			const answer = await against_held(
				async (tx) => {
					await tx.query(`UPDATE account SET password_hash = 'x' || password_hash WHERE id = $1`, [
						a.account.id
					]);
				},
				() => daemon_rpc(f, 'account_purge', { account_id: a.account.id, confirm: true }),
				async (tx) => {
					await tx.query(REVOKE_ALL_SQL('auth_session'), [a.account.id]);
				}
			);
			assert.ok(answer.ok, `the purge: ${JSON.stringify(answer)}`);
			assert.strictEqual(await credentials_of(a.account.id), 0);
		});

		// an offer create from the account in flight: its share lock on both
		// parties, its offer inserted. The purge waits on it at the account row,
		// then supersedes the committed offer, audited; a purge that took the row
		// no harder than the create's share would end the account's offers
		// first, miss this one, and leave it to its cascade, unaudited
		test('a purge across an uncommitted offer create from the account supersedes the offer', async () => {
			const f = await setup_test();
			const grantor = await f.create_account({ username: 'pin_purge_offer' });
			const recipient = await f.create_account({ username: 'pin_purge_offer_to' });
			let offer_id = '';
			const answer = await against_held(
				async (tx) => {
					await tx.query(
						`SELECT id FROM account WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
						 ORDER BY id FOR SHARE`,
						[[grantor.account.id, recipient.account.id]]
					);
					offer_id = (
						await tx.query<{ id: string }>(
							`INSERT INTO role_grant_offer (from_actor_id, to_account_id, role, expires_at)
							 VALUES ($1, $2, 'pin_role', NOW() + INTERVAL '1 day') RETURNING id`,
							[grantor.actor.id, recipient.account.id]
						)
					).rows[0]!.id;
				},
				() => daemon_rpc(f, 'account_purge', { account_id: grantor.account.id, confirm: true })
			);
			assert.ok(answer.ok, `the purge: ${JSON.stringify(answer)}`);
			assert.strictEqual(
				await count(
					`SELECT COUNT(*) AS n FROM audit_log
					 WHERE event_type = 'role_grant_offer_supersede' AND metadata->>'offer_id' = $1`,
					[offer_id]
				),
				1,
				'the purge superseded the offer, audited'
			);
		});

		// A writer holding only a key share on the account row — a row inserted
		// that names it, with no account lock — then revoking one of the
		// account's sessions. A purge whose lock conflicts with the key share
		// waits at its first statement; one taken `FOR NO KEY UPDATE` passes,
		// locks the sessions, and meets the key share only at its `DELETE`.
		test('a purge across an uncommitted key-share writer that then revokes a session: both commit', async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_purge_ks', password_value: PASSWORD });
			assert.strictEqual((await login(f, 'pin_purge_ks')).status, 200);
			const old = await read<{ id: string }>(`SELECT id FROM auth_session WHERE account_id = $1`, [
				a.account.id
			]);
			const answer = await against_held(
				async (tx) => {
					await tx.query(
						`INSERT INTO auth_session (id, account_id, expires_at)
						 VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
						[`pin_${crypto.randomUUID()}`, a.account.id]
					);
				},
				() => daemon_rpc(f, 'account_purge', { account_id: a.account.id, confirm: true }),
				async (tx) => {
					await tx.query(`DELETE FROM auth_session WHERE id = $1`, [old.id]);
				}
			);
			assert.ok(answer.ok, `the purge: ${JSON.stringify(answer)}`);
			assert.strictEqual(await credentials_of(a.account.id), 0);
		});

		// -- multi-row credential deletes take their rows in id order ------------

		// Each seeds several rows the delete takes and pins their id order
		// against every order a plan might walk them in. The table is emptied
		// first and the rows written highest id first (and, for an eviction, the
		// higher the id the newer the row), so neither the heap, the account
		// index nor age is id order, and a hashed plan starts at the lowest only
		// by chance. The held transaction locks the lowest, the delete is sent,
		// then the held one locks the rest: an id-ordered delete waits on the
		// lowest holding none of them; one that starts anywhere else holds a row
		// the held transaction then waits on, and the two deadlock.
		const SESSION_IDS = ['0', '3', '6', '9', 'c', 'f'].map((c) => c.repeat(64));
		const TOKEN_IDS = ['0', '5', 'a', 'f', 'k', 'z'].map((c) => `tok_${c.repeat(12)}`);
		const empty_heap = (table: 'auth_session' | 'api_token') => write(`TRUNCATE ${table}`);
		const seed_rows = async (
			table: 'auth_session' | 'api_token',
			account_id: string,
			ids: ReadonlyArray<string>,
			oldest_minutes_ago: number
		): Promise<void> => {
			// highest id first and newest
			for (const [i, id] of ids.toReversed().entries()) {
				const minutes_ago = oldest_minutes_ago - ids.length + i;
				if (table === 'auth_session') {
					await write(
						`INSERT INTO auth_session (id, account_id, expires_at, created_at)
						 VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW() - make_interval(mins => $3))`,
						[id, account_id, minutes_ago]
					);
				} else {
					await write(
						`INSERT INTO api_token (id, account_id, name, token_hash, scope, created_at)
						 VALUES ($1, $2, 'pin', $3, '{"version":1,"kind":"full"}'::jsonb,
						         NOW() - make_interval(mins => $4))`,
						[id, account_id, crypto.randomUUID(), minutes_ago]
					);
				}
			}
		};
		/** Newer rows the eviction keeps, `count` of them. */
		const seed_kept = (table: 'auth_session' | 'api_token', account_id: string, count: number) =>
			seed_rows(
				table,
				account_id,
				Array.from({ length: count }, (_, i) =>
					table === 'auth_session'
						? `7${String(i).padStart(63, '7')}`
						: `tok_m${String(i).padStart(11, '0')}`
				),
				count + 1
			);
		const lock_lowest = (table: string, ids: ReadonlyArray<string>) => async (tx: pg.Client) => {
			await tx.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [ids[0]]);
		};
		const lock_the_rest = (table: string, ids: ReadonlyArray<string>) => async (tx: pg.Client) => {
			for (const id of ids.slice(1).toReversed()) {
				await tx.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
			}
		};
		const remaining = (table: string, ids: ReadonlyArray<string>) =>
			count(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ANY($1::text[])`, [ids]);

		test('a session revoke-all takes its rows in id order', async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_order_rs', password_value: PASSWORD });
			// the login first: its own cap eviction must not take the seeded rows
			await empty_heap('auth_session');
			const session = await login(f, 'pin_order_rs');
			assert.ok(session.cookie);
			await seed_rows('auth_session', a.account.id, SESSION_IDS, 100);
			const answer = await against_held(
				lock_lowest('auth_session', SESSION_IDS),
				() => rpc(f, 'account_session_revoke_all', undefined, { cookie: session.cookie! }),
				lock_the_rest('auth_session', SESSION_IDS)
			);
			assert.ok(answer.ok, `the revoke-all: ${JSON.stringify(answer)}`);
			assert.strictEqual(
				await count(`SELECT COUNT(*) AS n FROM auth_session WHERE account_id = $1`, [a.account.id]),
				0
			);
		});

		test('a token revoke-all takes its rows in id order', async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_order_rt' });
			await empty_heap('api_token');
			await seed_rows('api_token', a.account.id, TOKEN_IDS, 100);
			const answer = await against_held(
				lock_lowest('api_token', TOKEN_IDS),
				() =>
					rpc(
						f,
						'admin_token_revoke_all',
						{ account_id: a.account.id },
						f.create_session_headers()
					),
				lock_the_rest('api_token', TOKEN_IDS)
			);
			assert.ok(answer.ok, `the revoke-all: ${JSON.stringify(answer)}`);
			assert.strictEqual(
				await count(`SELECT COUNT(*) AS n FROM api_token WHERE account_id = $1`, [a.account.id]),
				0
			);
		});

		// the account over its cap before the mint, so the mint's eviction takes
		// exactly the seeded rows, the oldest
		test("a login's cap eviction takes its rows in id order", async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_order_es', password_value: PASSWORD });
			await empty_heap('auth_session');
			await seed_rows('auth_session', a.account.id, SESSION_IDS, 200);
			await seed_kept('auth_session', a.account.id, DEFAULT_MAX_SESSIONS - 1);
			const answer = await against_held(
				lock_lowest('auth_session', SESSION_IDS),
				() => login(f, 'pin_order_es'),
				lock_the_rest('auth_session', SESSION_IDS)
			);
			assert.strictEqual(answer.status, 200);
			assert.strictEqual(await remaining('auth_session', SESSION_IDS), 0, 'the eviction took them');
		});

		test("a token create's cap eviction takes its rows in id order", async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_order_et', password_value: PASSWORD });
			const session = await login(f, 'pin_order_et');
			assert.ok(session.cookie);
			await empty_heap('api_token');
			await seed_rows('api_token', a.account.id, TOKEN_IDS, 200);
			await seed_kept('api_token', a.account.id, DEFAULT_MAX_TOKENS - 1);
			const answer = await against_held(
				lock_lowest('api_token', TOKEN_IDS),
				() => token_create(f, session.cookie!),
				lock_the_rest('api_token', TOKEN_IDS)
			);
			assert.ok(answer.ok, `the token create: ${JSON.stringify(answer)}`);
			assert.strictEqual(await remaining('api_token', TOKEN_IDS), 0, 'the eviction took them');
		});

		// -- an admin-offer accept against a removal of its grantor --------------

		// The removal played: its guard locks the grantor's admin grant and its
		// write runs; the accept is sent; once the accept waits, the removal
		// ends the grantor's pending offers (a delete or revoke supersedes them,
		// a purge's cascade deletes them) and commits. An accept that takes the
		// grantor's grant before claiming its offer waits there holding nothing
		// and is then refused; one that claims the offer first holds the row
		// the removal's supersede needs, and the two deadlock.
		const GUARD_SQL = PLAYED_GUARD_SQL.replace('FOR SHARE', 'FOR NO KEY UPDATE');
		for (const removal of ['delete', 'revoke', 'purge'] as const) {
			test(`an admin-offer accept sent across an uncommitted removal (${removal}) of its grantor is refused`, async () => {
				const f = await setup_test();
				const grantor = await f.create_account({
					username: `pin_rm_grantor_${removal}`,
					roles: [ROLE_ADMIN]
				});
				const recipient = await f.create_account({ username: `pin_rm_recipient_${removal}` });
				const grant = await admin_grant_of(grantor.actor.id);
				const offered = await rpc(
					f,
					'role_grant_offer_create',
					{ to_account_id: recipient.account.id, role: ROLE_ADMIN },
					grantor.create_session_headers()
				);
				assert.ok(offered.ok, `the offer: ${JSON.stringify(offered)}`);
				const offer_id = (offered.result as { offer: { id: string } }).offer.id;
				const answer = await against_held(
					async (tx) => {
						await tx.query(GUARD_SQL, [ROLE_ADMIN]);
						if (removal === 'delete') {
							await tx.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [
								grantor.account.id
							]);
							await tx.query(`UPDATE actor SET deleted_at = NOW() WHERE account_id = $1`, [
								grantor.account.id
							]);
						} else if (removal === 'revoke') {
							await tx.query(`UPDATE role_grant SET revoked_at = NOW() WHERE id = $1`, [grant]);
						}
					},
					() => rpc(f, 'role_grant_offer_accept', { offer_id }, recipient.create_session_headers()),
					async (tx) => {
						if (removal === 'purge') {
							await tx.query(`DELETE FROM account WHERE id = $1`, [grantor.account.id]);
						} else {
							await tx.query(
								`UPDATE role_grant_offer SET superseded_at = NOW()
								 WHERE from_actor_id = $1 AND accepted_at IS NULL AND declined_at IS NULL
								   AND retracted_at IS NULL AND superseded_at IS NULL`,
								[grantor.actor.id]
							);
						}
					}
				);
				assert.ok(!answer.ok, `the accept went through: ${JSON.stringify(answer)}`);
				assert.ok(
					answer.status >= 400 && answer.status < 500,
					`the accept is refused, not failed: ${JSON.stringify(answer)}`
				);
				assert.strictEqual(
					await count(`SELECT COUNT(*) AS n FROM role_grant WHERE actor_id = $1 AND role = $2`, [
						recipient.actor.id,
						ROLE_ADMIN
					]),
					0,
					'no admin grant conferred'
				);
			});
		}
	});
};

describe_lock_pins('ts', parity.a);
describe_lock_pins('rust', parity.b);
