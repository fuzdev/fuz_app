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
 * - **offer replay** — re-accepting an accepted offer whose grant still
 *   stands answers `200` with the same `role_grant_id` and writes no audit
 *   row; once the grant is revoked, the replay is refused `invalid_request`
 *   with reason `role_grant_offer_terminal` (never the revoked grant's id).
 * - **scoped assign** — `role_grant_assign` of `participant` with a paired
 *   `scope_kind` + `scope_id` lands a scoped grant carrying both, read back
 *   through `admin_account_list`, distinct from the global grant.
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
 * @module
 */

import { describe, test, assert } from 'vitest';

import { rpc_call, type RpcCallResult } from '../rpc_helpers.ts';
import { AuditLogListOutput } from '../../auth/admin_action_specs.ts';
import { ERROR_ROLE_GRANT_OFFER_TERMINAL } from '../../auth/role_grant_offer_action_specs.ts';
import { JSONRPC_INVALID_REQUEST } from '../../http/jsonrpc.ts';
import { SPINE_PARTICIPANT_ROLE, SPINE_RPC_PATH } from './spine_surface_constants.ts';
import type { SetupTest } from './setup.ts';

/** Options for the role-gated-participation success-path parity suite. */
export interface RoleGrantParticipationCrossTestOptions {
	/** Per-test fixture producer (in-process or cross-process). */
	readonly setup_test: SetupTest;
	/** RPC endpoint path. Default `/api/rpc`. */
	readonly rpc_path?: string;
}

export const describe_role_grant_participation_cross_tests = (
	options: RoleGrantParticipationCrossTestOptions
): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	const rpc = (
		transport: Parameters<typeof rpc_call>[0]['app'],
		method: string,
		params: unknown,
		headers: Record<string, string>
	): Promise<RpcCallResult> =>
		rpc_call({ app: transport, path: rpc_path, method, params, headers });

	describe('role-gated participation conferral (success paths)', () => {
		test('admin assigns the participant app-role to a fresh account (idempotent)', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'participation_assignee' });

			// The keeper holds ROLE_ADMIN (seeded via extra_keeper_roles), so it
			// clears the dispatcher admin gate; `participant` is admin-grantable, so
			// it clears the grant-path gate; the recipient is single-actor, so the
			// target actor resolves without `to_actor_id`.
			const first = await rpc(
				fixture.transport,
				'role_grant_assign',
				{ to_account_id: recipient.account.id, role: SPINE_PARTICIPANT_ROLE },
				fixture.create_session_headers()
			);
			assert.ok(first.ok, `assign must succeed: ${JSON.stringify(first)}`);
			const assigned = first.result as { ok: boolean; role_grant_id: string };
			assert.strictEqual(assigned.ok, true);
			assert.ok(
				typeof assigned.role_grant_id === 'string' && assigned.role_grant_id.length > 0,
				'assign returns the new role_grant id'
			);

			// Idempotent — re-assigning the active grant returns the existing id.
			const second = await rpc(
				fixture.transport,
				'role_grant_assign',
				{ to_account_id: recipient.account.id, role: SPINE_PARTICIPANT_ROLE },
				fixture.create_session_headers()
			);
			assert.ok(second.ok, `re-assign must succeed: ${JSON.stringify(second)}`);
			assert.strictEqual(
				(second.result as { role_grant_id: string }).role_grant_id,
				assigned.role_grant_id,
				're-assigning an active grant returns the existing role_grant id'
			);
		});

		test('admin assigns a scoped participant grant that round-trips scope_kind', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'participation_scoped' });
			const scope_id = '33333333-3333-4333-8333-333333333333';

			const scoped = await rpc(
				fixture.transport,
				'role_grant_assign',
				{
					to_account_id: recipient.account.id,
					role: SPINE_PARTICIPANT_ROLE,
					scope_kind: 'space',
					scope_id
				},
				fixture.create_session_headers()
			);
			assert.ok(scoped.ok, `scoped assign must succeed: ${JSON.stringify(scoped)}`);
			const scoped_id = (scoped.result as { role_grant_id: string }).role_grant_id;

			const global = await rpc(
				fixture.transport,
				'role_grant_assign',
				{ to_account_id: recipient.account.id, role: SPINE_PARTICIPANT_ROLE },
				fixture.create_session_headers()
			);
			assert.ok(global.ok, `global assign must succeed: ${JSON.stringify(global)}`);
			const global_id = (global.result as { role_grant_id: string }).role_grant_id;
			assert.notStrictEqual(global_id, scoped_id, 'the global grant is a distinct row');

			const listed = await rpc(
				fixture.transport,
				'admin_account_list',
				{},
				fixture.create_session_headers()
			);
			assert.ok(listed.ok, `admin_account_list must succeed: ${JSON.stringify(listed)}`);
			const entry = (
				listed.result as {
					accounts: Array<{
						account: { id: string };
						role_grants: Array<{
							id: string;
							role: string;
							scope_kind: string | null;
							scope_id: string | null;
						}>;
					}>;
				}
			).accounts.find((a) => a.account.id === recipient.account.id);
			assert.ok(entry, 'the recipient is listed');
			const by_id = new Map(entry.role_grants.map((g) => [g.id, g]));
			const scoped_row = by_id.get(scoped_id);
			assert.ok(scoped_row, 'the scoped grant is listed');
			assert.strictEqual(scoped_row.role, SPINE_PARTICIPANT_ROLE);
			assert.strictEqual(scoped_row.scope_kind, 'space', 'scope_kind round-trips');
			assert.strictEqual(scoped_row.scope_id, scope_id, 'scope_id round-trips');
			const global_row = by_id.get(global_id);
			assert.ok(global_row, 'the global grant is listed');
			assert.strictEqual(global_row.scope_kind, null);
			assert.strictEqual(global_row.scope_id, null);
		});

		test('admin offers the participant app-role and the recipient accepts', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'participation_offeree' });

			// Admin-only conferral via the consent flow: the keeper (admin) offers
			// the app-role, proving the widened grant-path gate admits it through
			// the offer path too.
			const created = await rpc(
				fixture.transport,
				'role_grant_offer_create',
				{ to_account_id: recipient.account.id, role: SPINE_PARTICIPANT_ROLE },
				fixture.create_session_headers()
			);
			assert.ok(created.ok, `offer create must succeed: ${JSON.stringify(created)}`);
			const offer_id = (created.result as { offer: { id: string } }).offer.id;

			// The recipient accepts → a role_grant lands.
			const accepted = await rpc(
				fixture.fresh_transport(),
				'role_grant_offer_accept',
				{ offer_id },
				recipient.create_session_headers()
			);
			assert.ok(accepted.ok, `accept must succeed: ${JSON.stringify(accepted)}`);
			assert.ok(
				typeof (accepted.result as { role_grant_id?: unknown }).role_grant_id === 'string',
				'accept lands a role_grant for the app-role'
			);
		});

		/** Offer `participant` to `recipient` as the keeper and accept it; returns the ids. */
		const offer_and_accept = async (
			fixture: Awaited<ReturnType<SetupTest>>,
			recipient: Awaited<ReturnType<Awaited<ReturnType<SetupTest>>['create_account']>>
		): Promise<{ offer_id: string; role_grant_id: string }> => {
			const created = await rpc(
				fixture.transport,
				'role_grant_offer_create',
				{ to_account_id: recipient.account.id, role: SPINE_PARTICIPANT_ROLE },
				fixture.create_session_headers()
			);
			assert.ok(created.ok, `offer create must succeed: ${JSON.stringify(created)}`);
			const offer_id = (created.result as { offer: { id: string } }).offer.id;
			const accepted = await rpc(
				fixture.fresh_transport(),
				'role_grant_offer_accept',
				{ offer_id },
				recipient.create_session_headers()
			);
			assert.ok(accepted.ok, `accept must succeed: ${JSON.stringify(accepted)}`);
			const { role_grant_id } = accepted.result as { role_grant_id: string };
			return { offer_id, role_grant_id };
		};

		/** How many `event_type` audit rows the keeper can list. */
		const count_audit_rows = async (
			fixture: Awaited<ReturnType<SetupTest>>,
			event_type: string
		): Promise<number> => {
			const listed = await rpc(
				fixture.transport,
				'audit_log_list',
				{ event_type },
				fixture.create_session_headers()
			);
			assert.ok(listed.ok, `audit_log_list must succeed: ${JSON.stringify(listed)}`);
			return AuditLogListOutput.parse(listed.result).events.length;
		};

		test('re-accepting an accepted offer answers the same grant and writes no audit row', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'participation_replayer' });
			const { offer_id, role_grant_id } = await offer_and_accept(fixture, recipient);
			const accept_rows = await count_audit_rows(fixture, 'role_grant_offer_accept');
			const create_rows = await count_audit_rows(fixture, 'role_grant_create');
			assert.ok(accept_rows >= 1, 'the accept itself is audited');

			const replayed = await rpc(
				fixture.fresh_transport(),
				'role_grant_offer_accept',
				{ offer_id },
				recipient.create_session_headers()
			);

			assert.ok(replayed.ok, `a replay of a held grant must succeed: ${JSON.stringify(replayed)}`);
			assert.strictEqual(
				(replayed.result as { role_grant_id: string }).role_grant_id,
				role_grant_id,
				'a replay answers the grant the accept minted'
			);
			assert.strictEqual(
				await count_audit_rows(fixture, 'role_grant_offer_accept'),
				accept_rows,
				'a replay writes no role_grant_offer_accept row'
			);
			assert.strictEqual(
				await count_audit_rows(fixture, 'role_grant_create'),
				create_rows,
				'a replay writes no role_grant_create row'
			);
		});

		test('re-accepting an offer whose grant was revoked is refused as terminal', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'participation_revoked' });
			const { offer_id, role_grant_id } = await offer_and_accept(fixture, recipient);
			const revoked = await rpc(
				fixture.transport,
				'role_grant_revoke',
				{ actor_id: recipient.actor.id, role_grant_id },
				fixture.create_session_headers()
			);
			assert.ok(revoked.ok, `revoke must succeed: ${JSON.stringify(revoked)}`);

			const replayed = await rpc(
				fixture.fresh_transport(),
				'role_grant_offer_accept',
				{ offer_id },
				recipient.create_session_headers()
			);

			assert.ok(!replayed.ok, `a replay after revoke must be refused: ${JSON.stringify(replayed)}`);
			assert.strictEqual(replayed.status, 400);
			assert.strictEqual(replayed.error.code, JSONRPC_INVALID_REQUEST);
			assert.deepStrictEqual(replayed.error.data, { reason: ERROR_ROLE_GRANT_OFFER_TERMINAL });
		});
	});
};
