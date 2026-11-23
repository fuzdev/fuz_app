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
 * - **A key-share writer against the guard** — a share lock on an admin's
 *   grant, then a key share on its actor (a grant inserted to it — `actor_id`
 *   keeps its foreign key), played around a removal of that admin whose guard
 *   locks the actor then the grant: both commit.
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
 *   account row before it reads the grantor's authority or claims the offer,
 *   so it waits holding nothing it needs and is refused.
 * - **An accept's account locks** — two sibling accepts take turns at the
 *   recipient's row (the second refused, its offer superseded); an accept by a
 *   recipient deleted or purged in flight waits on that removal and answers
 *   the dead credential; an accept by an admin recipient whose account sorts
 *   below its grantor's waits on a guard holding the recipient's row without
 *   holding the grantor's; an accept whose grantor's grant names the
 *   recipient's actor (`granted_by`), across a purge of the recipient, answers
 *   the dead credential, and the cascade never writes that grant — the stamp
 *   carries no foreign key.
 * - **A revoke and a purge against what they reach** — a revoke across a
 *   re-offer to its revokee takes the revokee's row first, waits, and
 *   supersedes the refreshed offer; a purge's cascade never writes the grants
 *   its account granted, so it and another removal's guard over those admins
 *   both commit; a purge waits at its own row on an offer create holding it,
 *   holding no other account's; and two purges whose accounts' offers
 *   (accepted or declined) or invites cross take turns at the advisory lock
 *   every purge takes first, rather than meeting in their cascades. A scope
 *   teardown has no wire route; its pin is in-process.
 * - **Multi-row offer writes in id order** — a purge's and a delete's two
 *   supersedes, a revoke's, and an accept's claim of its offer and siblings,
 *   against a transaction holding the lowest of their rows and then taking
 *   the rest: none deadlocks. The expiry sweep and a scope teardown take
 *   their rows the same way; no spine serves them over the wire, so their pins
 *   are in-process (`auth/role_grant_offer.lock_order.db.test.ts`).
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
import { ACCOUNT_PURGE_ADVISORY_LOCK_KEY } from '#lib/auth/account_queries.ts';
import { ERROR_CANNOT_DELETE_LAST_ADMIN } from '#lib/auth/admin_action_specs.ts';
import {
	ERROR_CANNOT_REVOKE_LAST_ADMIN,
	ERROR_ROLE_GRANT_OFFER_TERMINAL
} from '#lib/auth/role_grant_offer_action_specs.ts';
import { ERROR_AUTHENTICATION_REQUIRED } from '#lib/http/error_schemas.ts';

const PASSWORD = 'lock-pin-password-1';

/** How long the request gets to reach a lock or answer, a bound on a hang only. */
const SETTLE_BOUND_MS = 10_000;

const parity = inject_parity_handles();

const describe_lock_pins = (side: string, handle: ReconstructedBootstrappedBackendHandle): void => {
	// the played transactions tombstone accounts by hand, without the cascade a
	// delete runs (the actors and credentials are left as they were)
	const setup_test = default_cross_process_setup(handle, {
		exclude_db_invariants: {
			credential_of_tombstoned_account:
				'a played delete tombstones the account by hand and leaves its credentials',
			actor_tombstone_disagrees_with_account:
				'a played delete tombstones the account by hand and leaves its actors live'
		}
	});
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

		// -- a key-share writer against the guard -------------------------------

		test("a key-share writer on an admin's actor and a removal of that admin both commit", async () => {
			const f = await setup_test();
			const grantor = await f.create_account({
				username: 'pin_accept_grantor',
				roles: [ROLE_ADMIN]
			});
			const recipient = await f.create_account({ username: 'pin_accept_recipient' });
			const grant = await admin_grant_of(grantor.actor.id);
			// a writer's two locks: the admin's grant shared before the removal is
			// sent, then — once the removal's guard waits on that grant, holding the
			// admin's actor — a grant to the admin's actor, a key share on it
			// (`actor_id` keeps its foreign key; a `granted_by` stamp has none)
			const answer = await against_held(
				async (tx) => {
					await tx.query(`SELECT id FROM role_grant WHERE id = $1 FOR SHARE`, [grant]);
				},
				() =>
					rpc(f, 'account_delete', { account_id: grantor.account.id }, f.create_session_headers()),
				async (tx) => {
					await tx.query(
						`INSERT INTO role_grant (actor_id, role, granted_by) VALUES ($1, 'lock_pin', $2)`,
						[grantor.actor.id, recipient.actor.id]
					);
				}
			);
			assert.ok(answer.ok, `the removal: ${JSON.stringify(answer)}`);
			assert.strictEqual(
				await count(
					`SELECT COUNT(*) AS n FROM role_grant WHERE actor_id = $1 AND role = 'lock_pin'`,
					[grantor.actor.id]
				),
				1,
				'the writer committed'
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

		// -- an accept's account locks -------------------------------------------

		const offer_columns = `(id, from_actor_id, to_account_id, role, expires_at)`;
		const insert_offer = (id: string, from_actor_id: string, to_account_id: string, role: string) =>
			write(
				`INSERT INTO role_grant_offer ${offer_columns}
				 VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day')`,
				[id, from_actor_id, to_account_id, role]
			);
		/** `n` fresh ids, ascending — the order every multi-row offer write takes. */
		const ascending_ids = (n: number): Array<string> =>
			Array.from({ length: n }, () => crypto.randomUUID()).sort();
		const offer_state = async (id: string) =>
			read<{ accepted: boolean; superseded: boolean } | undefined>(
				`SELECT accepted_at IS NOT NULL AS accepted, superseded_at IS NOT NULL AS superseded
				 FROM role_grant_offer WHERE id = $1`,
				[id]
			);
		const active_grants = (actor_id: string, role: string) =>
			count(
				`SELECT COUNT(*) AS n FROM role_grant WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL`,
				[actor_id, role]
			);
		const accept = (
			f: TestFixture,
			recipient: { create_session_headers: () => Record<string, string> },
			offer_id: string
		) => rpc(f, 'role_grant_offer_accept', { offer_id }, recipient.create_session_headers());
		const reason_of = (answer: RpcResult): unknown =>
			(answer.error?.data as { reason?: unknown } | undefined)?.reason;

		// A sibling accept played: the recipient's row shared (the weakest lock
		// an account's writer takes — its own accept takes it harder), its offer
		// claimed, its grant written; once the sent accept waits, it supersedes
		// the sent one's offer. The sent offer sorts first, so an accept that
		// passes the recipient's row claims it and then waits on the played offer
		// while holding the row the played supersede needs.
		test('two sibling accepts take turns at the recipient: the second is refused', async () => {
			const f = await setup_test();
			const g1 = await f.create_account({ username: 'pin_sib_g1' });
			const g2 = await f.create_account({ username: 'pin_sib_g2' });
			const r = await f.create_account({ username: 'pin_sib_r' });
			const [sent, played] = ascending_ids(2) as [string, string];
			await insert_offer(played, g1.actor.id, r.account.id, 'participant');
			await insert_offer(sent, g2.actor.id, r.account.id, 'participant');
			const answer = await against_held(
				async (tx) => {
					await tx.query(`SELECT id FROM account WHERE id = $1 FOR SHARE`, [r.account.id]);
					await tx.query(`SELECT id FROM role_grant_offer WHERE id = $1 FOR UPDATE`, [played]);
					const grant = (
						await tx.query<{ id: string }>(
							`INSERT INTO role_grant (actor_id, role, granted_by, source_offer_id)
							 VALUES ($1, 'participant', $2, $3) RETURNING id`,
							[r.actor.id, g1.actor.id, played]
						)
					).rows[0]!.id;
					await tx.query(
						`UPDATE role_grant_offer SET accepted_at = NOW(), resulting_role_grant_id = $2 WHERE id = $1`,
						[played, grant]
					);
				},
				() => accept(f, r, sent),
				async (tx) => {
					await tx.query(`UPDATE role_grant_offer SET superseded_at = NOW() WHERE id = $1`, [sent]);
				}
			);
			assert.ok(!answer.ok, `the second accept went through: ${JSON.stringify(answer)}`);
			assert.strictEqual(
				reason_of(answer),
				ERROR_ROLE_GRANT_OFFER_TERMINAL,
				JSON.stringify(answer)
			);
			assert.strictEqual(await active_grants(r.actor.id, 'participant'), 1);
			assert.deepStrictEqual(await offer_state(sent), { accepted: false, superseded: true });
		});

		// A removal of the recipient played, its account written first as every
		// removal does, its offers superseded; the accept sent waits at the
		// recipient's row and then answers the dead credential. One that reaches
		// the offer first meets the supersede (or the purge's cascade) instead
		// and answers the offer's state.
		for (const removal of ['delete', 'purge'] as const) {
			test(`an accept by a recipient ${removal}d in flight answers the dead credential`, async () => {
				const f = await setup_test();
				const g = await f.create_account({ username: `pin_gone_g_${removal}` });
				const r = await f.create_account({ username: `pin_gone_r_${removal}` });
				const [offer] = ascending_ids(1) as [string];
				await insert_offer(offer, g.actor.id, r.account.id, 'participant');
				const answer = await against_held(
					async (tx) => {
						if (removal === 'delete') {
							await tx.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [r.account.id]);
						} else {
							await tx.query(`SELECT id FROM account WHERE id = $1 FOR UPDATE`, [r.account.id]);
						}
						await tx.query(
							`UPDATE role_grant_offer SET superseded_at = NOW() WHERE to_account_id = $1`,
							[r.account.id]
						);
					},
					() => accept(f, r, offer),
					async (tx) => {
						if (removal === 'purge') {
							await tx.query(`DELETE FROM account WHERE id = $1`, [r.account.id]);
						}
					}
				);
				assert.ok(!answer.ok, JSON.stringify(answer));
				assert.strictEqual(answer.status, 401, JSON.stringify(answer));
				assert.strictEqual(reason_of(answer), ERROR_AUTHENTICATION_REQUIRED);
			});
		}

		// An admin recipient whose account sorts below its grantor's, and a
		// removal of a third admin: its guard takes account rows in id order, so
		// it holds the recipient's before the grantor's. Played: the guard's first
		// row, the recipient's; the accept is sent; then the rest of the guard and
		// the write. An accept taking the two accounts in id order waits at the
		// recipient's holding nothing; one taking the grantor's first holds it
		// while waiting on the recipient's, and the guard reaching it deadlocks.
		test("an accept by an admin recipient sorting below its grantor waits on an admin's removal", async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_cyc_a', roles: [ROLE_ADMIN] });
			const b = await f.create_account({ username: 'pin_cyc_b', roles: [ROLE_ADMIN] });
			const third = await f.create_account({ username: 'pin_cyc_c', roles: [ROLE_ADMIN] });
			const [r, g] = a.account.id < b.account.id ? [a, b] : [b, a];
			const offered = await rpc(
				f,
				'role_grant_offer_create',
				{ to_account_id: r.account.id, role: ROLE_ADMIN },
				g.create_session_headers()
			);
			assert.ok(offered.ok, `the offer: ${JSON.stringify(offered)}`);
			const offer_id = (offered.result as { offer: { id: string } }).offer.id;
			const answer = await against_held(
				async (tx) => {
					await tx.query(`SELECT id FROM account WHERE id = $1 FOR NO KEY UPDATE`, [r.account.id]);
				},
				() => accept(f, r, offer_id),
				async (tx) => {
					await tx.query(GUARD_SQL, [ROLE_ADMIN]);
					await tx.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [third.account.id]);
				}
			);
			assert.ok(answer.ok, `the accept: ${JSON.stringify(answer)}`);
			assert.deepStrictEqual(await offer_state(offer_id), { accepted: true, superseded: false });
			assert.strictEqual(
				await count(`SELECT COUNT(*) AS n FROM account WHERE id = $1 AND deleted_at IS NOT NULL`, [
					third.account.id
				]),
				1,
				'the third admin is deleted'
			);
		});

		// The grantor's admin grant names one of the recipient's actors
		// (`granted_by`), and the grantor's account sorts below the recipient's.
		// A purge of the recipient played (its account row first, its offers
		// superseded); the accept is sent, takes the grantor's row and waits at
		// the recipient's; then the purge's delete. The accept waits it out and
		// answers the dead credential, and the cascade never writes the
		// grantor's grant: `granted_by` is a provenance stamp, with no foreign
		// key, so it keeps the purged actor's id.
		test("an accept across a purge of its recipient whose actor granted the grantor's admin", async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_gb_a' });
			const b = await f.create_account({ username: 'pin_gb_b' });
			const [g, r] = a.account.id < b.account.id ? [a, b] : [b, a];
			const grant = (
				await read<{ id: string }>(
					`INSERT INTO role_grant (actor_id, role, granted_by) VALUES ($1, $2, $3) RETURNING id`,
					[g.actor.id, ROLE_ADMIN, r.actor.id]
				)
			).id;
			const [offer] = ascending_ids(1) as [string];
			await insert_offer(offer, g.actor.id, r.account.id, ROLE_ADMIN);
			const answer = await against_held(
				async (tx) => {
					await tx.query(`SELECT id FROM account WHERE id = $1 FOR UPDATE`, [r.account.id]);
					await tx.query(
						`UPDATE role_grant_offer SET superseded_at = NOW() WHERE to_account_id = $1`,
						[r.account.id]
					);
				},
				() => accept(f, r, offer),
				async (tx) => {
					await tx.query(`DELETE FROM account WHERE id = $1`, [r.account.id]);
				}
			);
			assert.strictEqual(answer.status, 401, JSON.stringify(answer));
			assert.strictEqual(reason_of(answer), ERROR_AUTHENTICATION_REQUIRED);
			assert.deepStrictEqual(
				await read<{ granted_by: string | null; revoked: boolean }>(
					`SELECT granted_by, revoked_at IS NOT NULL AS revoked FROM role_grant WHERE id = $1`,
					[grant]
				),
				{ granted_by: r.actor.id, revoked: false },
				"the purge's cascade never writes the grantor's grant"
			);
		});

		// -- multi-row offer writes take their rows in id order ------------------

		// Two offers each: the held transaction locks the lower id, the request is
		// sent, then the held one locks the higher. A write that takes them in id
		// order, in one statement, waits on the lower holding neither; one that
		// takes the higher first holds it while waiting on the lower, and the two
		// deadlock.
		const lock_offer = (id: string) => async (tx: pg.Client) => {
			await tx.query(`SELECT id FROM role_grant_offer WHERE id = $1 FOR UPDATE`, [id]);
		};

		for (const removal of ['purge', 'delete'] as const) {
			test(`a ${removal} locks its offers made and received in id order`, async () => {
				const f = await setup_test();
				const g = await f.create_account({ username: `pin_ord_g_${removal}` });
				const x = await f.create_account({ username: `pin_ord_x_${removal}` });
				const y = await f.create_account({ username: `pin_ord_y_${removal}` });
				// the one it received sorts first; it supersedes the one it made first
				const [incoming, outgoing] = ascending_ids(2) as [string, string];
				await insert_offer(incoming, g.actor.id, x.account.id, 'participant');
				await insert_offer(outgoing, x.actor.id, y.account.id, 'participant');
				const answer = await against_held(
					lock_offer(incoming),
					() =>
						removal === 'purge'
							? daemon_rpc(f, 'account_purge', { account_id: x.account.id, confirm: true })
							: rpc(f, 'account_delete', { account_id: x.account.id }, f.create_session_headers()),
					lock_offer(outgoing)
				);
				assert.ok(answer.ok, `the ${removal}: ${JSON.stringify(answer)}`);
				if (removal === 'delete') {
					assert.deepStrictEqual(await offer_state(incoming), {
						accepted: false,
						superseded: true
					});
					assert.deepStrictEqual(await offer_state(outgoing), {
						accepted: false,
						superseded: true
					});
				}
			});
		}

		test('a revoke locks the offers it supersedes in id order, before its grant', async () => {
			const f = await setup_test();
			const g = await f.create_account({ username: 'pin_ord_rv_g' });
			const x = await f.create_account({ username: 'pin_ord_rv_x', roles: ['participant'] });
			const y = await f.create_account({ username: 'pin_ord_rv_y' });
			const grant = (
				await read<{ id: string }>(
					`SELECT id FROM role_grant WHERE actor_id = $1 AND role = 'participant'`,
					[x.actor.id]
				)
			).id;
			// the one it made sorts first; it supersedes the received ones first
			const [outgoing, incoming] = ascending_ids(2) as [string, string];
			await insert_offer(outgoing, x.actor.id, y.account.id, 'participant');
			await insert_offer(incoming, g.actor.id, x.account.id, 'participant');
			const answer = await against_held(
				lock_offer(outgoing),
				() =>
					rpc(
						f,
						'role_grant_revoke',
						{ actor_id: x.actor.id, role_grant_id: grant },
						f.create_session_headers()
					),
				lock_offer(incoming)
			);
			assert.ok(answer.ok, `the revoke: ${JSON.stringify(answer)}`);
			assert.deepStrictEqual(await offer_state(incoming), { accepted: false, superseded: true });
			assert.deepStrictEqual(await offer_state(outgoing), { accepted: false, superseded: true });
		});

		test('an accept claims its offer and the siblings it supersedes in id order', async () => {
			const f = await setup_test();
			const g1 = await f.create_account({ username: 'pin_ord_ac_g1' });
			const g2 = await f.create_account({ username: 'pin_ord_ac_g2' });
			const r = await f.create_account({ username: 'pin_ord_ac_r' });
			const [sibling, own] = ascending_ids(2) as [string, string];
			await insert_offer(sibling, g2.actor.id, r.account.id, 'participant');
			await insert_offer(own, g1.actor.id, r.account.id, 'participant');
			const answer = await against_held(
				lock_offer(sibling),
				() => accept(f, r, own),
				lock_offer(own)
			);
			assert.ok(answer.ok, `the accept: ${JSON.stringify(answer)}`);
			assert.deepStrictEqual(await offer_state(own), { accepted: true, superseded: false });
			assert.deepStrictEqual(await offer_state(sibling), { accepted: false, superseded: true });
		});

		// -- an admin-offer accept against a removal of its grantor --------------

		// The removal played: its guard locks the grantor's account, actor and
		// admin grant, and its write runs; the accept is sent; once the accept
		// waits, the removal ends the grantor's pending offers (a delete or revoke
		// supersedes them, a purge's cascade deletes them) and commits. An accept
		// that takes the grantor's account row before reading the grantor's
		// authority waits there and then reads the removal; one that reads it
		// unlocked confers the role, and one that claims the offer first holds the
		// row the removal's supersede needs, and the two deadlock.
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

		// -- a revoke and a purge against what their cascades reach -------------

		// A re-offer to the revokee played: both parties' rows shared, as an offer
		// create takes them; once the revoke waits, the upsert of the pending offer
		// it refreshes. A revoke that takes the revokee's row first waits there,
		// then locks and supersedes the refreshed offer; one that locks the offers
		// first holds the one the upsert needs while waiting on the row, and the
		// two deadlock; one that takes no account row supersedes it before the
		// upsert commits, and the upsert writes a fresh pending offer after it.
		test('a revoke across an uncommitted re-offer to its revokee waits and supersedes it', async () => {
			const f = await setup_test();
			const g = await f.create_account({ username: 'pin_rv_reoffer_g' });
			const x = await f.create_account({ username: 'pin_rv_reoffer_x', roles: ['participant'] });
			const grant = (
				await read<{ id: string }>(
					`SELECT id FROM role_grant WHERE actor_id = $1 AND role = 'participant'`,
					[x.actor.id]
				)
			).id;
			const [offer] = ascending_ids(1) as [string];
			await insert_offer(offer, g.actor.id, x.account.id, 'participant');
			const answer = await against_held(
				async (tx) => {
					await tx.query(
						`SELECT id FROM account WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
						[[g.account.id, x.account.id]]
					);
				},
				() =>
					rpc(
						f,
						'role_grant_revoke',
						{ actor_id: x.actor.id, role_grant_id: grant },
						f.create_session_headers()
					),
				async (tx) => {
					await tx.query(
						`INSERT INTO role_grant_offer (from_actor_id, to_account_id, role, expires_at)
						 VALUES ($1, $2, 'participant', NOW() + INTERVAL '2 days')
						 ON CONFLICT (to_account_id, role, COALESCE(scope_kind, 'GLOBAL'),
						   COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), from_actor_id)
						   WHERE accepted_at IS NULL AND declined_at IS NULL
						     AND retracted_at IS NULL AND superseded_at IS NULL
						 DO UPDATE SET expires_at = EXCLUDED.expires_at`,
						[g.actor.id, x.account.id]
					);
				}
			);
			assert.ok(answer.ok, `the revoke: ${JSON.stringify(answer)}`);
			assert.strictEqual(
				await count(
					`SELECT COUNT(*) AS n FROM role_grant_offer
					 WHERE to_account_id = $1 AND accepted_at IS NULL AND declined_at IS NULL
					   AND retracted_at IS NULL AND superseded_at IS NULL`,
					[x.account.id]
				),
				0,
				'no offer to the revokee left pending'
			);
		});

		// Two admins whose grants the purged account's actor granted — directly,
		// or by offers it made that they accepted — the higher stored first so a
		// cascade walking the heap reaches it first. A guard of a third admin's
		// delete played: its rows up to the lower admin's; once the purge waits or
		// has answered, the rest of it and the delete. The purge's cascade never
		// writes the admins' grants — neither `granted_by` nor `source_offer_id`
		// (the accepted offers the cascade deletes) carries a foreign key — so it
		// meets the guard nowhere and both commit, the grants keeping the purged
		// ids. A cascade that set them null reached the higher one, then waited
		// on the lower one the guard holds, while the guard reached for the
		// higher.
		for (const shape of ['direct', 'accepted'] as const) {
			test(`a purge across another removal's guard over the admins its account granted (${shape}): both commit`, async () => {
				const f = await setup_test();
				const x = await f.create_account({ username: `pin_pg_x_${shape}` });
				const p = await f.create_account({ username: `pin_pg_p_${shape}` });
				const q = await f.create_account({ username: `pin_pg_q_${shape}` });
				const third = await f.create_account({
					username: `pin_pg_t_${shape}`,
					roles: [ROLE_ADMIN]
				});
				const [lo, hi] = p.account.id < q.account.id ? [p, q] : [q, p];
				const offers: Array<string | null> = [];
				for (const admin of [hi, lo]) {
					const offer = shape === 'accepted' ? crypto.randomUUID() : null;
					if (offer) await insert_offer(offer, x.actor.id, admin.account.id, ROLE_ADMIN);
					const grant = crypto.randomUUID();
					await write(
						`INSERT INTO role_grant (id, actor_id, role, granted_by, source_offer_id)
						 VALUES ($1, $2, $3, $4, $5)`,
						[grant, admin.actor.id, ROLE_ADMIN, x.actor.id, offer]
					);
					if (offer) {
						await write(
							`UPDATE role_grant_offer SET accepted_at = NOW(), resulting_role_grant_id = $1
							 WHERE id = $2`,
							[grant, offer]
						);
					}
					offers.push(offer);
				}
				const answer = await against_held(
					async (tx) => {
						await tx.query(GUARD_SQL.replace('ORDER BY', 'AND a.id <= $2 ORDER BY'), [
							ROLE_ADMIN,
							lo.account.id
						]);
					},
					() => daemon_rpc(f, 'account_purge', { account_id: x.account.id, confirm: true }),
					async (tx) => {
						await tx.query(GUARD_SQL, [ROLE_ADMIN]);
						await tx.query(`UPDATE account SET deleted_at = NOW() WHERE id = $1`, [
							third.account.id
						]);
					}
				);
				assert.ok(answer.ok, `the purge (${shape}): ${JSON.stringify(answer)}`);
				assert.strictEqual(
					await count(
						`SELECT COUNT(*) AS n FROM role_grant
						 WHERE actor_id = ANY($1::uuid[]) AND granted_by = $2
						   AND source_offer_id IS NOT DISTINCT FROM (
						     CASE WHEN actor_id = $3 THEN $4::uuid ELSE $5::uuid END)`,
						[[lo.actor.id, hi.actor.id], x.actor.id, hi.actor.id, offers[0], offers[1]]
					),
					2,
					`the purge's cascade never writes the admins' grants (${shape})`
				);
			});
		}

		// The purged account sorting below an admin, and an offer create between
		// the two played: the purged account's row shared, then — once the purge
		// waits — the admin's. A purge of a non-admin takes no admin's row: it
		// waits at its own holding only the purge lock, which no create takes;
		// one taking the admins' rows ahead of its own would hold the admin's the
		// create reaches for while waiting on its own row.
		test('a purge across an offer create holding its account, then an admin: both commit', async () => {
			const f = await setup_test();
			const a = await f.create_account({ username: 'pin_po_a' });
			const b = await f.create_account({ username: 'pin_po_b' });
			const [x, admin] = a.account.id < b.account.id ? [a, b] : [b, a];
			await write(`INSERT INTO role_grant (actor_id, role) VALUES ($1, $2)`, [
				admin.actor.id,
				ROLE_ADMIN
			]);
			const answer = await against_held(
				async (tx) => {
					await tx.query(`SELECT id FROM account WHERE id = $1 FOR SHARE`, [x.account.id]);
				},
				() => daemon_rpc(f, 'account_purge', { account_id: x.account.id, confirm: true }),
				async (tx) => {
					await tx.query(`SELECT id FROM account WHERE id = $1 FOR SHARE`, [admin.account.id]);
				}
			);
			assert.ok(answer.ok, `the purge: ${JSON.stringify(answer)}`);
			assert.strictEqual(
				await count(`SELECT COUNT(*) AS n FROM account WHERE id = $1`, [x.account.id]),
				0
			);
		});

		// Two accounts whose rows cross: offers each made the other, accepted or
		// declined, or invites each issued and the other claimed. A purge of x
		// played: the advisory lock every purge takes first, its account row, and
		// a delete of `from_y` (y's offer to x, or y's invite x claimed); once the
		// other purge waits or has answered, x's account delete, whose cascade
		// reaches `from_x`. The row played is the one a lockless purge of y
		// reaches second, by its cascade's order, not by id: the account's own
		// references first — `from_x` through `to_account_id` (or the invite's
		// `claimed_by`) — then its actor's, `from_y` through `from_actor_id` (or
		// `created_by`). A purge of y taking the lock first waits there holding
		// nothing; one that went to its cascade deletes `from_x`, then waits on
		// `from_y`, held by the played one, which then waits on `from_x`: a
		// deadlock.
		for (const shape of ['accepted', 'declined', 'invites'] as const) {
			test(`two purges whose accounts' rows cross (${shape}): both commit`, async () => {
				const f = await setup_test();
				const x = await f.create_account({ username: `pin_pp_x_${shape}` });
				const y = await f.create_account({ username: `pin_pp_y_${shape}` });
				const [from_x, from_y] = ascending_ids(2) as [string, string];
				if (shape === 'invites') {
					for (const [id, issuer, claimer, name] of [
						[from_x, x.actor.id, y.account.id, `pin_pp_iy_${shape}`],
						[from_y, y.actor.id, x.account.id, `pin_pp_ix_${shape}`]
					] as const) {
						await write(
							`INSERT INTO invite (id, username, created_by, claimed_by, claimed_at)
							 VALUES ($1, $2, $3, $4, NOW())`,
							[id, name, issuer, claimer]
						);
					}
				} else {
					for (const [id, from, to] of [
						[from_x, x, y],
						[from_y, y, x]
					] as const) {
						await insert_offer(id, from.actor.id, to.account.id, 'participant');
						if (shape === 'accepted') {
							await write(
								`INSERT INTO role_grant (id, actor_id, role, granted_by, source_offer_id)
								 VALUES ($1, $2, 'participant', $3, $1)`,
								[id, to.actor.id, from.actor.id]
							);
							await write(
								`UPDATE role_grant_offer SET accepted_at = NOW(), resulting_role_grant_id = $1
								 WHERE id = $1`,
								[id]
							);
						} else {
							await write(`UPDATE role_grant_offer SET declined_at = NOW() WHERE id = $1`, [id]);
						}
					}
				}
				const table = shape === 'invites' ? 'invite' : 'role_grant_offer';
				const answer = await against_held(
					async (tx) => {
						await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [
							...ACCOUNT_PURGE_ADVISORY_LOCK_KEY
						]);
						await tx.query(`SELECT id FROM account WHERE id = $1 FOR UPDATE`, [x.account.id]);
						await tx.query(`DELETE FROM ${table} WHERE id = $1`, [from_y]);
					},
					() => daemon_rpc(f, 'account_purge', { account_id: y.account.id, confirm: true }),
					async (tx) => {
						await tx.query(`DELETE FROM account WHERE id = $1`, [x.account.id]);
					}
				);
				assert.ok(answer.ok, `the purge (${shape}): ${JSON.stringify(answer)}`);
				assert.strictEqual(
					await count(`SELECT COUNT(*) AS n FROM account WHERE id = ANY($1::uuid[])`, [
						[x.account.id, y.account.id]
					]),
					0,
					`both purged (${shape})`
				);
			});
		}
	});
};

describe_lock_pins('ts', parity.a);
describe_lock_pins('rust', parity.b);
