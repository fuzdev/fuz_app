/**
 * Tests for `role_grant_offer_queries.ts` — `query_accept_offer` core paths.
 *
 * Covers the happy-path accept (role_grant insert + audit fan-out + has_role),
 * idempotent re-accept on race, the `already_terminal` rejection on
 * declined / retracted offers, and the recipient-mismatch IDOR guard
 * (404-over-403 with zero column mutation). Supersede semantics on accept
 * live in `role_grant_offer_queries.supersede.db.test.ts`.
 *
 * @module
 */

import {assert, test} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.ts';

import {
	query_role_grant_offer_decline,
	query_role_grant_offer_find_pending,
	query_accept_offer,
	RoleGrantOfferAlreadyTerminalError,
	RoleGrantOfferNotFoundError,
} from '$lib/auth/role_grant_offer_queries.ts';
import {query_role_grant_has_role} from '$lib/auth/role_grant_queries.ts';

import {describe_db} from '../db_fixture.ts';
import {make_account, create_pending_offer} from './role_grant_offer_queries.fixtures.ts';

describe_db('role_grant_offer_queries.accept', (get_db) => {
	test('accept inserts role_grant + stamps resulting_role_grant_id + emits audit events', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_accept');
		const recipient = await make_account(db, 'recipient_accept');

		const offer = await create_pending_offer(db, grantor, recipient);

		const result = await query_accept_offer(deps, {
			offer_id: offer.id,
			to_account_id: recipient.account_id,
			actor_id: recipient.actor_id,
		});

		assert.strictEqual(result.created, true);
		assert.strictEqual(result.role_grant.actor_id, recipient.actor_id);
		assert.strictEqual(result.role_grant.role, 'teacher');
		assert.strictEqual(result.role_grant.source_offer_id, offer.id);
		assert.strictEqual(result.offer.resulting_role_grant_id, result.role_grant.id);
		assert.ok(result.offer.accepted_at);
		assert.strictEqual(result.audit_events.length, 2);
		// Order is part of the contract: accept binds the actor first, then
		// the role_grant grant references the resulting role_grant. Pin index, not
		// just multiset.
		const [accept_event, grant_event] = result.audit_events;
		assert.ok(accept_event);
		assert.ok(grant_event);
		assert.strictEqual(accept_event.event_type, 'role_grant_offer_accept');
		assert.strictEqual(grant_event.event_type, 'role_grant_create');
		// Both target columns populated on accept (the in-tx pair) — see
		// `auth/CLAUDE.md` audit_log_schema rule.
		assert.strictEqual(accept_event.target_account_id, recipient.account_id);
		assert.strictEqual(accept_event.target_actor_id, recipient.actor_id);
		assert.strictEqual(grant_event.target_account_id, recipient.account_id);
		assert.strictEqual(grant_event.target_actor_id, recipient.actor_id);
		const grant_metadata = grant_event.metadata as {
			source_offer_id?: string;
			role_grant_id?: string;
			role?: string;
		};
		assert.strictEqual(grant_metadata.source_offer_id, offer.id);
		assert.strictEqual(grant_metadata.role_grant_id, result.role_grant.id);
		assert.strictEqual(grant_metadata.role, 'teacher');

		// role_grant is active via has_role check.
		assert.strictEqual(await query_role_grant_has_role(deps, recipient.actor_id, 'teacher'), true);
	});

	test('accept is idempotent on race — second call returns already-created role_grant', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_race');
		const recipient = await make_account(db, 'recipient_race');

		const offer = await create_pending_offer(db, grantor, recipient);

		const first = await query_accept_offer(deps, {
			offer_id: offer.id,
			to_account_id: recipient.account_id,
			actor_id: recipient.actor_id,
		});
		// Second call simulates the losing side of a race — the offer is now
		// accepted and has a resulting_role_grant_id; the helper should return that
		// role_grant rather than throwing.
		const second = await query_accept_offer(deps, {
			offer_id: offer.id,
			to_account_id: recipient.account_id,
			actor_id: recipient.actor_id,
		});
		assert.strictEqual(first.created, true);
		assert.strictEqual(second.created, false);
		assert.strictEqual(second.role_grant.id, first.role_grant.id);
		assert.strictEqual(second.audit_events.length, 0);
		// Doc: "empty on the race-loser path". Pin so a refactor that
		// re-emits the supersede side on retry surfaces here.
		assert.strictEqual(second.superseded_offers.length, 0);
	});

	test('accept throws already_terminal for declined / retracted offers', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_terminal');
		const recipient = await make_account(db, 'recipient_terminal');

		const declined = await create_pending_offer(db, grantor, recipient);
		await query_role_grant_offer_decline(deps, declined.id, recipient.account_id, null);

		const err = await assert_rejects(() =>
			query_accept_offer(deps, {
				offer_id: declined.id,
				to_account_id: recipient.account_id,
				actor_id: recipient.actor_id,
			}),
		);
		assert.ok(err instanceof RoleGrantOfferAlreadyTerminalError);
	});

	test('accept rejects when to_account_id does not match the offer', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_idor_accept');
		const recipient = await make_account(db, 'recipient_idor_accept');
		const attacker = await make_account(db, 'attacker_idor_accept');

		const offer = await create_pending_offer(db, grantor, recipient);

		const err = await assert_rejects(() =>
			query_accept_offer(deps, {
				offer_id: offer.id,
				to_account_id: attacker.account_id,
				actor_id: attacker.actor_id,
			}),
		);
		assert.ok(err instanceof RoleGrantOfferNotFoundError);
		// offer is still pending — the wrong-recipient call must not accept it.
		const still_pending = await query_role_grant_offer_find_pending(deps, offer.id);
		assert.ok(still_pending);

		// Defense-in-depth for the 404-over-403 contract: zero columns mutated.
		const rows = await db.query<{
			accepted_at: string | null;
			declined_at: string | null;
			retracted_at: string | null;
			superseded_at: string | null;
			resulting_role_grant_id: string | null;
		}>(
			`SELECT accepted_at, declined_at, retracted_at, superseded_at, resulting_role_grant_id
			 FROM role_grant_offer WHERE id = $1`,
			[offer.id],
		);
		const r = rows[0]!;
		assert.strictEqual(r.accepted_at, null);
		assert.strictEqual(r.declined_at, null);
		assert.strictEqual(r.retracted_at, null);
		assert.strictEqual(r.superseded_at, null);
		assert.strictEqual(r.resulting_role_grant_id, null);
	});

	test('accept rejects when actor_id does not belong to to_account_id (defense-in-depth)', async () => {
		// `query_accept_offer` re-checks the actor↔account binding with a SELECT
		// after the FOR UPDATE lock and the actor-grain gate. The path is
		// reachable only via direct calls (the dispatcher resolves acting actor
		// upstream), but the source comment explicitly promises the invariant
		// "for all callers including tests and future direct consumers" — so
		// pin the contract here.
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_actor_check');
		const recipient = await make_account(db, 'recipient_actor_check');
		const stranger = await make_account(db, 'stranger_actor_check');

		const offer = await create_pending_offer(db, grantor, recipient);

		const err = await assert_rejects(() =>
			query_accept_offer(deps, {
				offer_id: offer.id,
				to_account_id: recipient.account_id,
				actor_id: stranger.actor_id,
			}),
		);
		// Plain Error (no dedicated subclass — direct callers are expected to
		// be rare). Match on the documented message shape so a refactor to a
		// subclass surfaces here rather than silently passing.
		assert.ok(
			err.message.includes(`does not belong to account ${recipient.account_id}`),
			`unexpected message: ${err.message}`,
		);
		assert.ok(err.message.includes(stranger.actor_id));
		assert.ok(err.message.includes(offer.id));

		// Offer must remain pending and untouched.
		const still_pending = await query_role_grant_offer_find_pending(deps, offer.id);
		assert.ok(still_pending);
		assert.strictEqual(still_pending.accepted_at, null);
		assert.strictEqual(still_pending.resulting_role_grant_id, null);
	});
});
