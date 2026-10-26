import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **role-grant-offer decline and retract
 * refusals** — the error paths beneath the happy-path WS notification suite
 * (`describe_role_grant_offer_notification_ws_tests`), which is the only other
 * cross-process caller of these two verbs.
 *
 * What both spines must agree on, per the handlers
 * (`auth/role_grant_offer_actions.ts` and the queries behind them):
 *
 * - **not yours → 404** `role_grant_offer_not_found`. Decline is scoped to the
 *   recipient account and retract to the grantor actor, so an offer the caller
 *   is not party to answers the same `not_found` as an id that names no offer
 *   (`docs/security.md` §"404-over-403 is the general mask"), and the offer is
 *   left pending. The scope check comes before the terminal check, so a
 *   stranger learns nothing of an offer's state either.
 * - **already decided → 400** `invalid_request` with reason
 *   `role_grant_offer_terminal` — a decline or retract after an accept, a
 *   second decline, a second retract, and either one after the other.
 * - **one audit row per success, none per refusal.** A decline writes
 *   `role_grant_offer_decline` attributed to the recipient and targeting the
 *   grantor, a retract `role_grant_offer_retract` attributed to the grantor
 *   and targeting the recipient, each with its event's metadata; the refusals
 *   above write nothing. Read through `list_audit_events`, which drains first
 *   and parses each row's metadata against its event's schema.
 *
 * Multi-step (each case needs an offer in a given state), so this is an
 * imperative suite; the single-request rows — decline and retract of an id
 * that names no offer — live in the conformance security slate. The verbs are
 * on every spine's standard RPC surface, so the suite is ungated. The keeper
 * is the grantor, so the fixture's keeper must hold `ROLE_ADMIN`
 * (`extra_keeper_roles`), and it offers an admin-grantable role — the
 * `role` option, `SPINE_PARTICIPANT_ROLE` by default; `ROLE_ADMIN` serves a
 * backend with only the builtin roles.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { rpc_call, type RpcCallResult } from '../rpc_helpers.ts';
import {
	ERROR_ROLE_GRANT_OFFER_NOT_FOUND,
	ERROR_ROLE_GRANT_OFFER_TERMINAL
} from '../../auth/role_grant_offer_action_specs.ts';
import { JSONRPC_INVALID_REQUEST } from '../../http/jsonrpc.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import { assert_audit_metadata_fields, list_audit_events } from './audit_cross_helpers.ts';
import { create_pending_role_grant_offer } from './role_grant_cross_helpers.ts';
import type { TestAccount } from '../app_server.ts';
import type { RpcPathCrossSuiteOptions, TestFixture } from './setup.ts';
import { SPINE_PARTICIPANT_ROLE, SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** A well-formed UUID that names no offer. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Options for `describe_role_grant_offer_lifecycle_cross_tests`. */
export interface RoleGrantOfferLifecycleCrossTestOptions extends RpcPathCrossSuiteOptions {
	/**
	 * The role offered — one the backend's registry holds with the `admin`
	 * grant path. Default `SPINE_PARTICIPANT_ROLE`, the spine's own; a backend
	 * with only the builtin roles passes `ROLE_ADMIN`.
	 */
	readonly role?: string;
}

export const describe_role_grant_offer_lifecycle_cross_tests = (
	options: RoleGrantOfferLifecycleCrossTestOptions
): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const role = options.role ?? SPINE_PARTICIPANT_ROLE;

	const rpc = (
		fixture: TestFixture,
		method: string,
		params: unknown,
		headers: Record<string, string>
	): Promise<RpcCallResult> =>
		rpc_call({ app: fixture.fresh_transport(), path: rpc_path, method, params, headers });

	/** A pending `role` offer from the keeper to `recipient`. */
	const create_offer = (fixture: TestFixture, recipient: TestAccount) =>
		create_pending_role_grant_offer(fixture, recipient.account.id, undefined, {
			role,
			rpc_path
		});

	const decline = (
		fixture: TestFixture,
		offer_id: string,
		headers: Record<string, string>,
		reason?: string
	) =>
		rpc(
			fixture,
			'role_grant_offer_decline',
			reason === undefined ? { offer_id } : { offer_id, reason },
			headers
		);

	const retract = (fixture: TestFixture, offer_id: string, headers: Record<string, string>) =>
		rpc(fixture, 'role_grant_offer_retract', { offer_id }, headers);

	const accept = (fixture: TestFixture, offer_id: string, headers: Record<string, string>) =>
		rpc(fixture, 'role_grant_offer_accept', { offer_id }, headers);

	const assert_ok = (res: RpcCallResult, label: string): void => {
		assert.ok(res.ok, `${label} must succeed: ${JSON.stringify(res)}`);
	};

	/** The masked refusal, returned as `{status, error}` for an identity comparison. */
	const assert_not_found = (
		res: RpcCallResult,
		label: string
	): { status: number; error: unknown } => {
		assert.ok(!res.ok, `${label} must be refused: ${JSON.stringify(res)}`);
		assert.strictEqual(res.status, 404, label);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.not_found, label);
		assert.deepStrictEqual(res.error.data, { reason: ERROR_ROLE_GRANT_OFFER_NOT_FOUND }, label);
		return { status: res.status, error: res.error };
	};

	const assert_terminal = (res: RpcCallResult, label: string): void => {
		assert.ok(!res.ok, `${label} must be refused: ${JSON.stringify(res)}`);
		assert.strictEqual(res.status, 400, label);
		assert.strictEqual(res.error.code, JSONRPC_INVALID_REQUEST, label);
		assert.deepStrictEqual(res.error.data, { reason: ERROR_ROLE_GRANT_OFFER_TERMINAL }, label);
	};

	/** Whether `offer_id` is still in the recipient's pending inbox. */
	const is_pending = async (
		fixture: TestFixture,
		recipient: TestAccount,
		offer_id: string
	): Promise<boolean> => {
		const listed = await rpc(
			fixture,
			'role_grant_offer_list',
			{},
			recipient.create_session_headers()
		);
		if (!listed.ok) assert.fail(`role_grant_offer_list failed: ${JSON.stringify(listed)}`);
		const { offers } = listed.result as { offers: Array<{ id: string }> };
		return offers.some((offer) => offer.id === offer_id);
	};

	describe('role_grant_offer decline + retract refusals', () => {
		test('a decline by anyone but the recipient → 404, identical to a missing offer; the offer stays pending', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'lifecycle_decline_to' });
			const stranger = await fixture.create_account({ username: 'lifecycle_decline_by' });
			const offer = await create_offer(fixture, recipient);

			const missing = assert_not_found(
				await decline(fixture, NIL_UUID, stranger.create_session_headers()),
				'a decline of a missing offer'
			);
			const by_stranger = assert_not_found(
				await decline(fixture, offer.id, stranger.create_session_headers()),
				'a stranger declining'
			);
			assert.deepStrictEqual(
				by_stranger,
				missing,
				'a stranger declining a real offer must hear what a missing offer answers'
			);
			// the grantor is a party to the offer, but not its recipient
			assert_not_found(
				await decline(fixture, offer.id, fixture.create_session_headers()),
				'the grantor declining its own offer'
			);

			assert.ok(await is_pending(fixture, recipient, offer.id), 'the refusals leave it pending');
			assert_ok(await decline(fixture, offer.id, recipient.create_session_headers()), 'decline');
		});

		test('a retract by anyone but the grantor → 404, identical to a missing offer; the offer stays pending', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'lifecycle_retract_to' });
			const stranger = await fixture.create_account({ username: 'lifecycle_retract_by' });
			const offer = await create_offer(fixture, recipient);

			const missing = assert_not_found(
				await retract(fixture, NIL_UUID, stranger.create_session_headers()),
				'a retract of a missing offer'
			);
			const by_stranger = assert_not_found(
				await retract(fixture, offer.id, stranger.create_session_headers()),
				'a stranger retracting'
			);
			assert.deepStrictEqual(
				by_stranger,
				missing,
				'a stranger retracting a real offer must hear what a missing offer answers'
			);
			assert_not_found(
				await retract(fixture, offer.id, recipient.create_session_headers()),
				'the recipient retracting'
			);

			assert.ok(await is_pending(fixture, recipient, offer.id), 'the refusals leave it pending');
			assert_ok(await retract(fixture, offer.id, fixture.create_session_headers()), 'retract');
		});

		test('a decline or retract after accept → 400 role_grant_offer_terminal; a stranger still gets 404', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'lifecycle_accepted' });
			const stranger = await fixture.create_account({ username: 'lifecycle_after_accept' });
			const offer = await create_offer(fixture, recipient);
			assert_ok(await accept(fixture, offer.id, recipient.create_session_headers()), 'accept');

			assert_terminal(
				await decline(fixture, offer.id, recipient.create_session_headers()),
				'a decline after accept'
			);
			assert_terminal(
				await retract(fixture, offer.id, fixture.create_session_headers()),
				'a retract after accept'
			);
			// the scope check runs before the terminal check, so a non-party
			// learns nothing of the offer's state
			assert_not_found(
				await decline(fixture, offer.id, stranger.create_session_headers()),
				'a stranger declining an accepted offer'
			);
			assert_not_found(
				await retract(fixture, offer.id, stranger.create_session_headers()),
				'a stranger retracting an accepted offer'
			);
		});

		test('a second decline, a second retract, and either after the other → 400 role_grant_offer_terminal', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'lifecycle_twice' });
			const recipient_headers = recipient.create_session_headers();
			const grantor_headers = fixture.create_session_headers();

			const declined = await create_offer(fixture, recipient);
			assert_ok(await decline(fixture, declined.id, recipient_headers), 'the first decline');
			assert_terminal(await decline(fixture, declined.id, recipient_headers), 'a second decline');
			assert_terminal(
				await retract(fixture, declined.id, grantor_headers),
				'a retract after decline'
			);

			const retracted = await create_offer(fixture, recipient);
			assert_ok(await retract(fixture, retracted.id, grantor_headers), 'the first retract');
			assert_terminal(await retract(fixture, retracted.id, grantor_headers), 'a second retract');
			assert_terminal(
				await decline(fixture, retracted.id, recipient_headers),
				'a decline after retract'
			);
		});

		test('a decline and a retract each write one audit row; their refusals write none', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'lifecycle_audited' });
			const stranger = await fixture.create_account({ username: 'lifecycle_unaudited' });
			const recipient_headers = recipient.create_session_headers();
			const grantor_headers = fixture.create_session_headers();

			const with_reason = await create_offer(fixture, recipient);
			assert_ok(await decline(fixture, with_reason.id, recipient_headers, 'not now'), 'decline');
			const without_reason = await create_offer(fixture, recipient);
			assert_ok(await decline(fixture, without_reason.id, recipient_headers), 'decline');
			const retracted = await create_offer(fixture, recipient);
			assert_ok(await retract(fixture, retracted.id, grantor_headers), 'retract');

			const read = async () => ({
				declines: await list_audit_events(
					fixture,
					{ event_type: 'role_grant_offer_decline' },
					rpc_path
				),
				retracts: await list_audit_events(
					fixture,
					{ event_type: 'role_grant_offer_retract' },
					rpc_path
				)
			});
			const before = await read();

			const decline_row = (offer_id: string) => {
				const rows = before.declines.filter(
					(e) => (e.metadata as { offer_id?: unknown } | null)?.offer_id === offer_id
				);
				assert.strictEqual(rows.length, 1, `one role_grant_offer_decline row for ${offer_id}`);
				return rows[0]!;
			};
			for (const [offer_id, reason] of [
				[with_reason.id, 'not now'],
				[without_reason.id, undefined]
			] as const) {
				const row = decline_row(offer_id);
				assert.strictEqual(row.outcome, 'success');
				// a decline is the recipient's act, addressed to the grantor
				assert.strictEqual(row.account_id, recipient.account.id);
				assert.strictEqual(row.actor_id, recipient.actor.id);
				assert.strictEqual(row.target_account_id, fixture.account.id);
				assert.strictEqual(row.target_actor_id, fixture.actor.id);
				// a decline without a reason records none — absent, not null
				assert_audit_metadata_fields(
					fixture,
					row.metadata,
					reason === undefined
						? { offer_id, role, scope_id: null }
						: { offer_id, role, scope_id: null, reason },
					reason === undefined ? ['reason'] : []
				);
			}

			assert.strictEqual(before.retracts.length, 1, 'one role_grant_offer_retract row');
			const retract_row = before.retracts[0]!;
			assert.strictEqual(retract_row.outcome, 'success');
			// a retract is the grantor's act, addressed to the recipient; the
			// offer named no actor, so no target actor
			assert.strictEqual(retract_row.account_id, fixture.account.id);
			assert.strictEqual(retract_row.actor_id, fixture.actor.id);
			assert.strictEqual(retract_row.target_account_id, recipient.account.id);
			assert.strictEqual(retract_row.target_actor_id, null);
			assert_audit_metadata_fields(fixture, retract_row.metadata, {
				offer_id: retracted.id,
				role,
				scope_id: null
			});

			// every refusal: not a party, then already decided
			const pending = await create_offer(fixture, recipient);
			assert_not_found(
				await decline(fixture, pending.id, stranger.create_session_headers()),
				'a stranger declining'
			);
			assert_not_found(
				await retract(fixture, pending.id, stranger.create_session_headers()),
				'a stranger retracting'
			);
			assert_terminal(await decline(fixture, with_reason.id, recipient_headers), 'a re-decline');
			assert_terminal(await retract(fixture, retracted.id, grantor_headers), 'a re-retract');
			assert_terminal(
				await decline(fixture, retracted.id, recipient_headers),
				'a decline after retract'
			);

			const after = await read();
			assert.strictEqual(after.declines.length, before.declines.length, 'no decline row added');
			assert.strictEqual(after.retracts.length, before.retracts.length, 'no retract row added');
		});
	});
};
