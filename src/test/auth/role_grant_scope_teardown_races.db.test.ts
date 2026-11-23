/**
 * A scope's teardown against the writes that bring a grant or an offer into
 * the scope, on real `pg`.
 *
 * The scope lock (`query_scope_lock_shared` / `query_scope_lock_exclusive`)
 * orders them: `query_role_grant_revoke_for_scope` takes it exclusive first;
 * scoped `role_grant_offer_create` and `role_grant_assign` take it shared
 * before the consumer's `authorize` callback reads the scope,
 * `query_role_grant_offer_create` and `query_create_role_grant` take it shared
 * first thing, and `query_accept_offer` after its unlocked head read, before
 * any row. The callback here reads a test scope table through `ctx.db`, as a
 * consumer's scope-existence check does, and the teardown played is a
 * consumer's: the cascade, then the scope row's delete.
 *
 * - **A teardown held uncommitted** — an assign and an offer create wait on
 *   it, then read the scope gone and answer the 403
 *   `role_grant_offer_not_authorized` with its failure row, writing nothing;
 *   an accept waits on it, then finds its offer superseded.
 * - **A writer held uncommitted** — an assign, an offer create, an accept,
 *   and a direct `query_create_role_grant` or `query_role_grant_offer_create`
 *   (no handler around it): the teardown waits on it, then revokes its grant
 *   or supersedes its offer.
 * - **An accept in flight** — paused after its claim, and a teardown paused
 *   after its lock, each against the other: an accept that took the scope lock
 *   only at its grant insert would hold its claimed offer while waiting on a
 *   teardown that waits on that offer.
 * - **Another scope** — a teardown of one scope holds no write at another.
 * - **Shared** — an offer create at a scope answers while an assign at it is
 *   uncommitted: writers take turns with a teardown only.
 * - **No cycle** — a teardown against a delete, a purge and a revoke reaching
 *   its rows, and a scoped assign and offer create against a delete and a
 *   purge of their recipient, in both orders: the second waits, and neither
 *   answers 500.
 * - **The key** — the lock lands in `pg_locks` under the two-`int4` form with
 *   the folded key, asserted as literals; the vectors themselves are pinned in
 *   `scope_advisory_lock_key.test.ts`.
 *
 * Real `pg` only (`TEST_DATABASE_URL`): the in-memory drivers have one
 * connection, so a second transaction would queue behind the held one
 * whatever it locks. Twin of the Rust `fuz_auth` `tests/scope_teardown_races.rs`.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { wait } from '@fuzdev/fuz_util/async.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_test_app, type TestAccount, type TestApp } from '#lib/testing/test_app.ts';
import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import { rpc_call } from '#lib/testing/rpc_helpers.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { create_role_registry, ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import {
	ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
	ERROR_ROLE_GRANT_OFFER_TERMINAL
} from '#lib/auth/role_grant_offer_action_specs.ts';
import type { RoleGrantOfferCreateAuthorize } from '#lib/auth/role_grant_offer_actions.ts';
import {
	query_create_role_grant,
	query_role_grant_revoke_for_scope,
	type RevokeForScopeResult
} from '#lib/auth/role_grant_queries.ts';
import {
	query_accept_offer,
	query_role_grant_offer_create
} from '#lib/auth/role_grant_offer_queries.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import { auth_integration_truncate_tables } from '#lib/testing/db.ts';
import { create_describe_db } from '#lib/testing/describe_db.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import { Db, no_nested_transaction } from '#lib/db/db.ts';
import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';

import { pg_factory } from '../db_fixture.ts';
import { create_gated_db, type GatedDb } from '../gated_db.ts';

const RPC_PATH = '/api/rpc';

/** The admin-grantable role every scoped write here confers. */
const ROLE = 'scope_race_role';

/** The scope kind every scoped write here names. */
const SCOPE_KIND = 'race_scope';

/** The consumer's scope table the authorizer reads. */
const SCOPE_TABLE = 'scope_race_scope';

/** How long a lock wait the test arranged may take to show, a bound on a hang only. */
const LOCK_WAIT_DEADLINE_MS = 20_000;

const roles = create_role_registry([{ name: ROLE, grant_paths: ['admin'] }]);

/**
 * A consumer's scope-existence check: a scoped input is admitted only while
 * its scope row exists, read through the request transaction (`ctx.db`).
 */
const authorize: RoleGrantOfferCreateAuthorize = async (_auth, input, _deps, ctx) => {
	if (input.scope_id === null) return true;
	const rows = await ctx.db.query(`SELECT 1 FROM ${SCOPE_TABLE} WHERE id = $1`, [input.scope_id]);
	return rows.length > 0;
};

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_rpc_endpoint({
		notification_sender: ctx.deps.notification_sender,
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: create_standard_rpc_actions(ctx.deps, { roles, authorize }),
		log: ctx.deps.log
	});

type Answer = Awaited<ReturnType<typeof rpc_call>>;

const log = new Logger('scope_teardown_races');

/**
 * The fixture: `caller` (a global admin) assigns and offers to `recipient` at
 * live scopes; `keeper` removes.
 */
const setup = async (gated: GatedDb) => {
	const test_app: TestApp = await create_test_app({
		session_cookie_name: 'test_session',
		db: gated.db,
		create_route_specs
	});
	const db = test_app.backend.deps.db;
	await db.query(`CREATE TABLE IF NOT EXISTS ${SCOPE_TABLE} (id uuid PRIMARY KEY)`);
	const caller = await test_app.create_account({ username: 'scope_caller', roles: [ROLE_ADMIN] });
	const recipient = await test_app.create_account({ username: 'scope_recipient' });
	const create_scope = async (): Promise<Uuid> => {
		const id = create_uuid();
		await db.query(`INSERT INTO ${SCOPE_TABLE} (id) VALUES ($1)`, [id]);
		return id;
	};
	const call = (method: string, params: unknown, headers: Record<string, string>) =>
		rpc_call({ app: test_app.app, path: RPC_PATH, method, params, headers });
	const scoped = (scope_id: Uuid, to: TestAccount) => ({
		to_account_id: to.account.id,
		role: ROLE,
		scope_kind: SCOPE_KIND,
		scope_id
	});
	const assign = (scope_id: Uuid, to: TestAccount = recipient) =>
		call('role_grant_assign', scoped(scope_id, to), caller.create_session_headers());
	const offer_create = (scope_id: Uuid, to: TestAccount = recipient) =>
		call('role_grant_offer_create', scoped(scope_id, to), caller.create_session_headers());
	const accept = (offer_id: Uuid) =>
		call('role_grant_offer_accept', { offer_id }, recipient.create_session_headers());
	/** A consumer's teardown: the cascade first, then the scope row. */
	const teardown = (scope_id: Uuid): Promise<RevokeForScopeResult> =>
		db.transaction(async (tx) => {
			const result = await query_role_grant_revoke_for_scope(
				{ db: tx },
				scope_id,
				caller.actor.id,
				'scope_destroyed'
			);
			await tx.query(`DELETE FROM ${SCOPE_TABLE} WHERE id = $1`, [scope_id]);
			return result;
		});
	const del = (account_id: Uuid) =>
		call('account_delete', { account_id }, test_app.create_session_headers());
	const purge = (account_id: Uuid) =>
		rpc_call({
			app: test_app.app,
			path: RPC_PATH,
			method: 'account_purge',
			params: { account_id, confirm: true },
			headers: test_app.create_daemon_token_headers(),
			suppress_default_origin: true
		});
	const count = async (sql: string, params: Array<unknown>): Promise<number> =>
		Number((await db.query<{ n: string }>(sql, params))[0]!.n);
	/** Unrevoked grants at `scope_id`. */
	const active_grants = (scope_id: Uuid) =>
		count(`SELECT COUNT(*) AS n FROM role_grant WHERE scope_id = $1 AND revoked_at IS NULL`, [
			scope_id
		]);
	/** Pending offers at `scope_id`. */
	const pending_offers = (scope_id: Uuid) =>
		count(
			`SELECT COUNT(*) AS n FROM role_grant_offer
			 WHERE scope_id = $1 AND accepted_at IS NULL AND declined_at IS NULL
			   AND retracted_at IS NULL AND superseded_at IS NULL`,
			[scope_id]
		);
	/** Grants and offers at `scope_id`, of any state. */
	const rows_at = async (scope_id: Uuid) =>
		(await count(`SELECT COUNT(*) AS n FROM role_grant WHERE scope_id = $1`, [scope_id])) +
		(await count(`SELECT COUNT(*) AS n FROM role_grant_offer WHERE scope_id = $1`, [scope_id]));
	/** Audit rows of `event_type` and `outcome` naming `scope_id` in their metadata. */
	const audit_rows = (event_type: string, outcome: 'success' | 'failure', scope_id: Uuid) =>
		count(
			`SELECT COUNT(*) AS n FROM audit_log
			 WHERE event_type = $1 AND outcome = $2 AND metadata->>'scope_id' = $3`,
			[event_type, outcome, scope_id]
		);
	/** A pending offer from `caller` to `recipient` at a new live scope. */
	const offer_at_new_scope = async (): Promise<{ scope_id: Uuid; offer_id: Uuid }> => {
		const scope_id = await create_scope();
		const made = await offer_create(scope_id);
		assert_ok(made, 'the offer');
		assert.ok(made.ok);
		return { scope_id, offer_id: (made.result as { offer: { id: Uuid } }).offer.id };
	};
	const cleanup = async (): Promise<void> => {
		await db.query(`DROP TABLE IF EXISTS ${SCOPE_TABLE}`);
		await test_app.cleanup();
	};
	return {
		test_app,
		caller,
		recipient,
		db,
		create_scope,
		assign,
		offer_create,
		accept,
		teardown,
		del,
		purge,
		active_grants,
		pending_offers,
		rows_at,
		audit_rows,
		offer_at_new_scope,
		cleanup
	};
};

type Setup = Awaited<ReturnType<typeof setup>>;

const assert_ok = (answer: Answer, label: string): void => {
	assert.ok(answer.ok, `${label}: ${JSON.stringify(answer)}`);
};

/** The refusal a write authorized against a torn-down scope gets. */
const assert_not_authorized = (answer: Answer, label: string): void => {
	assert.ok(!answer.ok, `${label} is refused: ${JSON.stringify(answer)}`);
	assert.strictEqual(answer.status, 403, label);
	assert.strictEqual(answer.error.code, JSONRPC_ERROR_CODES.forbidden, label);
	assert.deepStrictEqual(
		answer.error.data,
		{ reason: ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED },
		label
	);
};

/** No deadlock (40P01) or other server error: an answer, refusal or not, below 500. */
const assert_no_server_error = (answer: Answer, label: string): void => {
	assert.ok(
		answer.ok || answer.status < 500,
		`${label} answers below 500: ${JSON.stringify(answer)}`
	);
};

/**
 * Backends waiting on a lock `holder_pid` holds — scoped to the held
 * transaction, so another session's lock wait can't pass for the second's.
 */
const blocked_by = async (db: Db, holder_pid: number): Promise<number> =>
	Number(
		(
			await db.query<{ n: string }>(
				`SELECT COUNT(*) AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
				[holder_pid]
			)
		)[0]!.n
	);

/**
 * Run `second` and wait until it waits on a lock `holder_pid` holds, or has
 * settled without waiting. Returns whether it waited, and its promise.
 */
const start_second = async <B>(
	db: Db,
	holder_pid: number,
	second: () => Promise<B>
): Promise<{ waited: boolean; result: Promise<B> }> => {
	const state = { settled: false };
	const result = second();
	result.then(
		() => (state.settled = true),
		() => (state.settled = true)
	);
	const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
	while (!state.settled) {
		if ((await blocked_by(db, holder_pid)) >= 1) return { waited: true, result };
		assert.ok(Date.now() < deadline, 'the second neither waited nor answered');
		await wait(5);
	}
	return { waited: false, result };
};

/**
 * Hold `first` at its commit, start `second`, and release the commit once
 * `second` waits on a lock the held transaction holds — or, failing the case,
 * once it has answered without waiting. Returns both answers and whether
 * `second` waited.
 */
const race = async <A, B>(
	gated: GatedDb,
	db: Db,
	first: () => Promise<A>,
	second: () => Promise<B>
): Promise<{ first: A; second: B; waited: boolean }> => {
	const held = gated.hold_commit();
	const a = first();
	await held.reached;
	const [holder] = await (await held.transaction).query<{ pid: number }>(
		'SELECT pg_backend_pid() AS pid'
	);
	let started: { waited: boolean; result: Promise<B> };
	try {
		started = await start_second(db, holder!.pid, second);
	} finally {
		// released on a failure too, so no later test waits on its lock
		held.release();
	}
	return { first: await a, second: await started.result, waited: started.waited };
};

/**
 * Run `fn` in a transaction of `db` that pauses right after the first
 * statement matching `match` has run, holding what it locked, until released.
 */
const pause_after = <T>(db: Db, match: (sql: string) => boolean, fn: (tx: Db) => Promise<T>) => {
	const reached = Promise.withResolvers<number>();
	const held = Promise.withResolvers<void>();
	let armed = true;
	const result = db.transaction(async (inner) => {
		const [row] = await inner.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
		const tx = new Db({
			client: {
				query: async <R>(text: string, values?: Array<unknown>) => {
					const answer = await inner.client.query<R>(text, values);
					if (armed && match(text)) {
						armed = false;
						reached.resolve(row!.pid);
						await held.promise;
					}
					return answer;
				}
			},
			transaction: no_nested_transaction
		});
		return fn(tx);
	});
	// a transaction failed before it paused must not leave `reached` waiting
	result.catch((err: unknown) => reached.reject(err));
	return { reached: reached.promise, release: held.resolve, result };
};

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

describe_pg(
	'a scope teardown held: a write authorized against the scope waits, then is refused',
	(get_db) => {
		install_audit_drift_guard();

		test('an assign waits on an uncommitted teardown, then answers 403, writing nothing', async () => {
			const gated = create_gated_db(get_db());
			const s = await setup(gated);
			try {
				const scope_id = await s.create_scope();
				const r = await race(
					gated,
					s.db,
					() => s.teardown(scope_id),
					() => s.assign(scope_id)
				);
				assert.ok(r.waited, 'the assign waits on the teardown');
				assert_not_authorized(r.second, 'the assign that waited');
				assert.strictEqual(await s.rows_at(scope_id), 0, 'no grant at the dead scope');
				assert.strictEqual(await s.audit_rows('role_grant_create', 'success', scope_id), 0);
				assert.strictEqual(
					await s.audit_rows('role_grant_create', 'failure', scope_id),
					1,
					'the refusal is audited'
				);
			} finally {
				await s.cleanup();
			}
		});

		test('an offer create waits on an uncommitted teardown, then answers 403, writing nothing', async () => {
			const gated = create_gated_db(get_db());
			const s = await setup(gated);
			try {
				const scope_id = await s.create_scope();
				const r = await race(
					gated,
					s.db,
					() => s.teardown(scope_id),
					() => s.offer_create(scope_id)
				);
				assert.ok(r.waited, 'the offer create waits on the teardown');
				assert_not_authorized(r.second, 'the offer create that waited');
				assert.strictEqual(await s.rows_at(scope_id), 0, 'no offer at the dead scope');
				assert.strictEqual(await s.audit_rows('role_grant_offer_create', 'success', scope_id), 0);
				assert.strictEqual(
					await s.audit_rows('role_grant_offer_create', 'failure', scope_id),
					1,
					'the refusal is audited'
				);
			} finally {
				await s.cleanup();
			}
		});

		test('an accept waits on an uncommitted teardown, then finds its offer superseded', async () => {
			const gated = create_gated_db(get_db());
			const s = await setup(gated);
			try {
				const { scope_id, offer_id } = await s.offer_at_new_scope();
				const r = await race(
					gated,
					s.db,
					() => s.teardown(scope_id),
					() => s.accept(offer_id)
				);
				assert.ok(r.waited, 'the accept waits on the teardown');
				assert.ok(!r.second.ok, `the accept is refused: ${JSON.stringify(r.second)}`);
				assert.strictEqual(r.second.error.code, JSONRPC_ERROR_CODES.invalid_request);
				assert.deepStrictEqual(r.second.error.data, { reason: ERROR_ROLE_GRANT_OFFER_TERMINAL });
				assert.deepStrictEqual(
					r.first.superseded_offers.map((o) => o.id),
					[offer_id]
				);
				assert.strictEqual(await s.active_grants(scope_id), 0, 'no grant at the dead scope');
			} finally {
				await s.cleanup();
			}
		});
	}
);

describe_pg('a write held: the teardown waits, then ends what it wrote', (get_db) => {
	install_audit_drift_guard();

	test('a teardown waits on an uncommitted assign, then revokes its grant', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const scope_id = await s.create_scope();
			const r = await race(
				gated,
				s.db,
				() => s.assign(scope_id),
				() => s.teardown(scope_id)
			);
			assert_ok(r.first, 'the assign');
			assert.ok(r.waited, 'the teardown waits on the assign');
			assert.strictEqual(r.second.revoked.length, 1, 'the teardown revokes the grant');
			assert.strictEqual(await s.active_grants(scope_id), 0);
		} finally {
			await s.cleanup();
		}
	});

	test('a teardown waits on an uncommitted offer create, then supersedes the offer', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const scope_id = await s.create_scope();
			const r = await race(
				gated,
				s.db,
				() => s.offer_create(scope_id),
				() => s.teardown(scope_id)
			);
			assert_ok(r.first, 'the offer create');
			assert.ok(r.waited, 'the teardown waits on the offer create');
			assert.strictEqual(r.second.superseded_offers.length, 1, 'the teardown supersedes it');
			assert.strictEqual(await s.pending_offers(scope_id), 0);
		} finally {
			await s.cleanup();
		}
	});

	test('a teardown waits on an uncommitted accept, then revokes its grant', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const { scope_id, offer_id } = await s.offer_at_new_scope();
			const r = await race(
				gated,
				s.db,
				() => s.accept(offer_id),
				() => s.teardown(scope_id)
			);
			assert_ok(r.first, 'the accept');
			assert.ok(r.waited, 'the teardown waits on the accept');
			assert.strictEqual(r.second.revoked.length, 1, "the teardown revokes the accept's grant");
			assert.strictEqual(await s.active_grants(scope_id), 0);
		} finally {
			await s.cleanup();
		}
	});

	// No handler around the query: the lock the query takes itself is all that
	// orders it.
	test('a teardown waits on an uncommitted direct query_create_role_grant, then revokes it', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const scope_id = await s.create_scope();
			const r = await race(
				gated,
				s.db,
				() =>
					s.db.transaction((tx) =>
						query_create_role_grant(
							{ db: tx },
							{
								actor_id: s.recipient.actor.id,
								role: ROLE,
								scope_kind: SCOPE_KIND,
								scope_id,
								granted_by: s.caller.actor.id
							}
						)
					),
				() => s.teardown(scope_id)
			);
			assert.ok(r.waited, 'the teardown waits on the grant');
			assert.deepStrictEqual(
				r.second.revoked.map((g) => g.role_grant_id),
				[r.first.id]
			);
			assert.strictEqual(await s.active_grants(scope_id), 0);
		} finally {
			await s.cleanup();
		}
	});

	test('a teardown waits on an uncommitted direct query_role_grant_offer_create, then supersedes it', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const scope_id = await s.create_scope();
			const r = await race(
				gated,
				s.db,
				() =>
					s.db.transaction((tx) =>
						query_role_grant_offer_create(
							{ db: tx },
							{
								from_actor_id: s.caller.actor.id,
								to_account_id: s.recipient.account.id,
								role: ROLE,
								scope_kind: SCOPE_KIND,
								scope_id,
								expires_at: new Date(Date.now() + 60_000)
							}
						)
					),
				() => s.teardown(scope_id)
			);
			assert.ok(r.waited, 'the teardown waits on the offer');
			assert.deepStrictEqual(
				r.second.superseded_offers.map((o) => o.id),
				[r.first.id]
			);
			assert.strictEqual(await s.pending_offers(scope_id), 0);
		} finally {
			await s.cleanup();
		}
	});
});

describe_pg('an accept in flight against a teardown: no cycle', (get_db) => {
	install_audit_drift_guard();

	const accept_direct = (s: Setup, tx: Db, offer_id: Uuid) =>
		query_accept_offer(
			{ db: tx, log },
			{
				offer_id,
				to_account_id: s.recipient.account.id,
				actor_id: s.recipient.actor.id,
				ip: null
			}
		);

	const is_claim = (sql: string): boolean => sql.includes('FOR UPDATE OF o');
	const is_exclusive_scope_lock = (sql: string): boolean =>
		sql.includes('pg_advisory_xact_lock($1, $2)');

	// The accept holds its claimed offer; a teardown that starts then must wait
	// at the scope lock the accept took before its claim, not take the lock and
	// then wait on the offer while the accept waits on the lock at its insert.
	test('a teardown waits on an accept paused after its claim; both commit', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const { scope_id, offer_id } = await s.offer_at_new_scope();
			const paused = pause_after(s.db, is_claim, (tx) => accept_direct(s, tx, offer_id));
			const pid = await paused.reached;
			let started: { waited: boolean; result: Promise<RevokeForScopeResult> };
			try {
				started = await start_second(s.db, pid, () => s.teardown(scope_id));
			} finally {
				paused.release();
			}
			const accepted = await paused.result;
			const torn_down = await started.result;
			assert.ok(started.waited, 'the teardown waits on the accept');
			assert.ok(accepted.created, 'the accept mints its grant');
			assert.deepStrictEqual(
				torn_down.revoked.map((g) => g.role_grant_id),
				[accepted.role_grant.id]
			);
			assert.strictEqual(await s.active_grants(scope_id), 0);
		} finally {
			await s.cleanup();
		}
	});

	// The teardown holds the scope lock and no offer yet; an accept that starts
	// then must wait at the scope lock, not claim the offer the teardown locks
	// next and then wait on the lock at its insert.
	test('an accept waits on a teardown paused after its scope lock, then finds its offer superseded', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const { scope_id, offer_id } = await s.offer_at_new_scope();
			const paused = pause_after(s.db, is_exclusive_scope_lock, (tx) =>
				query_role_grant_revoke_for_scope({ db: tx }, scope_id, null, 'scope_destroyed')
			);
			const pid = await paused.reached;
			let started: { waited: boolean; result: Promise<unknown> };
			try {
				started = await start_second(s.db, pid, () =>
					s.db.transaction((tx) => accept_direct(s, tx, offer_id))
				);
			} finally {
				paused.release();
			}
			const torn_down = await paused.result;
			assert.ok(started.waited, 'the accept waits on the teardown');
			assert.deepStrictEqual(
				torn_down.superseded_offers.map((o) => o.id),
				[offer_id]
			);
			const accepted = await started.result.then(
				() => 'accepted',
				(err: unknown) => (err instanceof Error ? err.constructor.name : String(err))
			);
			assert.strictEqual(accepted, 'RoleGrantOfferAlreadyTerminalError');
			assert.strictEqual(await s.active_grants(scope_id), 0);
		} finally {
			await s.cleanup();
		}
	});
});

describe_pg('a teardown of one scope holds no write at another', (get_db) => {
	install_audit_drift_guard();

	test('an assign at scope B answers while a teardown of scope A is uncommitted', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const scope_a = await s.create_scope();
			const scope_b = await s.create_scope();
			const r = await race(
				gated,
				s.db,
				() => s.teardown(scope_a),
				() => s.assign(scope_b)
			);
			assert.ok(!r.waited, 'the assign at another scope does not wait');
			assert_ok(r.second, 'the assign at scope B');
			assert.strictEqual(await s.active_grants(scope_b), 1);
		} finally {
			await s.cleanup();
		}
	});

	test('an offer create at scope B answers while a teardown of scope A is uncommitted', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const scope_a = await s.create_scope();
			const scope_b = await s.create_scope();
			const r = await race(
				gated,
				s.db,
				() => s.teardown(scope_a),
				() => s.offer_create(scope_b)
			);
			assert.ok(!r.waited, 'the offer create at another scope does not wait');
			assert_ok(r.second, 'the offer create at scope B');
			assert.strictEqual(await s.pending_offers(scope_b), 1);
		} finally {
			await s.cleanup();
		}
	});
});

describe_pg('writers at one scope share its lock', (get_db) => {
	install_audit_drift_guard();

	// Shared, not exclusive: two writes into one scope take turns with a
	// teardown only, never with each other.
	test('an offer create answers while an assign at the same scope is uncommitted', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const scope_id = await s.create_scope();
			const r = await race(
				gated,
				s.db,
				() => s.assign(scope_id),
				() => s.offer_create(scope_id)
			);
			assert_ok(r.first, 'the assign');
			assert.ok(!r.waited, 'the offer create does not wait on the assign');
			assert_ok(r.second, 'the offer create');
			assert.strictEqual(await s.active_grants(scope_id), 1);
			assert.strictEqual(await s.pending_offers(scope_id), 1);
		} finally {
			await s.cleanup();
		}
	});
});

describe_pg('the scope lock beside the other writers: no cycle', (get_db) => {
	install_audit_drift_guard();

	/**
	 * Play `a` and `b` in both orders, each built fresh per order: the second
	 * waits on the one held, and neither answers 500.
	 */
	const both_orders = async <A, B>(
		gated: GatedDb,
		s: Setup,
		label: string,
		a: (order: 0 | 1) => () => Promise<A>,
		b: (order: 0 | 1) => () => Promise<B>,
		check: (answer: A | B, label: string) => void
	): Promise<void> => {
		const a_first = await race(gated, s.db, a(0), b(0));
		check(a_first.first, `${label}: the first, held`);
		assert.ok(a_first.waited, `${label}: the second waits on the first`);
		check(a_first.second, `${label}: the second`);
		const b_first = await race(gated, s.db, b(1), a(1));
		check(b_first.first, `${label}, reversed: the first, held`);
		assert.ok(b_first.waited, `${label}, reversed: the second waits on the first`);
		check(b_first.second, `${label}, reversed: the second`);
	};

	/** An answer below 500, or a teardown's result. */
	const answered = (answer: Answer | RevokeForScopeResult, label: string): void => {
		if ('revoked' in answer) return;
		assert_no_server_error(answer, label);
	};

	/**
	 * Two scopes, each holding a grant of the recipient's and a pending offer to
	 * it — what a teardown and a removal or revoke of the recipient both reach.
	 */
	const two_scopes_reaching_the_recipient = async (s: Setup): Promise<[Uuid, Uuid]> => {
		const scopes: Array<Uuid> = [];
		for (let i = 0; i < 2; i++) {
			const { scope_id } = await s.offer_at_new_scope();
			await query_create_role_grant(
				{ db: s.db },
				{
					actor_id: s.recipient.actor.id,
					role: ROLE,
					scope_kind: SCOPE_KIND,
					scope_id,
					granted_by: s.caller.actor.id
				}
			);
			scopes.push(scope_id);
		}
		return scopes as [Uuid, Uuid];
	};

	for (const removal of ['delete', 'purge'] as const) {
		test(`a teardown and a ${removal} of the recipient commit in either order`, async () => {
			const gated = create_gated_db(get_db());
			const s = await setup(gated);
			try {
				const scopes = await two_scopes_reaching_the_recipient(s);
				// a second recipient for the second order, the first one being gone
				const second: TestAccount = await s.test_app.create_account({
					username: 'scope_recipient_two'
				});
				const targets = [s.recipient, second] as const;
				// the second recipient reaches the second scope too
				assert_ok(await s.offer_create(scopes[1], second), 'the offer to the second recipient');
				assert_ok(await s.assign(scopes[1], second), 'the grant to the second recipient');
				await both_orders(
					gated,
					s,
					`the teardown and the ${removal}`,
					(order) => () => s.teardown(scopes[order]),
					(order) => () => {
						const id = targets[order].account.id;
						return removal === 'delete' ? s.del(id) : s.purge(id);
					},
					answered
				);
			} finally {
				await s.cleanup();
			}
		});
	}

	test("a teardown and a revoke of the recipient's grant at the scope commit in either order", async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated);
		try {
			const scopes = await two_scopes_reaching_the_recipient(s);
			const grant_ids = await Promise.all(
				scopes.map(
					async (scope_id) =>
						(
							await s.db.query<{ id: Uuid }>(
								`SELECT id FROM role_grant WHERE scope_id = $1 AND actor_id = $2`,
								[scope_id, s.recipient.actor.id]
							)
						)[0]!.id
				)
			);
			await both_orders(
				gated,
				s,
				'the teardown and the revoke',
				(order) => () => s.teardown(scopes[order]),
				(order) => () =>
					rpc_call({
						app: s.test_app.app,
						path: RPC_PATH,
						method: 'role_grant_revoke',
						params: { actor_id: s.recipient.actor.id, role_grant_id: grant_ids[order] },
						headers: s.test_app.create_session_headers()
					}),
				answered
			);
		} finally {
			await s.cleanup();
		}
	});

	for (const removal of ['delete', 'purge'] as const) {
		for (const write of ['assign', 'offer create'] as const) {
			test(`a scoped ${write} and a ${removal} of its recipient commit in either order`, async () => {
				const gated = create_gated_db(get_db());
				const s = await setup(gated);
				try {
					const scope_id = await s.create_scope();
					// one recipient per order, the first one being gone for the second
					const targets = [
						s.recipient,
						await s.test_app.create_account({ username: 'scope_recipient_two' })
					] as const;
					await both_orders(
						gated,
						s,
						`the ${write} and the ${removal}`,
						(order) => () =>
							write === 'assign'
								? s.assign(scope_id, targets[order])
								: s.offer_create(scope_id, targets[order]),
						(order) => () =>
							removal === 'delete'
								? s.del(targets[order].account.id)
								: s.purge(targets[order].account.id),
						answered
					);
				} finally {
					await s.cleanup();
				}
			});
		}
	}
});

describe_pg('the scope lock key', (get_db) => {
	test('lands in pg_locks as the two-int4 form, the folded key', async () => {
		const db = get_db();
		const scope_id = '019a8f2e-4b3c-7d10-9e2f-3a4b5c6d7e8f' as Uuid;
		const rows = await db.transaction(async (tx) => {
			await query_role_grant_revoke_for_scope({ db: tx }, scope_id, null);
			return tx.query<{ classid: string; objid: string; objsubid: number; mode: string }>(
				`SELECT classid::text AS classid, objid::text AS objid, objsubid, mode FROM pg_locks
				 WHERE locktype = 'advisory' AND pid = pg_backend_pid()`
			);
		});
		assert.deepStrictEqual(rows, [
			{
				// literals, not the function under test: `oid` columns read the
				// `int4` halves unsigned — `fuzs` (0x66757a73) and the fold,
				// 0x88e4b6fa
				classid: '1718975091',
				objid: '2296690426',
				objsubid: 2,
				mode: 'ExclusiveLock'
			}
		]);
	});
});
