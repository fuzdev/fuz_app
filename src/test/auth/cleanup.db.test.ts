/**
 * Tests for `auth/cleanup.ts` — the consumer-facing periodic sweep.
 *
 * Covers:
 * - `cleanup_expired_permit_offers` emits one `permit_offer_expire` audit
 *   row per swept offer and returns the count.
 * - `run_auth_cleanup` runs both session + offer sweeps and returns both
 *   counts in one pass.
 * - An `on_audit_event` callback that throws on one row does not starve the
 *   rest — subsequent rows still land.
 *
 * @module
 */

import {assert, test} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {query_create_account_with_actor} from '$lib/auth/account_queries.js';
import {query_permit_offer_create} from '$lib/auth/permit_offer_queries.js';
import {query_audit_log_list} from '$lib/auth/audit_log_queries.js';
import {
	cleanup_expired_permit_offers,
	run_auth_cleanup,
	type AuthCleanupDeps,
} from '$lib/auth/cleanup.js';
import {hash_session_token, query_create_session} from '$lib/auth/session_queries.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';
import type {Uuid} from '$lib/uuid.js';
import type {Db} from '$lib/db/db.js';

import {describe_db} from '../db_fixture.js';

const log = new Logger('cleanup-test', {level: 'off'});
const hour_ms = 60 * 60 * 1000;
const past = (ms_ago: number): Date => new Date(Date.now() - ms_ago);
const future = (ms_from_now: number): Date => new Date(Date.now() + ms_from_now);

interface TestAccounts {
	grantor_actor_id: Uuid;
	recipient_account_id: Uuid;
	recipient_account_id_2: Uuid;
}

const seed_accounts = async (db: Db): Promise<TestAccounts> => {
	const {actor: grantor_actor} = await query_create_account_with_actor(
		{db},
		{username: 'cleanup_grantor', password_hash: 'hash'},
	);
	const {account: recipient_account} = await query_create_account_with_actor(
		{db},
		{username: 'cleanup_recipient', password_hash: 'hash'},
	);
	const {account: recipient_account_2} = await query_create_account_with_actor(
		{db},
		{username: 'cleanup_recipient_2', password_hash: 'hash'},
	);
	return {
		grantor_actor_id: grantor_actor.id,
		recipient_account_id: recipient_account.id,
		recipient_account_id_2: recipient_account_2.id,
	};
};

/** Insert a pending offer with an explicit `expires_at`. */
const insert_offer = (
	db: Db,
	grantor_actor_id: Uuid,
	recipient_account_id: Uuid,
	expires_at: Date,
	role = 'teacher',
) =>
	query_permit_offer_create(
		{db},
		{
			from_actor_id: grantor_actor_id,
			to_account_id: recipient_account_id,
			role,
			scope_id: null,
			message: null,
			expires_at,
		},
	);

describe_db('auth_cleanup', (get_db) => {
	test('cleanup_expired_permit_offers emits one audit row per swept offer and returns count', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);

		// Two expired offers, one fresh — sweep should only audit the two.
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			past(hour_ms),
			'teacher',
		);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id_2,
			past(hour_ms),
			'moderator',
		);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			future(hour_ms),
			'admin',
		);

		const callback_events: Array<AuditLogEvent> = [];
		const deps: AuthCleanupDeps = {
			db,
			log,
			on_audit_event: (event) => {
				callback_events.push(event);
			},
		};

		const count = await cleanup_expired_permit_offers(deps);
		assert.strictEqual(count, 2);

		// Two audit rows, both `permit_offer_expire`, callback fired twice.
		const rows = await query_audit_log_list({db}, {event_type: 'permit_offer_expire'});
		assert.strictEqual(rows.length, 2);
		for (const row of rows) {
			assert.strictEqual(row.event_type, 'permit_offer_expire');
			assert.strictEqual(row.actor_id, accounts.grantor_actor_id);
		}
		assert.strictEqual(callback_events.length, 2);
	});

	test('cleanup_expired_permit_offers with no expired rows is a no-op', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			future(hour_ms),
		);

		const callback_events: Array<AuditLogEvent> = [];
		const deps: AuthCleanupDeps = {
			db,
			log,
			on_audit_event: (event) => {
				callback_events.push(event);
			},
		};

		const count = await cleanup_expired_permit_offers(deps);
		assert.strictEqual(count, 0);
		assert.strictEqual(callback_events.length, 0);

		const rows = await query_audit_log_list({db}, {event_type: 'permit_offer_expire'});
		assert.strictEqual(rows.length, 0);
	});

	test('cleanup_expired_permit_offers isolates per-row on_audit_event exceptions', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);

		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			past(hour_ms),
			'teacher',
		);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id_2,
			past(hour_ms),
			'moderator',
		);

		let call_count = 0;
		const deps: AuthCleanupDeps = {
			db,
			log,
			on_audit_event: () => {
				call_count += 1;
				if (call_count === 1) throw new Error('synthetic callback failure');
			},
		};

		const count = await cleanup_expired_permit_offers(deps);
		// Both rows still get audit-stamped; the thrown callback was logged
		// and swallowed, not propagated.
		assert.strictEqual(count, 2);
		assert.strictEqual(call_count, 2);

		const rows = await query_audit_log_list({db}, {event_type: 'permit_offer_expire'});
		assert.strictEqual(rows.length, 2);
	});

	test('run_auth_cleanup returns both session + offer counts', async () => {
		const db = get_db();
		const accounts = await seed_accounts(db);

		// One expired session.
		await query_create_session(
			{db},
			hash_session_token('cleanup-expired'),
			accounts.recipient_account_id,
			past(hour_ms),
		);
		// Two expired offers.
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id,
			past(hour_ms),
			'teacher',
		);
		await insert_offer(
			db,
			accounts.grantor_actor_id,
			accounts.recipient_account_id_2,
			past(hour_ms),
			'moderator',
		);

		const result = await run_auth_cleanup({db, log});
		assert.strictEqual(result.expired_sessions, 1);
		assert.strictEqual(result.expired_offers, 2);
	});
});
