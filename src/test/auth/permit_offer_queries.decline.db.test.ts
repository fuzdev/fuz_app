/**
 * Tests for `permit_offer_queries.ts` — decline lifecycle.
 *
 * Covers the happy-path decline, the already-terminal rejection, and the
 * IDOR guard (wrong recipient → null, no row mutation).
 *
 * @module
 */

import {assert, test} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';

import {
	query_permit_offer_decline,
	PermitOfferAlreadyTerminalError,
} from '$lib/auth/permit_offer_queries.js';

import {describe_db} from '../db_fixture.js';
import {make_account, create_pending_offer} from './permit_offer_queries.fixtures.js';

describe_db('permit_offer_queries.decline', (get_db) => {
	test('decline marks offer terminal and joins grantor account_id', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_decline');
		const recipient = await make_account(db, 'recipient_decline');
		const offer = await create_pending_offer(db, grantor, recipient);
		const declined = await query_permit_offer_decline(
			deps,
			offer.id,
			recipient.account_id,
			'no thanks',
		);
		assert.ok(declined);
		assert.ok(declined.declined_at);
		assert.ok(new Date(declined.declined_at).getTime() > 0);
		assert.strictEqual(declined.decline_reason, 'no thanks');
		// `DeclinedOffer.from_account_id` is the CTE join contract — the
		// audit envelope's `target_account_id` and the post-commit
		// `permit_offer_declined` notification both depend on it. Pin so a
		// refactor that drops the join surfaces here.
		assert.strictEqual(declined.from_account_id, grantor.account_id);
	});

	test('decline on terminal offer throws already_terminal', async () => {
		const db = get_db();
		const deps = {db};
		const grantor = await make_account(db, 'grantor_decline_terminal');
		const recipient = await make_account(db, 'recipient_decline_terminal');
		const offer = await create_pending_offer(db, grantor, recipient);
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
		const offer = await create_pending_offer(db, grantor, recipient);
		const result = await query_permit_offer_decline(deps, offer.id, attacker.account_id, null);
		assert.strictEqual(result, null);
	});
});
