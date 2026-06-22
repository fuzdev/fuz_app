import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **role_grant_offer_accept enumeration
 * boundary** — the deliberate 403-vs-404 split on the accept path.
 *
 * `role_grant_offer_accept` distinguishes two denials, and the distinction is a
 * conscious decision (not an accident to mask away):
 *
 * - **a genuinely-nonexistent offer (or one on another account) → 404**
 *   `role_grant_offer_not_found`. The account-scoped IDOR guard refuses to
 *   confirm an offer id the caller's account doesn't own — so a cross-account
 *   prober learns nothing.
 * - **an offer that exists on the caller's OWN account but is targeted to a
 *   different actor (a sibling persona) → 403** `role_grant_offer_actor_mismatch`.
 *   This reveals "an offer exists for a sibling actor" to a co-account caller —
 *   but there is **no cross-account leak**: every actor in the distinction
 *   belongs to the one account already authenticated, so the 403 discloses
 *   nothing a principal can't already see about its own account. Masking this to
 *   404 would only obscure a legitimate "not yours to accept, pick the right
 *   persona" signal. So 403 is the chosen, defensible behavior — and both spines
 *   must agree on it (a future Rust or TS change that over-masked the sibling
 *   case to 404, or under-masked the cross-account case to 403, is the
 *   regression this suite catches).
 *
 * The actor-mismatch arm only fires for an *actor-targeted* offer accepted by a
 * sibling actor, so the suite needs a multi-actor recipient. The keeper is the
 * only fixture account that can be seeded multi-actor (`extra_actors`), and an
 * account can't offer to itself — so the grantor is a separate admin account and
 * the recipient is the keeper (actor A = `fixture.actor` is the offer target;
 * actor B = `fixture.extra_actors[0]` is the rejected sibling).
 *
 * Multi-step (create → accept) and using the `acting` selector, so this is an
 * imperative suite (not a `conformance_table` row). The accept verb is on every
 * spine's standard RPC surface, so the suite is ungated. Cross-process only: the
 * sibling-actor / actor-targeted-offer setup is a wire flow. Cited property:
 * `docs/security.md` §"Authorization" (the 404-over-403 mask is scoped to
 * cross-principal leaks; an intra-account sibling-actor offer stays a 403
 * `role_grant_offer_actor_mismatch`).
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {rpc_call, type RpcCallResult} from '../rpc_helpers.ts';
import {ROLE_ADMIN} from '../../auth/role_schema.ts';
import {
	ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH,
	ERROR_ROLE_GRANT_OFFER_NOT_FOUND,
} from '../../auth/role_grant_offer_action_specs.ts';
import {SPINE_RPC_PATH} from './default_spine_surface.ts';
import type {SetupTest} from './setup.ts';

/** A well-formed UUID that never names a real offer — exercises the not-found arm. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Username of the bootstrap-seeded single-actor admin grantor. The entrypoint
 * seeds it via `extra_accounts: [{username: OFFER_GRANTOR_USERNAME, roles:
 * [ROLE_ADMIN]}]`. A *separate* account is required (an account can't offer to
 * itself), and it must be single-actor so its `role_grant_offer_create` resolves
 * without an `acting` selector — which rules out the now-multi-actor keeper and
 * `fixture.create_account` (whose internal `invite_create` runs as the
 * multi-actor keeper and would hit `actor_required`).
 */
export const OFFER_GRANTOR_USERNAME = 'offer_grantor';

/** Options for the offer-enumeration parity suite. */
export interface RoleGrantOfferEnumerationCrossTestOptions {
	/**
	 * Per-test fixture producer. **Must be configured with `extra_actors`** (≥1)
	 * so the keeper is multi-actor and the sibling-actor mismatch arm is
	 * reachable — the entrypoint passes
	 * `default_cross_process_setup(handle, {extra_actors: [...]})`.
	 */
	readonly setup_test: SetupTest;
	/** RPC endpoint path. Default `/api/rpc`. */
	readonly rpc_path?: string;
}

/** The `error.data.reason` of a failed RPC call, or `undefined`. */
const reason_of = (res: RpcCallResult): string | undefined =>
	res.ok
		? undefined
		: ((res.error.data as {reason?: unknown} | undefined)?.reason as string | undefined);

export const describe_role_grant_offer_enumeration_cross_tests = (
	options: RoleGrantOfferEnumerationCrossTestOptions,
): void => {
	const {setup_test} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	const rpc = (
		transport: Parameters<typeof rpc_call>[0]['app'],
		method: string,
		params: unknown,
		headers: Record<string, string>,
	): Promise<RpcCallResult> => rpc_call({app: transport, path: rpc_path, method, params, headers});

	describe('role_grant_offer accept enumeration (403 vs 404)', () => {
		test('actor-targeted offer: sibling-actor accept → 403 actor_mismatch; targeted actor accepts the SAME offer → 200', async () => {
			const fixture = await setup_test();
			const sibling = fixture.extra_actors[0];
			assert.ok(
				sibling,
				'suite requires the keeper seeded with an extra actor — pass extra_actors in the entrypoint',
			);
			// Actor A (the keeper's bootstrap actor) is the offer target; actor B
			// (the seeded sibling) is the one that must be rejected.
			const target_actor = fixture.actor;

			// Grantor must be a SEPARATE single-actor admin account (an account
			// can't offer to itself; the keeper is multi-actor here so its own
			// offer/invite calls would need an `acting`). Seeded via
			// `extra_accounts` in the entrypoint.
			const grantor = fixture.extra_accounts[OFFER_GRANTOR_USERNAME];
			assert.ok(
				grantor,
				`suite requires an admin grantor seeded via extra_accounts['${OFFER_GRANTOR_USERNAME}']`,
			);

			// Offer ROLE_ADMIN to the keeper's account, TARGETED at actor A.
			const created = await rpc(
				fixture.fresh_transport(),
				'role_grant_offer_create',
				{to_account_id: fixture.account.id, to_actor_id: target_actor.id, role: ROLE_ADMIN},
				grantor.create_session_headers(),
			);
			assert.ok(created.ok, `offer create must succeed: ${JSON.stringify(created)}`);
			const offer_id = (created.result as {offer: {id: string}}).offer.id;

			// Sibling actor B (same account) tries to accept A's offer → 403
			// actor_mismatch. The offer stays pending (no mutation on the denial).
			const sibling_accept = await rpc(
				fixture.transport,
				'role_grant_offer_accept',
				{offer_id, acting: sibling.id},
				fixture.create_session_headers(),
			);
			assert.strictEqual(sibling_accept.status, 403, 'sibling-actor accept must be 403');
			assert.strictEqual(
				reason_of(sibling_accept),
				ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH,
				'sibling-actor accept must carry the actor_mismatch reason (not a 404 mask)',
			);

			// Control: the TARGETED actor A accepts the very same offer → 200. Proves
			// the 403 above was a genuine wrong-actor signal, not a broken/unacceptable
			// offer (which would make the 403 vacuous).
			const target_accept = await rpc(
				fixture.transport,
				'role_grant_offer_accept',
				{offer_id, acting: target_actor.id},
				fixture.create_session_headers(),
			);
			assert.ok(
				target_accept.ok && target_accept.status === 200,
				`targeted-actor accept of the same offer must succeed: ${JSON.stringify(target_accept)}`,
			);
		});

		test('a nonexistent offer → 404 not_found (the cross-principal mask, distinct from the intra-account 403)', async () => {
			const fixture = await setup_test();
			// A valid `acting` (the keeper's own actor) so resolution passes and the
			// handler reaches the offer lookup — which finds nothing → 404.
			const res = await rpc(
				fixture.transport,
				'role_grant_offer_accept',
				{offer_id: NIL_UUID, acting: fixture.actor.id},
				fixture.create_session_headers(),
			);
			assert.strictEqual(res.status, 404, 'a nonexistent offer must be 404');
			assert.strictEqual(
				reason_of(res),
				ERROR_ROLE_GRANT_OFFER_NOT_FOUND,
				'a nonexistent offer must carry the not_found reason',
			);
		});
	});
};
