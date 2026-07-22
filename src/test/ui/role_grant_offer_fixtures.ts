/**
 * Shared `RoleGrantOfferJson` fixture for UI state-class tests. Both
 * `admin_accounts_state.svelte.test.ts` and `admin_sessions_state.svelte.test.ts`
 * stub the admin RPC adapter's `create_role_grant` to return
 * `{offer: make_offer()}`; the fixture mirrors the wire shape with safe
 * defaults so per-test overrides stay minimal.
 *
 * Not itself a test file — no `.test.` infix means vitest does not pick
 * it up.
 *
 * @module
 */

import type { RoleGrantOfferJson } from '$lib/auth/role_grant_offer_schema.ts';

/** Build a default-shaped `RoleGrantOfferJson` for stubs; override any field. */
export const make_offer = (overrides: Partial<RoleGrantOfferJson> = {}): RoleGrantOfferJson => ({
	id: 'offer-x' as RoleGrantOfferJson['id'],
	from_actor_id: 'actor-admin' as RoleGrantOfferJson['from_actor_id'],
	to_account_id: 'acct-1' as RoleGrantOfferJson['to_account_id'],
	to_actor_id: null,
	role: 'admin',
	scope_kind: null,
	scope_id: null,
	message: null,
	created_at: '2026-01-01T00:00:00.000Z',
	expires_at: '2026-02-01T00:00:00.000Z',
	accepted_at: null,
	declined_at: null,
	decline_reason: null,
	retracted_at: null,
	superseded_at: null,
	resulting_role_grant_id: null,
	...overrides
});
