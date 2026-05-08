/**
 * Tests for `permit_offer_queries.ts` — multi-grantor coexistence + supersede.
 *
 * Covers distinct pending offers across grantors for the same
 * `(to_account, role, scope)`, same-grantor pending upsert under that
 * coexistence, accept-on-expired rejection, the supersede cascade on accept
 * (audit fan-out + on-disk single-terminal invariant + cross-grantor join
 * sanity), `history_for_account` symmetry, decline/retract isolation across
 * grantors, the already-terminal branches that fire for superseded siblings,
 * the sweep × superseded interaction, and the end-to-end revoke-bypass
 * regression for the accept-time supersede path.
 *
 * @module
 */

import {assert, test} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';

import {
	query_permit_offer_decline,
	query_permit_offer_retract,
	query_permit_offer_list,
	query_permit_offer_find_pending,
	query_permit_offer_history_for_account,
	query_permit_offer_sweep_expired,
	query_accept_offer,
	PermitOfferAlreadyTerminalError,
	PermitOfferExpiredError,
} from '$lib/auth/permit_offer_queries.js';
import {query_revoke_permit} from '$lib/auth/permit_queries.js';
import {query_audit_log, query_audit_log_list} from '$lib/auth/audit_log_queries.js';
import {create_uuid} from '@fuzdev/fuz_util/id.js';

import {describe_db} from '../db_fixture.js';
import {
	make_account,
	future,
	hour,
	create_pending_offer,
	insert_superseded_offer,
} from './permit_offer_queries.fixtures.js';

describe_db('permit_offer_queries.supersede', (get_db) => {
	test('two grantors produce distinct pending offers for same (to_account, role, scope)', async () => {
		const db = get_db();
		const deps = {db};
		const grantor_a = await make_account(db, 'coexist_a');
		const grantor_b = await make_account(db, 'coexist_b');
		const recipient = await make_account(db, 'coexist_recipient');
		const classroom = create_uuid();

		const offer_a = await create_pending_offer(db, grantor_a, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
			message: 'from A',
		});
		const offer_b = await create_pending_offer(db, grantor_b, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
			message: 'from B',
		});
		assert.notStrictEqual(offer_a.id, offer_b.id);
		assert.strictEqual(offer_a.from_actor_id, grantor_a.actor_id);
		assert.strictEqual(offer_b.from_actor_id, grantor_b.actor_id);
		const list = await query_permit_offer_list(deps, recipient.account_id);
		assert.strictEqual(list.length, 2);
	});

	test('same-grantor re-offer still upserts the pending row', async () => {
		const db = get_db();
		const grantor = await make_account(db, 'reoffer_same_a');
		const recipient = await make_account(db, 'reoffer_same_recipient');
		const classroom = create_uuid();

		const first = await create_pending_offer(db, grantor, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
			message: 'first',
		});
		const second = await create_pending_offer(db, grantor, recipient, {
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

		// `expires_at` has no past-vs-created_at CHECK constraint — the
		// create helper accepts a past Date and stores it verbatim. Use the
		// public path so the test exercises the real upsert.
		const expired_offer = await create_pending_offer(db, grantor, recipient, {
			expires_at: future(-60_000),
		});

		const err = await assert_rejects(() =>
			query_accept_offer(deps, {
				offer_id: expired_offer.id,
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
			[expired_offer.id],
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

		const offer_a = await create_pending_offer(db, grantor_a, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
		});
		const offer_b = await create_pending_offer(db, grantor_b, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
		});
		const offer_c = await create_pending_offer(db, grantor_c, recipient, {
			role: 'classroom_student',
			scope_id: classroom,
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

		// audit events: permit_offer_accept → permit_grant → 2× permit_offer_supersede
		// Pin order — accept fires first (offer side), grant second (permit
		// side), then the per-sibling supersedes. Multiset-only checks would
		// silently pass even if a refactor reordered the in-tx emits.
		assert.strictEqual(result.audit_events.length, 4);
		assert.strictEqual(result.audit_events[0]?.event_type, 'permit_offer_accept');
		assert.strictEqual(result.audit_events[1]?.event_type, 'permit_grant');
		for (const e of result.audit_events.slice(2)) {
			assert.strictEqual(e.event_type, 'permit_offer_supersede');
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

	test('history_for_account returns offers in both directions, newest first, with pagination', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'history_grantor');
		const recipient = await make_account(db, 'history_recipient');
		const outsider = await make_account(db, 'history_outsider');

		// Two offers — `outgoing` first (older `created_at`), then `incoming`.
		// `query_permit_offer_history_for_account` is documented as
		// `ORDER BY created_at DESC`, so the second insert appears first.
		const outgoing = await create_pending_offer(db, grantor, recipient);
		// Defeat any same-clock-tick ordering ambiguity in PGlite by stamping
		// a deterministic gap between the two `created_at` values.
		await db.query(`UPDATE permit_offer SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [
			outgoing.id,
		]);
		const incoming = await create_pending_offer(db, outsider, grantor);

		const for_grantor = await query_permit_offer_history_for_account(deps, grantor.account_id);
		// Newest-first ordering — pin index, not multiset.
		assert.deepStrictEqual(
			for_grantor.map((o) => o.id),
			[incoming.id, outgoing.id],
		);

		// limit + offset paginate the same ordering.
		const page1 = await query_permit_offer_history_for_account(deps, grantor.account_id, 1, 0);
		assert.strictEqual(page1.length, 1);
		assert.strictEqual(page1[0]!.id, incoming.id);
		const page2 = await query_permit_offer_history_for_account(deps, grantor.account_id, 1, 1);
		assert.strictEqual(page2.length, 1);
		assert.strictEqual(page2[0]!.id, outgoing.id);
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
		const superseded_expired_id = await insert_superseded_offer(db, grantor, recipient, {
			role: 'teacher',
			expires_at: future(-hour),
			superseded_at: new Date(Date.now() - 30 * 60_000),
		});

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
		const events = await query_audit_log_list(deps, {account_id: recipient.account_id});
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
