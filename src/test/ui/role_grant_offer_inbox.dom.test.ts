// @vitest-environment jsdom

/**
 * Client-mount tests for `RoleGrantOfferInbox` — each row reads its own
 * pending state and error, so one row's accept never blocks or marks another.
 *
 * @module
 */

import { describe, test, assert, vi, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import {
	RoleGrantOffersState,
	type RoleGrantOffersRpc
} from '#lib/ui/role_grant_offers_state.svelte.ts';
import type { RoleGrantOfferAcceptOutput } from '#lib/auth/role_grant_offer_action_specs.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import RoleGrantOfferInboxHarness from './RoleGrantOfferInboxHarness.svelte';
import { make_offer } from './role_grant_offer_fixtures.ts';
import { make_deferred } from './async_test_helpers.ts';

// vitest resolves the server builds, which can't mount — load the client builds
vi.mock('svelte', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('.')
);
// the keyed slots' `SvelteMap` must be the reactive client one
vi.mock('svelte/reactivity', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('./reactivity')
);

/** Resolve pending microtasks and macrotasks, then flush Svelte's effects. */
const settle = async (): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
};

let cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.reverse()) cleanup();
	cleanups = [];
});

const RECIPIENT_ID = '11111111-1111-1111-1111-111111111111' as Uuid;

/** A pending offer to `RECIPIENT_ID` that expires a day from now. */
const incoming_offer = (id: string) =>
	make_offer({
		id: id as Uuid,
		to_account_id: RECIPIENT_ID,
		expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
	});

const mount_inbox = async (rpc: Partial<RoleGrantOffersRpc>): Promise<HTMLElement> => {
	const state = new RoleGrantOffersState({
		rpc: {
			list: async () => ({ offers: [] }),
			history: async () => ({ offers: [] }),
			create: () => Promise.reject(new Error('not stubbed')),
			accept: () => Promise.reject(new Error('not stubbed')),
			decline: () => Promise.reject(new Error('not stubbed')),
			retract: () => Promise.reject(new Error('not stubbed')),
			...rpc
		},
		account_id: () => RECIPIENT_ID,
		actor_id: () => null
	});
	await state.fetch();
	const target = document.createElement('div');
	document.body.append(target);
	cleanups.push(() => target.remove());
	const component = mount(RoleGrantOfferInboxHarness, { target, props: { state } });
	cleanups.push(() => void unmount(component));
	await settle();
	return target;
};

const accept_buttons = (target: HTMLElement): Array<HTMLButtonElement> =>
	Array.from(target.querySelectorAll<HTMLButtonElement>('li button')).filter(
		(b) => b.textContent?.trim() === 'accept'
	);

describe('RoleGrantOfferInbox', () => {
	test("a row's accept failure shows on that row only, and never blocks another row", async () => {
		const first = incoming_offer('00000000-0000-4000-8000-000000000001');
		const second = incoming_offer('00000000-0000-4000-8000-000000000002');
		const pending = make_deferred<RoleGrantOfferAcceptOutput>();
		const target = await mount_inbox({
			list: async () => ({ offers: [first, second] }),
			accept: (offer_id) =>
				offer_id === first.id ? Promise.reject(new Error('first failed')) : pending.promise
		});
		const rows = Array.from(target.querySelectorAll<HTMLElement>('li'));
		assert.strictEqual(rows.length, 2);

		const [accept_first, accept_second] = accept_buttons(target);
		accept_second!.click();
		await settle();
		assert.isTrue(accept_second!.disabled, 'the pending row disables its own accept');
		assert.isFalse(accept_first!.disabled, 'another row stays live');

		accept_first!.click();
		await settle();
		const [row_first, row_second] = Array.from(target.querySelectorAll<HTMLElement>('li'));
		assert.include(row_first!.textContent, 'first failed');
		assert.notInclude(row_second!.textContent, 'first failed');
		pending.reject(new Error('cleanup'));
		await settle();
	});
});
