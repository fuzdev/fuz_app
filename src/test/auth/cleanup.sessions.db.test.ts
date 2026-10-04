/**
 * Tests for the session sweep in `auth/cleanup.ts` — `cleanup_expired_sessions`.
 *
 * The sweep closes what it sweeps: a pass closes the connections of exactly
 * the sessions it deleted, by session id — never the account's other
 * sessions — and, on a successful pass, only once the delete has committed,
 * the rule every revocation close keeps. Without the close a swept session's
 * connections would have no per-session handle left (`account_session_revoke`
 * closes only for a row it deletes). A commit that fails still closes — the
 * sessions are expired either way — and the next pass deletes the rows it
 * left and closes again.
 *
 * Covers:
 * - One pass closes exactly the sessions it deleted, by id, across accounts —
 *   no account-wide or token close — and writes no audit row.
 * - A second pass closes nothing; a pass with nothing expired closes nothing.
 * - The closes run after the commit: held uncommitted (`create_gated_db`), the
 *   sweep has closed nothing; each close then sees no transaction open and,
 *   through the pool, its row gone.
 * - A sweep whose transaction fails once the delete has answered still closes,
 *   the delete rolls back, and the next pass deletes and closes again — on
 *   every driver through the gate, and on real Postgres with a deferred
 *   constraint trigger that refuses the `COMMIT` itself.
 * - A sweep whose delete fails closes nothing.
 * - A closer that throws for one session does not spare the rest.
 * - The close reaches both transports: a real `BackendWebsocketTransport`
 *   socket and a real audit-stream registry stream of the expired session end
 *   through the `RealtimeCloser`, while another session's — the same account's
 *   included — stay open.
 *
 * Twin of the session-sweep cases in the Rust spine's `fuz_auth`
 * `tests/auth_cleanup.rs` and `fuz_realtime` `tests/audit_stream.rs`.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { Logger, type LogConsole } from '@fuzdev/fuz_util/log.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import { query_create_account_with_actor } from '$lib/auth/account_queries.ts';
import { query_audit_log_list } from '$lib/auth/audit_log_queries.ts';
import { create_audit_emitter } from '$lib/auth/audit_emitter.ts';
import type { AuditLogEvent } from '$lib/auth/audit_log_schema.ts';
import { cleanup_expired_sessions, type AuthCleanupDeps } from '$lib/auth/cleanup.ts';
import { hash_session_token, query_create_session } from '$lib/auth/session_queries.ts';
import { create_realtime_closer, type ConnectionCloser } from '$lib/actions/connection_closer.ts';
import { BackendWebsocketTransport } from '$lib/actions/transports_ws_backend.ts';
import {
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SESSION_REVOKED_REASON
} from '$lib/actions/transports.ts';
import { create_audit_log_sse } from '$lib/realtime/sse_auth_guard.ts';
import type { SseNotification, SseStream } from '$lib/realtime/sse.ts';
import { Db, no_nested_transaction } from '$lib/db/db.ts';
import { create_describe_db, auth_integration_truncate_tables } from '$lib/testing/db.ts';
import { create_recording_closer } from '$lib/testing/connection_closer_helpers.ts';
import { create_fake_ws } from '$lib/testing/ws_round_trip.ts';

import { describe_db, pg_factory } from '../db_fixture.ts';
import { create_gated_db } from '../gated_db.ts';

const log = new Logger('cleanup-sessions-test', { level: 'off' });
const hour_ms = 60 * 60 * 1000;

interface TestAccounts {
	account_id: Uuid;
	other_account_id: Uuid;
}

const seed_accounts = async (db: Db): Promise<TestAccounts> => {
	const { account } = await query_create_account_with_actor(
		{ db },
		{ username: 'sweep_account', password_hash: 'hash' }
	);
	const { account: other } = await query_create_account_with_actor(
		{ db },
		{ username: 'sweep_other', password_hash: 'hash' }
	);
	return { account_id: account.id, other_account_id: other.id };
};

/**
 * Seed one `auth_session` row — an expired one an hour past its `expires_at`,
 * a live one an hour short of it — and return its id (the token hash
 * connections are registered under).
 */
const seed_session = async (
	db: Db,
	name: string,
	account_id: Uuid,
	expired: boolean
): Promise<string> => {
	const id = hash_session_token(name);
	await query_create_session(
		{ db },
		id,
		account_id,
		new Date(Date.now() + (expired ? -hour_ms : hour_ms))
	);
	return id;
};

/** The ids left in `auth_session`, sorted. */
const remaining_sessions = async (db: Db): Promise<Array<string>> =>
	(await db.query<{ id: string }>('SELECT id FROM auth_session')).map((r) => r.id).sort();

/** Cleanup deps over `db` closing through `connection_closer`, with no audit listener. */
const create_deps = (db: Db, connection_closer: ConnectionCloser): AuthCleanupDeps => ({
	db,
	log,
	audit: create_audit_emitter({ db, log }),
	connection_closer
});

/** The session ids a recording closer was asked to close, sorted — the delete returns ids in no order worth pinning. */
const closed_sessions = (calls: Array<{ method: string; id: string }>): Array<string> => {
	for (const call of calls) {
		assert.strictEqual(call.method, 'session', 'the sweep closes sessions only');
	}
	return calls.map((call) => call.id).sort();
};

const create_mock_stream = (): SseStream<SseNotification> & { closed: boolean } => {
	let closed = false;
	return {
		get closed() {
			return closed;
		},
		send() {},
		comment() {},
		close() {
			closed = true;
		},
		on_close() {}
	};
};

describe_db('cleanup_expired_sessions', (get_db) => {
	test('closes exactly the sessions it deletes, by session id, and writes no audit row', async () => {
		const db = get_db();
		const a = await seed_accounts(db);
		const expired_1 = await seed_session(db, 'sweep-expired-1', a.account_id, true);
		const expired_2 = await seed_session(db, 'sweep-expired-2', a.account_id, true);
		const live = await seed_session(db, 'sweep-live', a.account_id, false);
		const other_expired = await seed_session(db, 'sweep-other-expired', a.other_account_id, true);
		const other_live = await seed_session(db, 'sweep-other-live', a.other_account_id, false);

		const { closer, calls } = create_recording_closer();
		const audit_events: Array<AuditLogEvent> = [];
		const deps: AuthCleanupDeps = {
			db,
			log,
			audit: create_audit_emitter({ db, log, on_audit_event: (e) => audit_events.push(e) }),
			connection_closer: closer
		};

		assert.strictEqual(await cleanup_expired_sessions(deps), 3);
		assert.deepEqual(
			closed_sessions(calls),
			[expired_1, expired_2, other_expired].sort(),
			'one close per swept session, by session id, and nothing else'
		);
		assert.deepEqual(await remaining_sessions(db), [live, other_live].sort());
		// expiry is not an event anyone performed
		assert.deepEqual(await query_audit_log_list({ db }), []);
		assert.deepEqual(audit_events, []);
	});

	test('a second sweep closes nothing', async () => {
		const db = get_db();
		const a = await seed_accounts(db);
		const expired = await seed_session(db, 'sweep-expired', a.account_id, true);
		await seed_session(db, 'sweep-live', a.account_id, false);

		const { closer, calls } = create_recording_closer();
		const deps = create_deps(db, closer);
		assert.strictEqual(await cleanup_expired_sessions(deps), 1);
		assert.deepEqual(closed_sessions(calls), [expired]);

		assert.strictEqual(await cleanup_expired_sessions(deps), 0);
		assert.deepEqual(
			closed_sessions(calls),
			[expired],
			'the second pass swept nothing and closed nothing'
		);
	});

	test('no expired sessions closes nothing', async () => {
		const db = get_db();
		const a = await seed_accounts(db);
		const live = await seed_session(db, 'sweep-live', a.account_id, false);

		const { closer, calls } = create_recording_closer();
		assert.strictEqual(await cleanup_expired_sessions(create_deps(db, closer)), 0);
		assert.deepEqual(calls, []);
		assert.deepEqual(await remaining_sessions(db), [live]);
	});

	test('closes only after the delete commits', async () => {
		const db = get_db();
		const a = await seed_accounts(db);
		const expired_1 = await seed_session(db, 'sweep-expired-1', a.account_id, true);
		const expired_2 = await seed_session(db, 'sweep-expired-2', a.other_account_id, true);
		await seed_session(db, 'sweep-live', a.account_id, false);

		const gated = create_gated_db(db);
		/** One close, as the closer saw the world when it was called. */
		interface ProbedClose {
			id: string;
			/** Transactions open on the sweep's `Db`. */
			open_transactions: number;
			/** Rows a read through the pool, issued at the close, finds for the session. */
			rows_left: Promise<number>;
		}
		const closes: Array<ProbedClose> = [];
		const probe: ConnectionCloser = {
			close_sockets_for_session: (id) => {
				closes.push({
					id,
					open_transactions: gated.open_transactions(),
					rows_left: db
						.query('SELECT 1 FROM auth_session WHERE id = $1', [id])
						.then((rows) => rows.length)
				});
				return 0;
			},
			close_sockets_for_token: () => {
				throw new Error('the sweep closes sessions only');
			},
			close_sockets_for_account: () => {
				throw new Error('the sweep closes sessions only');
			}
		};

		// hold the sweep's transaction open with its delete done and uncommitted
		const hold = gated.hold_commit();
		const pass = cleanup_expired_sessions(create_deps(gated.db, probe));
		await hold.reached;
		const open_while_held = gated.open_transactions();
		const closed_while_held = closes.length;
		// released before asserting, so a failure here leaves no transaction open
		hold.release();
		assert.strictEqual(await pass, 2);
		assert.strictEqual(open_while_held, 1);
		assert.strictEqual(closed_while_held, 0, 'nothing is closed while the delete is uncommitted');
		assert.deepEqual(closes.map((c) => c.id).sort(), [expired_1, expired_2].sort());
		for (const close of closes) {
			assert.strictEqual(close.open_transactions, 0, 'the close ran outside the transaction');
			assert.strictEqual(await close.rows_left, 0, 'the close ran for a row already gone');
		}
	});

	test('a sweep whose transaction fails after the delete still closes, and the next pass retries', async () => {
		const db = get_db();
		const a = await seed_accounts(db);
		const expired = await seed_session(db, 'sweep-expired', a.account_id, true);
		const live = await seed_session(db, 'sweep-live', a.account_id, false);

		const gated = create_gated_db(db);
		const { closer, calls } = create_recording_closer();
		const deps = create_deps(gated.db, closer);

		// the delete has answered; failing the transaction here is what the
		// sweep sees when its `COMMIT` fails — a rejected transaction call whose
		// callback had returned, and the delete rolled back
		const hold = gated.hold_commit();
		const pass = cleanup_expired_sessions(deps);
		await hold.reached;
		hold.fail(new Error('synthetic commit failure'));
		await assert_rejects(() => pass, /synthetic commit failure/);

		assert.deepEqual(
			closed_sessions(calls),
			[expired],
			'the swept session is closed although its commit failed'
		);
		assert.deepEqual(
			await remaining_sessions(db),
			[expired, live].sort(),
			'the failed commit rolled the delete back'
		);

		assert.strictEqual(await cleanup_expired_sessions(deps), 1);
		assert.deepEqual(await remaining_sessions(db), [live]);
		assert.deepEqual(
			closed_sessions(calls),
			[expired, expired],
			'the next pass deletes the row and closes again, never the live session'
		);
	});

	test('a sweep whose delete fails closes nothing', async () => {
		const db = get_db();
		const a = await seed_accounts(db);
		const expired = await seed_session(db, 'sweep-expired', a.account_id, true);

		// a `Db` whose transactions refuse the delete — the ids were never read
		const refusing_db = new Db({
			client: db.client,
			transaction: (fn) =>
				db.transaction((tx) =>
					fn(
						new Db({
							client: {
								query: (text, values) =>
									text.includes('DELETE FROM auth_session')
										? Promise.reject(new Error('synthetic delete failure'))
										: tx.client.query(text, values)
							},
							transaction: no_nested_transaction
						})
					)
				)
		});
		const { closer, calls } = create_recording_closer();
		await assert_rejects(
			() => cleanup_expired_sessions(create_deps(refusing_db, closer)),
			/synthetic delete failure/
		);
		assert.deepEqual(calls, []);
		assert.deepEqual(await remaining_sessions(db), [expired]);
	});

	test('a closer that throws for one session still closes the rest', async () => {
		const db = get_db();
		const a = await seed_accounts(db);
		const expired_1 = await seed_session(db, 'sweep-expired-1', a.account_id, true);
		const expired_2 = await seed_session(db, 'sweep-expired-2', a.account_id, true);
		const expired_3 = await seed_session(db, 'sweep-expired-3', a.other_account_id, true);

		const errors: Array<Array<unknown>> = [];
		const recording_console: LogConsole = {
			error: (...args: Array<unknown>) => {
				errors.push(args);
			},
			warn: () => {},
			log: () => {}
		};
		const attempted: Array<string> = [];
		const boom = new Error('synthetic close failure');
		const throwing: ConnectionCloser = {
			close_sockets_for_session: (id) => {
				attempted.push(id);
				// the first one asked for, whichever the delete returned first
				if (attempted.length === 1) throw boom;
				return 0;
			},
			close_sockets_for_token: () => 0,
			close_sockets_for_account: () => 0
		};

		const swept = await cleanup_expired_sessions({
			...create_deps(db, throwing),
			log: new Logger('cleanup-sessions-test', { level: 'error', console: recording_console })
		});
		assert.strictEqual(swept, 3, 'the delete committed, so the count stands');
		assert.deepEqual([...attempted].sort(), [expired_1, expired_2, expired_3].sort());
		assert.strictEqual(errors.length, 1);
		assert.ok(
			errors[0]!.some((arg) => arg === boom),
			'the close failure is logged with its error'
		);
		assert.deepEqual(await remaining_sessions(db), []);
	});

	test('the socket and audit stream of the expired session end, and those of other sessions stay open', async () => {
		const db = get_db();
		const a = await seed_accounts(db);
		const expired = await seed_session(db, 'sweep-expired', a.account_id, true);
		const live = await seed_session(db, 'sweep-live', a.account_id, false);
		const other_live = await seed_session(db, 'sweep-other-live', a.other_account_id, false);

		// the closer a backend's revocation handlers hold: one `RealtimeCloser`
		// over a real WebSocket transport and a real audit stream registry
		const connection_closer = create_realtime_closer();
		const transport = new BackendWebsocketTransport({ log });
		connection_closer.add(transport);
		const audit_sse = create_audit_log_sse({ log, connection_closer });
		const connect = (session_token_hash: string, account_id: Uuid) => {
			const ws = create_fake_ws();
			transport.add_connection(ws.ws, session_token_hash, account_id);
			const stream = create_mock_stream();
			audit_sse.registry.subscribe(stream, { scope: session_token_hash, groups: [account_id] });
			return { ws, stream };
		};
		const on_expired = connect(expired, a.account_id);
		// the same account's live session, and another account's
		const on_live = connect(live, a.account_id);
		const on_other = connect(other_live, a.other_account_id);

		assert.strictEqual(await cleanup_expired_sessions(create_deps(db, connection_closer)), 1);

		assert.deepEqual(on_expired.ws.closes, [
			{ code: WS_CLOSE_SESSION_REVOKED, reason: WS_CLOSE_SESSION_REVOKED_REASON }
		]);
		assert.strictEqual(on_expired.stream.closed, true);
		for (const bystander of [on_live, on_other]) {
			assert.deepEqual(bystander.ws.closes, []);
			assert.strictEqual(bystander.stream.closed, false);
		}
		assert.strictEqual(transport.get_connection_count(), 2);
	});
});

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

// Real Postgres only: the trigger refuses the `COMMIT` statement itself, which
// the gate above can only stand in for (and pglet has no triggers). Skipped
// when `TEST_DATABASE_URL` is unset.
describe_pg('cleanup_expired_sessions with a refused COMMIT', (get_db) => {
	test('a sweep whose commit fails still closes, and the next pass retries', async () => {
		const db = get_db();
		const a = await seed_accounts(db);
		const expired = await seed_session(db, 'sweep-expired', a.account_id, true);
		const live = await seed_session(db, 'sweep-live', a.account_id, false);
		const { closer, calls } = create_recording_closer();
		const deps = create_deps(db, closer);

		// deferred, so the DELETE succeeds and the COMMIT is what fails
		await db.query(
			`CREATE FUNCTION cleanup_test_refuse_commit() RETURNS trigger AS $$
			   BEGIN RAISE EXCEPTION 'synthetic commit failure'; END;
			 $$ LANGUAGE plpgsql`
		);
		try {
			await db.query(
				`CREATE CONSTRAINT TRIGGER cleanup_test_refuse_commit
				   AFTER DELETE ON auth_session DEFERRABLE INITIALLY DEFERRED
				   FOR EACH ROW EXECUTE FUNCTION cleanup_test_refuse_commit()`
			);
			await assert_rejects(() => cleanup_expired_sessions(deps), /synthetic commit failure/);
		} finally {
			// the database outlives this file — leave no trigger behind
			await db.query('DROP TRIGGER IF EXISTS cleanup_test_refuse_commit ON auth_session');
			await db.query('DROP FUNCTION cleanup_test_refuse_commit()');
		}

		assert.deepEqual(
			closed_sessions(calls),
			[expired],
			'the swept session is closed although its commit failed'
		);
		assert.deepEqual(
			await remaining_sessions(db),
			[expired, live].sort(),
			'the failed commit rolled the delete back'
		);

		assert.strictEqual(await cleanup_expired_sessions(deps), 1);
		assert.deepEqual(await remaining_sessions(db), [live]);
		assert.deepEqual(
			closed_sessions(calls),
			[expired, expired],
			'the next pass deletes the row and closes again, never the live session'
		);
	});
});
