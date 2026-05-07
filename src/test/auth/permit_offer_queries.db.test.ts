/**
 * Tests for permit_offer_queries.ts — offer lifecycle queries + atomic accept.
 *
 * @module
 */

import {assert, test} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';

import {query_create_account_with_actor} from '$lib/auth/account_queries.js';
import {
	query_permit_offer_create,
	query_permit_offer_decline,
	query_permit_offer_retract,
	query_permit_offer_list,
	query_permit_offer_find_pending,
	query_permit_offer_history_for_account,
	query_permit_offer_sweep_expired,
	query_accept_offer,
	PermitOfferAlreadyTerminalError,
	PermitOfferExpiredError,
	PermitOfferNotFoundError,
	PermitOfferSelfTargetError,
} from '$lib/auth/permit_offer_queries.js';
import {
	query_permit_has_role,
	query_grant_permit,
	query_revoke_permit,
} from '$lib/auth/permit_queries.js';
import {query_audit_log, query_audit_log_list_for_account} from '$lib/auth/audit_log_queries.js';
import {create_uuid, type Uuid} from '@fuzdev/fuz_util/id.js';
import type {Db} from '$lib/db/db.js';

import {describe_db} from '../db_fixture.js';

interface TestAccount {
	account_id: Uuid;
	actor_id: Uuid;
}

const make_account = async (db: Db, username: string): Promise<TestAccount> => {
	const deps = {db};
	const {account, actor} = await query_create_account_with_actor(deps, {
		username,
		password_hash: 'hash',
	});
	return {account_id: account.id, actor_id: actor.id};
};

const future = (ms_from_now: number): Date => new Date(Date.now() + ms_from_now);
const hour = 60 * 60 * 1000;

interface CreatePendingOfferOptions {
	role?: string;
	scope_id?: Uuid | null;
	message?: string | null;
	expires_at?: Date;
}

/** Test helper — create a pending offer with sensible defaults. */
const create_pending_offer = (
	db: Db,
	grantor: TestAccount,
	recipient: TestAccount,
	options: CreatePendingOfferOptions = {},
) =>
	query_permit_offer_create(
		{db},
		{
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: options.role ?? 'teacher',
			scope_id: options.scope_id ?? null,
			message: options.message ?? null,
			expires_at: options.expires_at ?? future(hour),
		},
	);

describe_db('PermitOfferQueries', (get_db) => {
	test('create inserts a pending offer', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_create');
		const recipient = await make_account(db, 'recipient_create');
		const offer = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			message: 'welcome',
			expires_at: future(hour),
		});
		assert.ok(offer.id);
		assert.strictEqual(offer.role, 'teacher');
		assert.strictEqual(offer.from_actor_id, grantor.actor_id);
		assert.strictEqual(offer.to_account_id, recipient.account_id);
		assert.strictEqual(offer.scope_id, null);
		assert.strictEqual(offer.message, 'welcome');
		assert.strictEqual(offer.accepted_at, null);
		assert.strictEqual(offer.declined_at, null);
		assert.strictEqual(offer.retracted_at, null);
		assert.strictEqual(offer.resulting_permit_id, null);
	});

	test('re-offer while pending upserts the same row (refreshes message + expires_at)', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_upsert');
		const recipient = await make_account(db, 'recipient_upsert');
		const first = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			message: 'first',
			expires_at: future(hour),
		});
		const later_expiry = future(hour * 2);
		const second = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			message: 'second',
			expires_at: later_expiry,
		});
		assert.strictEqual(second.id, first.id);
		assert.strictEqual(second.message, 'second');
		assert.ok(new Date(second.expires_at) > new Date(first.expires_at));
		// still a single row in the table for this recipient/role.
		const rows = await db.query<{c: number}>(
			`SELECT COUNT(*)::int AS c FROM permit_offer WHERE to_account_id = $1 AND role = $2`,
			[recipient.account_id, 'teacher'],
		);
		assert.strictEqual(rows[0]!.c, 1);
	});

	test('different scope produces a distinct offer (partial unique index covers scope)', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_scope');
		const recipient = await make_account(db, 'recipient_scope');
		const classroom_a = create_uuid();
		const classroom_b = create_uuid();
		const offer_a = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_id: classroom_a,
			expires_at: future(hour),
		});
		const offer_b = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_id: classroom_b,
			expires_at: future(hour),
		});
		assert.notStrictEqual(offer_a.id, offer_b.id);
	});

	test('self-offer rejected (from_actor belongs to to_account)', async () => {
		const db = get_db();
		const deps = {db};
		const self = await make_account(db, 'self_offer');
		const err = await assert_rejects(() =>
			query_permit_offer_create(deps, {
				from_actor_id: self.actor_id,
				to_account_id: self.account_id,
				role: 'teacher',
				expires_at: future(hour),
			}),
		);
		assert.ok(err instanceof PermitOfferSelfTargetError);
	});

	test('decline marks offer terminal', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_decline');
		const recipient = await make_account(db, 'recipient_decline');
		const offer = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});
		const declined = await query_permit_offer_decline(
			deps,
			offer.id,
			recipient.account_id,
			'no thanks',
		);
		assert.ok(declined);
		assert.ok(declined.declined_at);
		assert.strictEqual(declined.decline_reason, 'no thanks');
	});

	test('decline on terminal offer throws already_terminal', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_decline_terminal');
		const recipient = await make_account(db, 'recipient_decline_terminal');
		const offer = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});
		await query_permit_offer_decline(deps, offer.id, recipient.account_id, null);
		const err = await assert_rejects(() =>
			query_permit_offer_decline(deps, offer.id, recipient.account_id, null),
		);
		assert.ok(err instanceof PermitOfferAlreadyTerminalError);
	});

	test('decline with wrong recipient returns null (IDOR guard)', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_idor');
		const recipient = await make_account(db, 'recipient_idor');
		const attacker = await make_account(db, 'attacker_idor');
		const offer = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});
		const result = await query_permit_offer_decline(deps, offer.id, attacker.account_id, null);
		assert.strictEqual(result, null);
	});

	test('retract marks offer terminal; retract on terminal throws', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_retract');
		const recipient = await make_account(db, 'recipient_retract');
		const offer = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});
		const retracted = await query_permit_offer_retract(deps, offer.id, grantor.actor_id);
		assert.ok(retracted);
		assert.ok(retracted.retracted_at);
		const err = await assert_rejects(() =>
			query_permit_offer_retract(deps, offer.id, grantor.actor_id),
		);
		assert.ok(err instanceof PermitOfferAlreadyTerminalError);
	});

	test('retract with wrong grantor returns null', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'retract_guard_grantor');
		const other = await make_account(db, 'retract_guard_other');
		const recipient = await make_account(db, 'retract_guard_recipient');
		const offer = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});
		const result = await query_permit_offer_retract(deps, offer.id, other.actor_id);
		assert.strictEqual(result, null);
	});

	test('list filters out terminal and expired offers', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_list');
		const recipient = await make_account(db, 'recipient_list');

		// pending, in-window — should appear
		const pending = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});

		// declined — terminal, should not appear
		const declinable = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_id: create_uuid(),
			expires_at: future(hour),
		});
		await query_permit_offer_decline(deps, declinable.id, recipient.account_id, null);

		// expired — pending but past expires_at, should not appear
		await db.query(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, scope_id, expires_at)
			 VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour')`,
			[grantor.actor_id, recipient.account_id, 'classroom_student', create_uuid()],
		);

		const list = await query_permit_offer_list(deps, recipient.account_id);
		assert.strictEqual(list.length, 1);
		assert.strictEqual(list[0]!.id, pending.id);
	});

	test('find_pending returns null for expired or terminal offers', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_find');
		const recipient = await make_account(db, 'recipient_find');

		const pending = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});
		assert.ok(await query_permit_offer_find_pending(deps, pending.id));

		await query_permit_offer_decline(deps, pending.id, recipient.account_id, null);
		assert.strictEqual(await query_permit_offer_find_pending(deps, pending.id), null);
	});

	test('sweep returns only expired pending offers', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_sweep');
		const recipient = await make_account(db, 'recipient_sweep');

		const fresh = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});

		const expired_rows = await db.query<{id: string}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, scope_id, expires_at)
			 VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour')
			 RETURNING id`,
			[grantor.actor_id, recipient.account_id, 'classroom_student', create_uuid()],
		);
		const expired_id = expired_rows[0]!.id;

		const swept = await query_permit_offer_sweep_expired(deps);
		const swept_ids = swept.map((o) => o.id);
		assert.include(swept_ids, expired_id);
		assert.notInclude(swept_ids, fresh.id);
	});

	// -- query_accept_offer -----------------------------------------------------

	test('accept inserts permit + stamps resulting_permit_id + emits audit events', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_accept');
		const recipient = await make_account(db, 'recipient_accept');

		const offer = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});

		const result = await query_accept_offer(deps, {
			offer_id: offer.id,
			to_account_id: recipient.account_id,
			actor_id: recipient.actor_id,
		});

		assert.strictEqual(result.created, true);
		assert.strictEqual(result.permit.actor_id, recipient.actor_id);
		assert.strictEqual(result.permit.role, 'teacher');
		assert.strictEqual(result.permit.source_offer_id, offer.id);
		assert.strictEqual(result.offer.resulting_permit_id, result.permit.id);
		assert.ok(result.offer.accepted_at);
		assert.strictEqual(result.audit_events.length, 2);
		const event_types = result.audit_events.map((e) => e.event_type).sort();
		assert.deepStrictEqual(event_types, ['permit_grant', 'permit_offer_accept']);
		const permit_grant_event = result.audit_events.find((e) => e.event_type === 'permit_grant');
		assert.ok(permit_grant_event);
		assert.strictEqual(
			(permit_grant_event.metadata as {source_offer_id?: string}).source_offer_id,
			offer.id,
		);

		// permit is active via has_role check.
		assert.strictEqual(await query_permit_has_role(deps, recipient.actor_id, 'teacher'), true);
	});

	test('accept is idempotent on race — second call returns already-created permit', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_race');
		const recipient = await make_account(db, 'recipient_race');

		const offer = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});

		const first = await query_accept_offer(deps, {
			offer_id: offer.id,
			to_account_id: recipient.account_id,
			actor_id: recipient.actor_id,
		});
		// Second call simulates the losing side of a race — the offer is now
		// accepted and has a resulting_permit_id; the helper should return that
		// permit rather than throwing.
		const second = await query_accept_offer(deps, {
			offer_id: offer.id,
			to_account_id: recipient.account_id,
			actor_id: recipient.actor_id,
		});
		assert.strictEqual(first.created, true);
		assert.strictEqual(second.created, false);
		assert.strictEqual(second.permit.id, first.permit.id);
		assert.strictEqual(second.audit_events.length, 0);
	});

	test('accept throws already_terminal for declined / retracted offers', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_terminal');
		const recipient = await make_account(db, 'recipient_terminal');

		const declined = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});
		await query_permit_offer_decline(deps, declined.id, recipient.account_id, null);

		const err = await assert_rejects(() =>
			query_accept_offer(deps, {
				offer_id: declined.id,
				to_account_id: recipient.account_id,
				actor_id: recipient.actor_id,
			}),
		);
		assert.ok(err instanceof PermitOfferAlreadyTerminalError);
	});

	test('accept rejects when to_account_id does not match the offer', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_idor_accept');
		const recipient = await make_account(db, 'recipient_idor_accept');
		const attacker = await make_account(db, 'attacker_idor_accept');

		const offer = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});

		const err = await assert_rejects(() =>
			query_accept_offer(deps, {
				offer_id: offer.id,
				to_account_id: attacker.account_id,
				actor_id: attacker.actor_id,
			}),
		);
		assert.ok(err instanceof PermitOfferNotFoundError);
		// offer is still pending — the wrong-recipient call must not accept it.
		const still_pending = await query_permit_offer_find_pending(deps, offer.id);
		assert.ok(still_pending);

		// Defense-in-depth for the 404-over-403 contract: zero columns mutated.
		const rows = await db.query<{
			accepted_at: string | null;
			declined_at: string | null;
			retracted_at: string | null;
			superseded_at: string | null;
			resulting_permit_id: string | null;
		}>(
			`SELECT accepted_at, declined_at, retracted_at, superseded_at, resulting_permit_id
			 FROM permit_offer WHERE id = $1`,
			[offer.id],
		);
		const r = rows[0]!;
		assert.strictEqual(r.accepted_at, null);
		assert.strictEqual(r.declined_at, null);
		assert.strictEqual(r.retracted_at, null);
		assert.strictEqual(r.superseded_at, null);
		assert.strictEqual(r.resulting_permit_id, null);
	});

	// -- scoped permit grant semantics -----------------------------------------

	test('query_grant_permit: global permit (scope_id NULL) idempotent on sentinel', async () => {
		const db = get_db();
		const deps = {db};
		const grantee = await make_account(db, 'global_grantee');
		const first = await query_grant_permit(deps, {
			actor_id: grantee.actor_id,
			role: 'admin',
			granted_by: null,
		});
		const second = await query_grant_permit(deps, {
			actor_id: grantee.actor_id,
			role: 'admin',
			granted_by: null,
		});
		assert.strictEqual(first.id, second.id);
	});

	test('query_grant_permit: different scopes produce distinct permits', async () => {
		const db = get_db();
		const deps = {db};
		const grantee = await make_account(db, 'scoped_grantee');
		const classroom_a = create_uuid();
		const classroom_b = create_uuid();
		const a = await query_grant_permit(deps, {
			actor_id: grantee.actor_id,
			role: 'classroom_student',
			scope_id: classroom_a,
			granted_by: null,
		});
		const b = await query_grant_permit(deps, {
			actor_id: grantee.actor_id,
			role: 'classroom_student',
			scope_id: classroom_b,
			granted_by: null,
		});
		assert.notStrictEqual(a.id, b.id);
		assert.strictEqual(a.scope_id, classroom_a);
		assert.strictEqual(b.scope_id, classroom_b);
	});

	test('query_grant_permit: same scope is idempotent', async () => {
		const db = get_db();
		const deps = {db};
		const grantee = await make_account(db, 'idem_scope_grantee');
		const classroom = create_uuid();
		const a = await query_grant_permit(deps, {
			actor_id: grantee.actor_id,
			role: 'classroom_student',
			scope_id: classroom,
			granted_by: null,
		});
		const b = await query_grant_permit(deps, {
			actor_id: grantee.actor_id,
			role: 'classroom_student',
			scope_id: classroom,
			granted_by: null,
		});
		assert.strictEqual(a.id, b.id);
	});

	test('query_permit_has_role: scope_id distinguishes grants', async () => {
		const db = get_db();
		const deps = {db};
		const grantee = await make_account(db, 'scope_check_grantee');
		const classroom_a = create_uuid();
		const classroom_b = create_uuid();
		await query_grant_permit(deps, {
			actor_id: grantee.actor_id,
			role: 'classroom_student',
			scope_id: classroom_a,
			granted_by: null,
		});
		assert.strictEqual(
			await query_permit_has_role(deps, grantee.actor_id, 'classroom_student', classroom_a),
			true,
		);
		assert.strictEqual(
			await query_permit_has_role(deps, grantee.actor_id, 'classroom_student', classroom_b),
			false,
		);
		// No scope_id argument means "global (NULL) scope" — the scoped grant must not match.
		assert.strictEqual(
			await query_permit_has_role(deps, grantee.actor_id, 'classroom_student'),
			false,
		);
	});

	test('query_permit_has_role: global grant does not match a scoped check', async () => {
		const db = get_db();
		const deps = {db};
		const grantee = await make_account(db, 'global_vs_scoped');
		await query_grant_permit(deps, {
			actor_id: grantee.actor_id,
			role: 'admin',
			granted_by: null,
		});
		assert.strictEqual(await query_permit_has_role(deps, grantee.actor_id, 'admin'), true);
		assert.strictEqual(
			await query_permit_has_role(deps, grantee.actor_id, 'admin', create_uuid()),
			false,
		);
	});

	// -- coexistence, superseding, and distinct errors -------------------------

	test('two grantors produce distinct pending offers for same (to_account, role, scope)', async () => {
		const db = get_db();
		const deps = {db};
		const grantor_a = await make_account(db, 'coexist_a');
		const grantor_b = await make_account(db, 'coexist_b');
		const recipient = await make_account(db, 'coexist_recipient');
		const classroom = create_uuid();

		const offer_a = await query_permit_offer_create(deps, {
			from_actor_id: grantor_a.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_id: classroom,
			message: 'from A',
			expires_at: future(hour),
		});
		const offer_b = await query_permit_offer_create(deps, {
			from_actor_id: grantor_b.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_id: classroom,
			message: 'from B',
			expires_at: future(hour),
		});
		assert.notStrictEqual(offer_a.id, offer_b.id);
		assert.strictEqual(offer_a.from_actor_id, grantor_a.actor_id);
		assert.strictEqual(offer_b.from_actor_id, grantor_b.actor_id);
		const list = await query_permit_offer_list(deps, recipient.account_id);
		assert.strictEqual(list.length, 2);
	});

	test('same-grantor re-offer still upserts the pending row', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'reoffer_same_a');
		const recipient = await make_account(db, 'reoffer_same_recipient');
		const classroom = create_uuid();

		const first = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_id: classroom,
			message: 'first',
			expires_at: future(hour),
		});
		const second = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_id: classroom,
			message: 'second',
			expires_at: future(hour * 2),
		});
		assert.strictEqual(second.id, first.id);
		assert.strictEqual(second.message, 'second');
	});

	test('accept on expired pending offer throws PermitOfferExpiredError', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_expired_accept');
		const recipient = await make_account(db, 'recipient_expired_accept');

		// Insert an already-past offer directly; the create helper would
		// reject on CHECK constraint checks around expiry vs created_at ordering
		// if we tried to build it via query_permit_offer_create.
		const rows = await db.query<{id: Uuid}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
			 VALUES ($1, $2, 'teacher', NOW() - INTERVAL '1 minute')
			 RETURNING id`,
			[grantor.actor_id, recipient.account_id],
		);
		const expired_offer_id = rows[0]!.id;

		const err = await assert_rejects(() =>
			query_accept_offer(deps, {
				offer_id: expired_offer_id,
				to_account_id: recipient.account_id,
				actor_id: recipient.actor_id,
			}),
		);
		assert.ok(err instanceof PermitOfferExpiredError);

		// Row must be untouched — the throw happens before any state mutation.
		const check_rows = await db.query<{
			accepted_at: string | null;
			resulting_permit_id: string | null;
			superseded_at: string | null;
			declined_at: string | null;
			retracted_at: string | null;
		}>(
			`SELECT accepted_at, resulting_permit_id, superseded_at, declined_at, retracted_at
			 FROM permit_offer WHERE id = $1`,
			[expired_offer_id],
		);
		const r = check_rows[0]!;
		assert.strictEqual(r.accepted_at, null);
		assert.strictEqual(r.resulting_permit_id, null);
		assert.strictEqual(r.superseded_at, null);
		assert.strictEqual(r.declined_at, null);
		assert.strictEqual(r.retracted_at, null);
	});

	test('accept supersedes sibling pending offers and emits audit events', async () => {
		const db = get_db();
		const deps = {db};
		const grantor_a = await make_account(db, 'sibling_a');
		const grantor_b = await make_account(db, 'sibling_b');
		const grantor_c = await make_account(db, 'sibling_c');
		const recipient = await make_account(db, 'sibling_recipient');
		const classroom = create_uuid();

		const offer_a = await query_permit_offer_create(deps, {
			from_actor_id: grantor_a.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_id: classroom,
			expires_at: future(hour),
		});
		const offer_b = await query_permit_offer_create(deps, {
			from_actor_id: grantor_b.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_id: classroom,
			expires_at: future(hour),
		});
		const offer_c = await query_permit_offer_create(deps, {
			from_actor_id: grantor_c.actor_id,
			to_account_id: recipient.account_id,
			role: 'classroom_student',
			scope_id: classroom,
			expires_at: future(hour),
		});

		const result = await query_accept_offer(deps, {
			offer_id: offer_a.id,
			to_account_id: recipient.account_id,
			actor_id: recipient.actor_id,
		});

		assert.strictEqual(result.superseded_offers.length, 2);
		const superseded_ids = result.superseded_offers.map((o) => o.id).sort();
		assert.deepStrictEqual(superseded_ids, [offer_b.id, offer_c.id].sort());
		for (const sibling of result.superseded_offers) {
			assert.ok(sibling.superseded_at);
		}

		// from_account_id is populated via CTE join on `actor` — each sibling's
		// entry must carry its own grantor account, never a cross-contamination.
		// Direct guard so a broken join fails here before any notification test.
		const grantor_b_account = await db.query<{account_id: string}>(
			`SELECT account_id FROM actor WHERE id = $1`,
			[grantor_b.actor_id],
		);
		const grantor_c_account = await db.query<{account_id: string}>(
			`SELECT account_id FROM actor WHERE id = $1`,
			[grantor_c.actor_id],
		);
		const expected_accounts: Record<string, string> = {
			[offer_b.id]: grantor_b_account[0]!.account_id,
			[offer_c.id]: grantor_c_account[0]!.account_id,
		};
		for (const sibling of result.superseded_offers) {
			assert.strictEqual(sibling.from_account_id, expected_accounts[sibling.id]);
		}

		// On-disk: exactly one terminal column set per superseded sibling.
		// Locks in single-terminal invariant (permit_offer_single_terminal CHECK).
		const sibling_rows = await db.query<{
			accepted_at: string | null;
			declined_at: string | null;
			retracted_at: string | null;
			superseded_at: string | null;
		}>(
			`SELECT accepted_at, declined_at, retracted_at, superseded_at
			 FROM permit_offer WHERE id = ANY($1)`,
			[[offer_b.id, offer_c.id]],
		);
		assert.strictEqual(sibling_rows.length, 2);
		for (const row of sibling_rows) {
			assert.ok(row.superseded_at);
			assert.strictEqual(row.accepted_at, null);
			assert.strictEqual(row.declined_at, null);
			assert.strictEqual(row.retracted_at, null);
		}

		// audit events: permit_offer_accept + permit_grant + 2x permit_offer_supersede
		const event_types = result.audit_events.map((e) => e.event_type).sort();
		assert.deepStrictEqual(event_types, [
			'permit_grant',
			'permit_offer_accept',
			'permit_offer_supersede',
			'permit_offer_supersede',
		]);
		for (const e of result.audit_events.filter((e) => e.event_type === 'permit_offer_supersede')) {
			const md = e.metadata as {reason?: string; cause_id?: string};
			assert.strictEqual(md.reason, 'sibling_accepted');
			assert.strictEqual(md.cause_id, offer_a.id);
		}

		// list is now empty for the recipient — all three offers terminal.
		const list = await query_permit_offer_list(deps, recipient.account_id);
		assert.strictEqual(list.length, 0);

		// attempting to accept a superseded sibling throws already-terminal.
		const err = await assert_rejects(() =>
			query_accept_offer(deps, {
				offer_id: offer_b.id,
				to_account_id: recipient.account_id,
				actor_id: recipient.actor_id,
			}),
		);
		assert.ok(err instanceof PermitOfferAlreadyTerminalError);
	});

	test('history_for_account returns offers in both directions', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'history_grantor');
		const recipient = await make_account(db, 'history_recipient');
		const outsider = await make_account(db, 'history_outsider');

		const outgoing = await query_permit_offer_create(deps, {
			from_actor_id: grantor.actor_id,
			to_account_id: recipient.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});
		const incoming = await query_permit_offer_create(deps, {
			from_actor_id: outsider.actor_id,
			to_account_id: grantor.account_id,
			role: 'teacher',
			expires_at: future(hour),
		});

		const for_grantor = await query_permit_offer_history_for_account(deps, grantor.account_id);
		const ids = for_grantor.map((o) => o.id).sort();
		assert.deepStrictEqual(ids, [outgoing.id, incoming.id].sort());
	});

	// -- decline/retract with multi-grantor coexistence ------------------------

	test('decline on A does not affect B from a different grantor', async () => {
		const db = get_db();
		const deps = {db};
		const grantor_a = await make_account(db, 'decline_coexist_a');
		const grantor_b = await make_account(db, 'decline_coexist_b');
		const recipient = await make_account(db, 'decline_coexist_recipient');
		const classroom = create_uuid();

		const offer_a = await create_pending_offer(db, grantor_a, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
		});
		const offer_b = await create_pending_offer(db, grantor_b, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
		});

		const declined = await query_permit_offer_decline(deps, offer_a.id, recipient.account_id, null);
		assert.ok(declined?.declined_at);

		// B is still pending.
		const still = await query_permit_offer_find_pending(deps, offer_b.id);
		assert.ok(still);
		assert.strictEqual(still.accepted_at, null);
		assert.strictEqual(still.declined_at, null);
		assert.strictEqual(still.retracted_at, null);
		assert.strictEqual(still.superseded_at, null);
	});

	test('retract on A does not affect B from a different grantor', async () => {
		const db = get_db();
		const deps = {db};
		const grantor_a = await make_account(db, 'retract_coexist_a');
		const grantor_b = await make_account(db, 'retract_coexist_b');
		const recipient = await make_account(db, 'retract_coexist_recipient');
		const classroom = create_uuid();

		const offer_a = await create_pending_offer(db, grantor_a, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
		});
		const offer_b = await create_pending_offer(db, grantor_b, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
		});

		const retracted = await query_permit_offer_retract(deps, offer_a.id, grantor_a.actor_id);
		assert.ok(retracted?.retracted_at);

		const still = await query_permit_offer_find_pending(deps, offer_b.id);
		assert.ok(still);
		assert.strictEqual(still.retracted_at, null);
	});

	test('decline and retract on a superseded offer both throw already_terminal', async () => {
		const db = get_db();
		const deps = {db};
		const grantor_a = await make_account(db, 'superseded_grantor_a');
		const grantor_b = await make_account(db, 'superseded_grantor_b');
		const recipient = await make_account(db, 'superseded_recipient');
		const classroom = create_uuid();

		const offer_a = await create_pending_offer(db, grantor_a, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
		});
		const offer_b = await create_pending_offer(db, grantor_b, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
		});

		// Accept A → B becomes superseded.
		const result = await query_accept_offer(deps, {
			offer_id: offer_a.id,
			to_account_id: recipient.account_id,
			actor_id: recipient.actor_id,
		});
		assert.strictEqual(result.superseded_offers.length, 1);
		assert.strictEqual(result.superseded_offers[0]!.id, offer_b.id);

		// Decline on B must throw already_terminal — exercises the superseded_at
		// branch in resolve_terminal_or_missing.
		const decline_err = await assert_rejects(() =>
			query_permit_offer_decline(deps, offer_b.id, recipient.account_id, null),
		);
		assert.ok(decline_err instanceof PermitOfferAlreadyTerminalError);

		// Retract on B by the original grantor — also terminal.
		const retract_err = await assert_rejects(() =>
			query_permit_offer_retract(deps, offer_b.id, grantor_b.actor_id),
		);
		assert.ok(retract_err instanceof PermitOfferAlreadyTerminalError);
	});

	test('sweep_expired does not return expired superseded offers', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'sweep_superseded_grantor');
		const recipient = await make_account(db, 'sweep_superseded_recipient');

		// Defense-in-depth: an expired pending offer that is *also* superseded
		// must not appear in the sweep (the sweep must gate on non-terminal).
		const rows = await db.query<{id: string}>(
			`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at, superseded_at)
			 VALUES ($1, $2, 'teacher', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes')
			 RETURNING id`,
			[grantor.actor_id, recipient.account_id],
		);
		const superseded_expired_id = rows[0]!.id;

		const swept = await query_permit_offer_sweep_expired(deps);
		const ids = swept.map((o) => o.id);
		assert.notInclude(ids, superseded_expired_id);
	});

	// -- end-to-end revoke-bypass regression -----------------------------------

	test('revoke-bypass regression: accept A → revoke → cannot accept superseded B', async () => {
		const db = get_db();
		const deps = {db};
		const grantor_a = await make_account(db, 'bypass_grantor_a');
		const grantor_b = await make_account(db, 'bypass_grantor_b');
		const recipient = await make_account(db, 'bypass_recipient');
		const classroom = create_uuid();

		const offer_a = await create_pending_offer(db, grantor_a, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
		});
		const offer_b = await create_pending_offer(db, grantor_b, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
		});

		// Recipient accepts A — B is superseded in the same transaction.
		const accept = await query_accept_offer(deps, {
			offer_id: offer_a.id,
			to_account_id: recipient.account_id,
			actor_id: recipient.actor_id,
		});
		assert.strictEqual(accept.superseded_offers.length, 1);
		assert.strictEqual(accept.superseded_offers[0]!.id, offer_b.id);

		// Admin revokes the resulting permit.
		const revoke = await query_revoke_permit(
			deps,
			accept.permit.id,
			recipient.actor_id,
			null,
			'ended',
		);
		assert.ok(revoke);
		assert.strictEqual(revoke.id, accept.permit.id);

		// Emit the permit_revoke audit event like the route layer does, so the
		// audit chain is inspectable.
		await query_audit_log(deps, {
			event_type: 'permit_revoke',
			actor_id: recipient.actor_id,
			account_id: recipient.account_id,
			metadata: {
				role: revoke.role,
				permit_id: revoke.id,
				scope_id: revoke.scope_id,
				reason: 'ended',
			},
		});

		// Attempting to accept the stale B offer must throw already_terminal —
		// closed by the accept-time sibling supersede.
		const err = await assert_rejects(() =>
			query_accept_offer(deps, {
				offer_id: offer_b.id,
				to_account_id: recipient.account_id,
				actor_id: recipient.actor_id,
			}),
		);
		assert.ok(err instanceof PermitOfferAlreadyTerminalError);

		// Audit chain: permit_offer_accept(A) → permit_grant(source_offer_id=A)
		// → permit_offer_supersede(B, reason sibling_accepted, cause_id=A)
		// → permit_revoke.
		const events = await query_audit_log_list_for_account(deps, recipient.account_id);
		const by_type = new Map<string, typeof events>();
		for (const e of events) {
			const list = by_type.get(e.event_type) ?? [];
			list.push(e);
			by_type.set(e.event_type, list);
		}
		assert.strictEqual(by_type.get('permit_offer_accept')?.length, 1);
		const permit_grants = by_type.get('permit_grant') ?? [];
		assert.strictEqual(permit_grants.length, 1);
		assert.strictEqual(
			(permit_grants[0]!.metadata as {source_offer_id?: string}).source_offer_id,
			offer_a.id,
		);
		const supersedes = by_type.get('permit_offer_supersede') ?? [];
		assert.strictEqual(supersedes.length, 1);
		const supersede_md = supersedes[0]!.metadata as {
			reason?: string;
			cause_id?: string;
			offer_id?: string;
		};
		assert.strictEqual(supersede_md.reason, 'sibling_accepted');
		assert.strictEqual(supersede_md.cause_id, offer_a.id);
		assert.strictEqual(supersede_md.offer_id, offer_b.id);
		assert.strictEqual(by_type.get('permit_revoke')?.length, 1);
	});
});
