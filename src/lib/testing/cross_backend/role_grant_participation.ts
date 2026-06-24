import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for **role-gated participation conferral — the
 * success paths**. The imperative escape hatch beneath the declarative
 * `conformance_participation_cases.ts`: the multi-step flows that need a real
 * recipient account (so a static conformance row can't express them) — an
 * admin assigns the `participant` app-role, and an admin offers it through the
 * consent flow and the recipient accepts.
 *
 * Proves the two conferral *write* paths agree on both spines (TS spine binary
 * + Rust `testing_spine_stub`):
 *
 * - **immediate assign** — `role_grant_assign` of the admin-grantable
 *   `participant` role lands a grant and returns `{ok, role_grant_id}`;
 *   re-assigning the active grant is idempotent (same id).
 * - **consent flow** — `role_grant_offer_create` of `participant` (admin-only)
 *   → the recipient `role_grant_offer_accept`s → a role_grant lands.
 *
 * The single-request gate/denial matrix (grantability refusal, admin-only
 * conferral, dispatcher admin gate, auth) lives in the declarative table
 * (`conformance_participation_cases.ts`) — keep new single-request assertions
 * there; this suite is only for flows the table cannot carry.
 *
 * The `participant` role is registered admin-grantable on both spines
 * (`spine_roles` / the Rust stub's `RoleRegistry`), so the suite is ungated;
 * every spine mounts the standard RPC surface it drives.
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {rpc_call, type RpcCallResult} from '../rpc_helpers.ts';
import {SPINE_PARTICIPANT_ROLE, SPINE_RPC_PATH} from './spine_surface_constants.ts';
import type {SetupTest} from './setup.ts';

/** Options for the role-gated-participation success-path parity suite. */
export interface RoleGrantParticipationCrossTestOptions {
	/** Per-test fixture producer (in-process or cross-process). */
	readonly setup_test: SetupTest;
	/** RPC endpoint path. Default `/api/rpc`. */
	readonly rpc_path?: string;
}

export const describe_role_grant_participation_cross_tests = (
	options: RoleGrantParticipationCrossTestOptions,
): void => {
	const {setup_test} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	const rpc = (
		transport: Parameters<typeof rpc_call>[0]['app'],
		method: string,
		params: unknown,
		headers: Record<string, string>,
	): Promise<RpcCallResult> => rpc_call({app: transport, path: rpc_path, method, params, headers});

	describe('role-gated participation conferral (success paths)', () => {
		test('admin assigns the participant app-role to a fresh account (idempotent)', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({username: 'participation_assignee'});

			// The keeper holds ROLE_ADMIN (seeded via extra_keeper_roles), so it
			// clears the dispatcher admin gate; `participant` is admin-grantable, so
			// it clears the grant-path gate; the recipient is single-actor, so the
			// target actor resolves without `to_actor_id`.
			const first = await rpc(
				fixture.transport,
				'role_grant_assign',
				{to_account_id: recipient.account.id, role: SPINE_PARTICIPANT_ROLE},
				fixture.create_session_headers(),
			);
			assert.ok(first.ok, `assign must succeed: ${JSON.stringify(first)}`);
			const assigned = first.result as {ok: boolean; role_grant_id: string};
			assert.strictEqual(assigned.ok, true);
			assert.ok(
				typeof assigned.role_grant_id === 'string' && assigned.role_grant_id.length > 0,
				'assign returns the new role_grant id',
			);

			// Idempotent — re-assigning the active grant returns the existing id.
			const second = await rpc(
				fixture.transport,
				'role_grant_assign',
				{to_account_id: recipient.account.id, role: SPINE_PARTICIPANT_ROLE},
				fixture.create_session_headers(),
			);
			assert.ok(second.ok, `re-assign must succeed: ${JSON.stringify(second)}`);
			assert.strictEqual(
				(second.result as {role_grant_id: string}).role_grant_id,
				assigned.role_grant_id,
				're-assigning an active grant returns the existing role_grant id',
			);
		});

		test('admin offers the participant app-role and the recipient accepts', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({username: 'participation_offeree'});

			// Admin-only conferral via the consent flow: the keeper (admin) offers
			// the app-role, proving the widened grant-path gate admits it through
			// the offer path too.
			const created = await rpc(
				fixture.transport,
				'role_grant_offer_create',
				{to_account_id: recipient.account.id, role: SPINE_PARTICIPANT_ROLE},
				fixture.create_session_headers(),
			);
			assert.ok(created.ok, `offer create must succeed: ${JSON.stringify(created)}`);
			const offer_id = (created.result as {offer: {id: string}}).offer.id;

			// The recipient accepts → a role_grant lands.
			const accepted = await rpc(
				fixture.fresh_transport(),
				'role_grant_offer_accept',
				{offer_id},
				recipient.create_session_headers(),
			);
			assert.ok(accepted.ok, `accept must succeed: ${JSON.stringify(accepted)}`);
			assert.ok(
				typeof (accepted.result as {role_grant_id?: unknown}).role_grant_id === 'string',
				'accept lands a role_grant for the app-role',
			);
		});
	});
};
