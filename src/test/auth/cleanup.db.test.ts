/**
 * Tests for `auth/cleanup.ts` — the consumer-facing periodic sweep.
 *
 * Covers:
 * - `cleanup_expired_role_grant_offers` emits one `role_grant_offer_expire` audit
 *   row per swept offer and returns the count, stamping `expire_audited_at`.
 * - A second run audits nothing — each expiry is audited exactly once.
 * - Terminal offers past their expiry are never swept or stamped.
 * - A re-offer clears the stamp, so the refreshed offer's expiry is audited
 *   again under the same `offer_id`.
 * - A failed audit insert rolls the stamps back and the next run retries.
 * - `run_auth_cleanup` runs both session + offer sweeps and returns both
 *   counts in one pass, closing for the session it swept; a second pass
 *   sweeps and closes nothing.
 * - An `on_audit_event` callback that throws on one row does not starve the
 *   rest — subsequent rows still land.
 *
 * The session sweep's own cases — what it closes, when, and on a failed
 * commit — are `cleanup.sessions.db.test.ts`; the scheduler's are
 * `cleanup.schedule.test.ts`. Twin of the Rust spine's `fuz_auth`
 * `tests/auth_cleanup.rs`.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { query_create_account_with_actor } from '$lib/auth/account_queries.ts';
import { query_role_grant_offer_create } from '$lib/auth/role_grant_offer_queries.ts';
import { query_audit_log_list } from '$lib/auth/audit_log_queries.ts';
import {
	cleanup_expired_role_grant_offers,
	run_auth_cleanup,
	type AuthCleanupDeps
} from '$lib/auth/cleanup.ts';
import { hash_session_token, query_create_session } from '$lib/auth/session_queries.ts';
import type { AuditLogEvent } from '$lib/auth/audit_log_schema.ts';
import { create_audit_emitter, type AuditEmitter } from '$lib/auth/audit_emitter.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import { Db, no_nested_transaction } from '$lib/db/db.ts';
import { noop_connection_closer } from '$lib/actions/connection_closer.ts';
import {
	assert_close_call,
	create_recording_closer
} from '$lib/testing/connection_closer_helpers.ts';

import { describe_db } from '../db_fixture.ts';

const log = new Logger('cleanup-test', { level: 'off' });

/**
 * Build a real `AuditEmitter` over the test pool with a one-shot `notify`
 * subscriber so the assertions can observe fan-out exactly the way
 * production does.
 */
const create_audit_with_listener = (
	db: Db,
	on_event: (event: AuditLogEvent) => void
): AuditEmitter => create_audit_emitter({ db, log, on_audit_event: on_event });
const hour_ms = 60 * 60 * 1000;
const past = (ms_ago: number): Date => new Date(Date.now() - ms_ago);
const future = (ms_from_now: number): Date => new Date(Date.now() + ms_from_now);

interface TestAccounts {
	grantor_actor_id: Uuid;
	recipient_account_id: Uuid;
	recipient_actor_id: Uuid;
	recipient_account_id_2: Uuid;
}

const seed_accounts = async (db: Db): Promise<TestAccounts> => {
	const { actor: grantor_actor } = await query_create_account_with_actor(
		{ db },
		{ username: 'cleanup_grantor', password_hash: 'hash' }
	);
	const { account: recipient_account, actor: recipient_actor } =
		await query_create_account_with_actor(
			{ db },
			{ username: 'cleanup_recipient', password_hash: 'hash' }
		);
	const { account: recipient_account_2 } = await query_create_account_with_actor(
		{ db },
		{ username: 'cleanup_recipient_2', password_hash: 'hash' }
	);
	return {
		grantor_actor_id: grantor_actor.id,
		recipient_account_id: recipient_account.id,
		recipient_actor_id: recipient_actor.id,
		recipient_account_id_2: recipient_account_2.id
	};
};

/** Insert a pending offer with an explicit `expires_at`. */
const insert_offer = (
	db: Db,
	grantor_actor_id: Uuid,
	recipient_account_id: Uuid,
	expires_at: Date,
	role = 'teacher'
) =>
	query_role_grant_offer_create(
		{ db },
		{
			from_actor_id: grantor_actor_id,
			to_account_id: recipient_account_id,
			role,
			scope_id: null,
			message: null,
			expires_at
		}
	);

describe_db('auth_cleanup', (get_db) => {
	test('cleanup_expired_role_grant_offers emits one audit row per swept offer and returns count', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);

		// Two expired offers, one fresh — sweep should only audit the two.
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			past(hour_ms),
			'teacher'
		);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id_2,
			past(hour_ms),
			'moderator'
		);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			future(hour_ms),
			'admin'
		);

		const callback_events: Array<AuditLogEvent> = [];
		const deps: AuthCleanupDeps = {
			db,
			log,
			connection_closer: noop_connection_closer,
			audit: create_audit_with_listener(db, (event) => {
				callback_events.push(event);
			})
		};

		const count = await cleanup_expired_role_grant_offers(deps);
		assert.strictEqual(count, 2);

		// Two audit rows, both `role_grant_offer_expire`, callback fired twice.
		const rows = await query_audit_log_list({ db }, { event_type: 'role_grant_offer_expire' });
		assert.strictEqual(rows.length, 2);
		for (const row of rows) {
			assert.strictEqual(row.event_type, 'role_grant_offer_expire');
			assert.strictEqual(row.actor_id, accounts.grantor_actor_id);
		}
		assert.strictEqual(callback_events.length, 2);

		// The two expired offers are stamped, the fresh one is not.
		const stamps = await db.query<{ expire_audited_at: string | null }>(
			'SELECT expire_audited_at FROM role_grant_offer'
		);
		assert.strictEqual(stamps.length, 3);
		assert.strictEqual(stamps.filter((r) => r.expire_audited_at !== null).length, 2);
	});

	test('a second cleanup_expired_role_grant_offers run audits nothing', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			past(hour_ms),
			'teacher'
		);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id_2,
			past(hour_ms),
			'moderator'
		);

		const callback_events: Array<AuditLogEvent> = [];
		const deps: AuthCleanupDeps = {
			db,
			log,
			connection_closer: noop_connection_closer,
			audit: create_audit_with_listener(db, (event) => {
				callback_events.push(event);
			})
		};

		assert.strictEqual(await cleanup_expired_role_grant_offers(deps), 2);
		assert.strictEqual(await cleanup_expired_role_grant_offers(deps), 0);

		const rows = await query_audit_log_list({ db }, { event_type: 'role_grant_offer_expire' });
		assert.strictEqual(rows.length, 2);
		assert.strictEqual(callback_events.length, 2);
	});

	test('terminal offers past their expiry are never swept or stamped', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);
		const roles = ['teacher', 'moderator', 'admin', 'editor'];
		const offers = [];
		for (const role of roles) {
			offers.push(
				await insert_offer(
					db,
					accounts.grantor_actor_id,
					accounts.recipient_account_id,
					past(hour_ms),
					role
				)
			);
		}
		const grant = await db.query_one<{ id: Uuid }>(
			`INSERT INTO role_grant (actor_id, role) VALUES ($1, 'teacher') RETURNING id`,
			[accounts.recipient_actor_id]
		);
		assert.ok(grant);
		await db.query(
			'UPDATE role_grant_offer SET accepted_at = NOW(), resulting_role_grant_id = $2 WHERE id = $1',
			[offers[0]!.id, grant.id]
		);
		await db.query(
			`UPDATE role_grant_offer SET declined_at = NOW(), decline_reason = 'no' WHERE id = $1`,
			[offers[1]!.id]
		);
		await db.query('UPDATE role_grant_offer SET retracted_at = NOW() WHERE id = $1', [
			offers[2]!.id
		]);
		await db.query('UPDATE role_grant_offer SET superseded_at = NOW() WHERE id = $1', [
			offers[3]!.id
		]);

		const count = await cleanup_expired_role_grant_offers({
			db,
			log,
			connection_closer: noop_connection_closer,
			audit: create_audit_with_listener(db, () => undefined)
		});
		assert.strictEqual(count, 0);

		const stamped = await db.query<{ id: Uuid }>(
			'SELECT id FROM role_grant_offer WHERE expire_audited_at IS NOT NULL'
		);
		assert.strictEqual(stamped.length, 0);
		const rows = await query_audit_log_list({ db }, { event_type: 'role_grant_offer_expire' });
		assert.strictEqual(rows.length, 0);
	});

	test('a re-offer clears the stamp so the refreshed expiry is audited again', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);
		const deps: AuthCleanupDeps = {
			db,
			log,
			connection_closer: noop_connection_closer,
			audit: create_audit_with_listener(db, () => undefined)
		};

		const first = await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			past(hour_ms)
		);
		assert.strictEqual(await cleanup_expired_role_grant_offers(deps), 1);

		// The expired row is still pending, so the same-tuple re-offer upserts
		// it — same id, refreshed expiry, stamp cleared.
		const reoffered = await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			future(hour_ms)
		);
		assert.strictEqual(reoffered.id, first.id);
		assert.strictEqual(reoffered.expire_audited_at, null);
		assert.strictEqual(await cleanup_expired_role_grant_offers(deps), 0);

		await db.query(
			`UPDATE role_grant_offer SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
			[first.id]
		);
		assert.strictEqual(await cleanup_expired_role_grant_offers(deps), 1);

		const rows = await query_audit_log_list({ db }, { event_type: 'role_grant_offer_expire' });
		assert.strictEqual(rows.length, 2);
		for (const row of rows) {
			assert.strictEqual(row.metadata?.offer_id, first.id);
		}
	});

	test('a failed audit insert rolls the stamps back and the next run retries', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);
		await insert_offer(db, accounts.grantor_actor_id, accounts.recipient_account_id, past(hour_ms));
		const callback_events: Array<AuditLogEvent> = [];
		const deps: AuthCleanupDeps = {
			db,
			log,
			connection_closer: noop_connection_closer,
			audit: create_audit_with_listener(db, (event) => {
				callback_events.push(event);
			})
		};

		// A `Db` whose transactions refuse the audit insert — driver-agnostic
		// failure injection (pglet has no triggers).
		const refusing_db = new Db({
			client: db.client,
			transaction: (fn) =>
				db.transaction((tx) =>
					fn(
						new Db({
							client: {
								query: (text, values) =>
									text.includes('INSERT INTO audit_log')
										? Promise.reject(new Error('synthetic audit failure'))
										: tx.client.query(text, values)
							},
							transaction: no_nested_transaction
						})
					)
				)
		});
		let threw = false;
		try {
			await cleanup_expired_role_grant_offers({ ...deps, db: refusing_db });
		} catch {
			threw = true;
		}
		assert.ok(threw, 'the audit failure propagates');
		const stamped = await db.query<{ id: Uuid }>(
			'SELECT id FROM role_grant_offer WHERE expire_audited_at IS NOT NULL'
		);
		assert.strictEqual(stamped.length, 0, 'the claim rolled back with the audit insert');
		assert.strictEqual(callback_events.length, 0, 'nothing fans out from a rolled-back sweep');

		assert.strictEqual(await cleanup_expired_role_grant_offers(deps), 1);
		assert.strictEqual(callback_events.length, 1);
	});

	test('cleanup_expired_role_grant_offers with no expired rows is a no-op', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			future(hour_ms)
		);

		const callback_events: Array<AuditLogEvent> = [];
		const deps: AuthCleanupDeps = {
			db,
			log,
			connection_closer: noop_connection_closer,
			audit: create_audit_with_listener(db, (event) => {
				callback_events.push(event);
			})
		};

		const count = await cleanup_expired_role_grant_offers(deps);
		assert.strictEqual(count, 0);
		assert.strictEqual(callback_events.length, 0);

		const rows = await query_audit_log_list({ db }, { event_type: 'role_grant_offer_expire' });
		assert.strictEqual(rows.length, 0);
	});

	test('cleanup_expired_role_grant_offers isolates per-row on_audit_event exceptions', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);

		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			past(hour_ms),
			'teacher'
		);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id_2,
			past(hour_ms),
			'moderator'
		);

		let call_count = 0;
		const deps: AuthCleanupDeps = {
			db,
			log,
			connection_closer: noop_connection_closer,
			audit: create_audit_with_listener(db, () => {
				call_count += 1;
				if (call_count === 1) throw new Error('synthetic callback failure');
			})
		};

		const count = await cleanup_expired_role_grant_offers(deps);
		// Both rows still get audit-stamped; the thrown callback was logged
		// and swallowed, not propagated.
		assert.strictEqual(count, 2);
		assert.strictEqual(call_count, 2);

		const rows = await query_audit_log_list({ db }, { event_type: 'role_grant_offer_expire' });
		assert.strictEqual(rows.length, 2);
	});

	test('run_auth_cleanup sweeps sessions and offers, and closes for the session it swept', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);

		// One expired session beside a live one of the same account.
		const expired_session = hash_session_token('cleanup-expired');
		const live_session = hash_session_token('cleanup-live');
		await query_create_session(
			{ db },
			expired_session,
			accounts.recipient_account_id,
			past(hour_ms)
		);
		await query_create_session(
			{ db },
			live_session,
			accounts.recipient_account_id,
			future(hour_ms)
		);
		// Two expired offers.
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			past(hour_ms),
			'teacher'
		);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id_2,
			past(hour_ms),
			'moderator'
		);

		const { closer, calls } = create_recording_closer();
		const deps: AuthCleanupDeps = {
			db,
			log,
			connection_closer: closer,
			audit: create_audit_with_listener(db, () => undefined)
		};
		assert.deepEqual(await run_auth_cleanup(deps), { expired_sessions: 1, expired_offers: 2 });
		const remaining = await db.query<{ id: string }>('SELECT id FROM auth_session');
		assert.deepEqual(
			remaining.map((r) => r.id),
			[live_session]
		);
		assert.strictEqual(calls.length, 1, 'the pass closes for the session it swept, once');
		assert_close_call(calls[0], 'session', expired_session);

		// nothing left to sweep on a second pass, and nothing more to close
		assert.deepEqual(await run_auth_cleanup(deps), { expired_sessions: 0, expired_offers: 0 });
		assert.strictEqual(calls.length, 1);
	});
});
