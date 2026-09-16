/**
 * Tests for `role_grant_offer_queries.ts` — retract lifecycle.
 *
 * Covers the happy-path retract + already-terminal rejection, and the
 * wrong-grantor guard (returns null without mutating).
 *
 * @module
 */

import { assert, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	query_role_grant_offer_retract,
	RoleGrantOfferAlreadyTerminalError
} from '$lib/auth/role_grant_offer_queries.ts';

import { describe_db } from '../db_fixture.ts';
import { make_account, create_pending_offer } from './role_grant_offer_queries.fixtures.ts';

describe_db('role_grant_offer_queries.retract', (get_db) => {
	test('retract marks offer terminal; retract on terminal throws', async () => {
		const db = get_db();
		const deps = { db };
		const grantor = await make_account(db, 'grantor_retract');
		const recipient = await make_account(db, 'recipient_retract');
		const offer = await create_pending_offer(db, grantor, recipient);
		const retracted = await query_role_grant_offer_retract(deps, offer.id, grantor.actor_id);
		assert.ok(retracted);
		assert.ok(retracted.retracted_at);
		assert.ok(new Date(retracted.retracted_at).getTime() > 0);
		const err = await assert_rejects(() =>
			query_role_grant_offer_retract(deps, offer.id, grantor.actor_id)
		);
		assert.ok(err instanceof RoleGrantOfferAlreadyTerminalError);
	});

	test('retract with wrong grantor returns null', async () => {
		const db = get_db();
		const deps = { db };
		const grantor = await make_account(db, 'retract_guard_grantor');
		const other = await make_account(db, 'retract_guard_other');
		const recipient = await make_account(db, 'retract_guard_recipient');
		const offer = await create_pending_offer(db, grantor, recipient);
		const result = await query_role_grant_offer_retract(deps, offer.id, other.actor_id);
		assert.strictEqual(result, null);
	});
});
