// @vitest-environment jsdom

/**
 * Tests for `PermitOffersState` — offer cache reducer, seed paths, and the
 * six-notification subscription handler.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {PermitOffersState, type PermitOffersRpc} from '$lib/ui/permit_offers_state.svelte.js';
import type {PermitOfferJson} from '$lib/auth/permit_offer_schema.js';
import {
	PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD,
	PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	PERMIT_REVOKE_NOTIFICATION_METHOD,
} from '$lib/auth/permit_offer_notifications.js';

const RECIPIENT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_RECIPIENT_ID = '22222222-2222-2222-2222-222222222222';
const GRANTOR_ACTOR_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_ACTOR_ID = '44444444-4444-4444-4444-444444444444';

let counter = 0;
const next_uuid = (): string => {
	counter += 1;
	return `00000000-0000-0000-0000-${counter.toString().padStart(12, '0')}`;
};

const pending_offer = (overrides: Partial<PermitOfferJson> = {}): PermitOfferJson => {
	const now = new Date();
	const base: PermitOfferJson = {
		id: next_uuid() as PermitOfferJson['id'],
		from_actor_id: GRANTOR_ACTOR_ID as PermitOfferJson['from_actor_id'],
		to_account_id: RECIPIENT_ID as PermitOfferJson['to_account_id'],
		to_actor_id: null,
		role: 'admin',
		scope_id: null,
		message: null,
		created_at: now.toISOString(),
		expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
		accepted_at: null,
		declined_at: null,
		decline_reason: null,
		retracted_at: null,
		superseded_at: null,
		resulting_permit_id: null,
	};
	return {...base, ...overrides};
};

const rpc_stub = (partial: Partial<PermitOffersRpc> = {}): PermitOffersRpc => ({
	list: async () => ({offers: []}),
	history: async () => ({offers: []}),
	create: async () => {
		throw new Error('rpc.create not stubbed');
	},
	accept: async () => {
		throw new Error('rpc.accept not stubbed');
	},
	decline: async () => ({ok: true}),
	retract: async () => ({ok: true}),
	...partial,
});

const create_state = (partial: Partial<PermitOffersRpc> = {}): PermitOffersState =>
	new PermitOffersState({
		rpc: rpc_stub(partial),
		account_id: () => RECIPIENT_ID,
		actor_id: () => GRANTOR_ACTOR_ID,
	});

describe('PermitOffersState — seed', () => {
	test('fetch populates incoming from list', async () => {
		const offer = pending_offer();
		const state = create_state({list: async () => ({offers: [offer]})});

		await state.fetch();

		assert.strictEqual(state.incoming.length, 1);
		assert.strictEqual(state.incoming[0]!.id, offer.id);
		assert.strictEqual(state.error, null);
	});

	test('fetch_history merges both directions into the cache', async () => {
		const incoming = pending_offer({
			from_actor_id: OTHER_ACTOR_ID as PermitOfferJson['from_actor_id'],
		});
		const outgoing = pending_offer({
			from_actor_id: GRANTOR_ACTOR_ID as PermitOfferJson['from_actor_id'],
			to_account_id: OTHER_RECIPIENT_ID as PermitOfferJson['to_account_id'],
		});
		const state = create_state({history: async () => ({offers: [incoming, outgoing]})});

		await state.fetch_history();

		assert.strictEqual(state.history.length, 2);
		assert.strictEqual(state.incoming.length, 1);
		assert.strictEqual(state.incoming[0]!.id, incoming.id);
		assert.strictEqual(state.outgoing.length, 1);
		assert.strictEqual(state.outgoing[0]!.id, outgoing.id);
	});

	test('incoming sorts by soonest-expiry first', async () => {
		const later = pending_offer({expires_at: new Date(Date.now() + 10_000_000).toISOString()});
		const sooner = pending_offer({expires_at: new Date(Date.now() + 1_000_000).toISOString()});
		const state = create_state({list: async () => ({offers: [later, sooner]})});

		await state.fetch();

		assert.strictEqual(state.incoming[0]!.id, sooner.id);
		assert.strictEqual(state.incoming[1]!.id, later.id);
	});

	test('incoming filters out expired rows', async () => {
		const expired = pending_offer({expires_at: new Date(Date.now() - 1000).toISOString()});
		const state = create_state({list: async () => ({offers: [expired]})});

		await state.fetch();

		assert.strictEqual(state.incoming.length, 0);
		assert.strictEqual(state.history.length, 1);
	});

	test('incoming filters out offers addressed elsewhere', async () => {
		const theirs = pending_offer({
			to_account_id: OTHER_RECIPIENT_ID as PermitOfferJson['to_account_id'],
		});
		const state = create_state({list: async () => ({offers: [theirs]})});

		await state.fetch();

		assert.strictEqual(state.incoming.length, 0);
	});

	test('fetch records RPC failure in error', async () => {
		const state = create_state({
			list: async () => {
				throw new Error('boom');
			},
		});

		await state.fetch();

		assert.strictEqual(state.error, 'boom');
	});
});

describe('PermitOffersState — reducer', () => {
	test('permit_offer_received adds a new offer to incoming', () => {
		const state = create_state();
		const offer = pending_offer();

		state.apply_notification({
			method: PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
			params: {offer},
		});

		assert.strictEqual(state.incoming.length, 1);
		assert.strictEqual(state.incoming[0]!.id, offer.id);
	});

	test('permit_offer_retracted stamps the offer terminal and removes it from incoming', () => {
		const state = create_state();
		const offer = pending_offer();
		state.apply_notification({
			method: PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
			params: {offer},
		});
		assert.strictEqual(state.incoming.length, 1);

		const retracted: PermitOfferJson = {...offer, retracted_at: new Date().toISOString()};
		state.apply_notification({
			method: PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD,
			params: {offer: retracted},
		});

		assert.strictEqual(state.incoming.length, 0);
		assert.strictEqual(state.history.length, 1);
		assert.strictEqual(state.history[0]!.retracted_at, retracted.retracted_at);
	});

	test('permit_offer_accepted terminates the outgoing offer', () => {
		const state = create_state();
		const outgoing = pending_offer({
			to_account_id: OTHER_RECIPIENT_ID as PermitOfferJson['to_account_id'],
		});
		// seed as outgoing via history stub style — drop directly via notification:
		state.apply_notification({
			method: PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
			params: {offer: outgoing},
		});
		assert.strictEqual(state.outgoing.length, 1);

		const accepted: PermitOfferJson = {
			...outgoing,
			accepted_at: new Date().toISOString(),
			resulting_permit_id: next_uuid() as PermitOfferJson['resulting_permit_id'],
		};
		state.apply_notification({
			method: PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
			params: {offer: accepted},
		});

		assert.strictEqual(state.outgoing.length, 0);
	});

	test('permit_offer_declined terminates the outgoing offer and preserves decline_reason', () => {
		const state = create_state();
		const outgoing = pending_offer({
			to_account_id: OTHER_RECIPIENT_ID as PermitOfferJson['to_account_id'],
		});
		state.apply_notification({
			method: PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
			params: {offer: outgoing},
		});

		const declined: PermitOfferJson = {
			...outgoing,
			declined_at: new Date().toISOString(),
			decline_reason: 'busy',
		};
		state.apply_notification({
			method: PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD,
			params: {offer: declined},
		});

		assert.strictEqual(state.outgoing.length, 0);
		assert.strictEqual(state.history[0]!.decline_reason, 'busy');
	});

	test('permit_offer_supersede stamps an outgoing offer terminal', () => {
		const state = create_state();
		const outgoing = pending_offer({
			to_account_id: OTHER_RECIPIENT_ID as PermitOfferJson['to_account_id'],
		});
		state.apply_notification({
			method: PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
			params: {offer: outgoing},
		});

		const superseded: PermitOfferJson = {
			...outgoing,
			superseded_at: new Date().toISOString(),
		};
		state.apply_notification({
			method: PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
			params: {offer: superseded, reason: 'sibling_accepted', cause_id: next_uuid()},
		});

		assert.strictEqual(state.outgoing.length, 0);
		assert.strictEqual(state.history[0]!.superseded_at, superseded.superseded_at);
	});

	test('permit_revoke is a no-op for the offer cache', () => {
		const state = create_state();
		const offer = pending_offer();
		state.apply_notification({
			method: PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
			params: {offer},
		});

		state.apply_notification({
			method: PERMIT_REVOKE_NOTIFICATION_METHOD,
			params: {permit_id: next_uuid(), role: 'admin', scope_id: null, reason: null},
		});

		assert.strictEqual(state.incoming.length, 1);
		assert.strictEqual(state.incoming[0]!.id, offer.id);
	});

	test('unknown methods are silently ignored', () => {
		const state = create_state();
		state.apply_notification({method: 'totally_unrelated', params: {}});
		assert.strictEqual(state.history.length, 0);
	});

	test('malformed params are rejected without mutating state', () => {
		const state = create_state();
		state.apply_notification({
			method: PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
			params: {offer: {id: 'not-a-full-offer'}},
		});
		assert.strictEqual(state.history.length, 0);
	});
});

describe('PermitOffersState — subscribe', () => {
	test('subscribe plumbs notifications through apply_notification', () => {
		const state = create_state();
		const offer = pending_offer();
		const captured: {handler: ((n: {method: string; params: unknown}) => void) | null} = {
			handler: null,
		};
		const unsubscribe = state.subscribe((handler) => {
			captured.handler = handler;
			return () => {
				captured.handler = null;
			};
		});

		assert.ok(captured.handler);
		captured.handler({method: PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD, params: {offer}});
		assert.strictEqual(state.incoming.length, 1);

		unsubscribe();
		assert.strictEqual(captured.handler, null);
	});
});

describe('PermitOffersState — mutations', () => {
	test('create merges the returned offer into the cache', async () => {
		const offer = pending_offer({
			to_account_id: OTHER_RECIPIENT_ID as PermitOfferJson['to_account_id'],
		});
		const state = create_state({create: async () => ({offer})});

		await state.create({to_account_id: OTHER_RECIPIENT_ID, role: 'admin'});

		assert.strictEqual(state.outgoing.length, 1);
		assert.strictEqual(state.outgoing[0]!.id, offer.id);
	});

	test('create forwards to_actor_id to the rpc and stamps the returned actor-grain offer', async () => {
		const target_actor_id = next_uuid();
		const captured: {params: Parameters<PermitOffersRpc['create']>[0] | null} = {params: null};
		const offer = pending_offer({
			to_account_id: OTHER_RECIPIENT_ID as PermitOfferJson['to_account_id'],
			to_actor_id: target_actor_id as PermitOfferJson['to_actor_id'],
		});
		const state = create_state({
			create: async (params) => {
				captured.params = params;
				return {offer};
			},
		});

		await state.create({
			to_account_id: OTHER_RECIPIENT_ID,
			to_actor_id: target_actor_id,
			role: 'admin',
		});

		assert.deepStrictEqual(captured.params, {
			to_account_id: OTHER_RECIPIENT_ID,
			to_actor_id: target_actor_id,
			role: 'admin',
		});
		assert.strictEqual(state.outgoing.length, 1);
		assert.strictEqual(state.outgoing[0]!.to_actor_id, target_actor_id);
	});

	test('accept eagerly drops superseded siblings', async () => {
		const target = pending_offer();
		const sibling = pending_offer();
		const state = create_state({
			list: async () => ({offers: [target, sibling]}),
			accept: async () => ({
				permit_id: next_uuid(),
				offer: {
					...target,
					accepted_at: new Date().toISOString(),
					resulting_permit_id: next_uuid() as PermitOfferJson['resulting_permit_id'],
				},
				superseded_offer_ids: [sibling.id],
			}),
		});

		await state.fetch();
		assert.strictEqual(state.incoming.length, 2);

		await state.accept(target.id);

		assert.strictEqual(state.incoming.length, 0);
		assert.strictEqual(state.history.length, 1, 'sibling was removed; accepted row kept');
		assert.strictEqual(state.history[0]!.id, target.id);
	});

	test('decline removes the offer from the cache', async () => {
		const offer = pending_offer();
		const state = create_state({list: async () => ({offers: [offer]})});
		await state.fetch();

		await state.decline(offer.id, 'no thanks');

		assert.strictEqual(state.history.length, 0);
	});

	test('retract removes the offer from the cache', async () => {
		const outgoing = pending_offer({
			to_account_id: OTHER_RECIPIENT_ID as PermitOfferJson['to_account_id'],
		});
		const state = create_state({history: async () => ({offers: [outgoing]})});
		await state.fetch_history();

		await state.retract(outgoing.id);

		assert.strictEqual(state.history.length, 0);
	});
});

describe('PermitOffersState — reset', () => {
	test('reset clears the cache and loading/error', async () => {
		const offer = pending_offer();
		const state = create_state({list: async () => ({offers: [offer]})});
		await state.fetch();
		assert.strictEqual(state.history.length, 1);

		state.reset();

		assert.strictEqual(state.history.length, 0);
		assert.strictEqual(state.error, null);
		assert.strictEqual(state.loading, false);
	});
});
