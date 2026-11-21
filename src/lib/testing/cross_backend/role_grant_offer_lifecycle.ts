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
 * - **a decline or retract answers the terminal offer** — the offer as the
 *   history then lists it, `declined_at` (with any `decline_reason`) or
 *   `retracted_at` stamped, as `accept` answers its own.
 * - **already decided → 400** `invalid_request` with reason
 *   `role_grant_offer_terminal` — a decline or retract after an accept, a
 *   second decline, a second retract, and either one after the other.
 * - **a decided offer can't be accepted.** An accept after a decline or a
 *   retract is `role_grant_offer_terminal` and grants nothing — the
 *   recipient holds no grant of the role and the offer reads back unaccepted.
 *   A second accept of an accepted offer is the idempotent replay: it answers
 *   the grant the first one minted, and the recipient holds that one grant.
 * - **a grantor's lost authority ends its pending offers.** Revoking a
 *   grantor's grant, or deleting its account, supersedes every pending offer
 *   it made — gone from the recipient's inbox, an accept answers
 *   `role_grant_offer_terminal`, and a `role_grant_offer_supersede` row records
 *   it (`role_grant_revoked` with the grant as cause, `account_deleted` with
 *   the account). The keeper's own `admin` grant refuses a revoke, 403
 *   `cannot_revoke_keeper_admin`.
 * - **a recipient's delete ends the offers made to it.** Deleting an account
 *   supersedes every pending offer to it, account- or actor-addressed and
 *   whoever made it, each with its `account_deleted` row and the account as
 *   cause, and the grantor's history lists it superseded. That an undelete
 *   brings none back is `describe_account_lifecycle_cross_tests`'.
 * - **a deleted recipient is a missing one.** An offer to a deleted account,
 *   or naming its actor, answers exactly what one to an account or actor that
 *   does not exist answers (404 `not_found`, or 400
 *   `role_grant_offer_actor_account_mismatch` when an actor is named) — the
 *   answers `role_grant_assign` gives the same requests — and creates
 *   nothing. A grantor without the authority to confer hears its 403
 *   `role_grant_offer_not_authorized` whatever the recipient — deleted,
 *   missing, or live — and an offer to one's own account is
 *   `role_grant_offer_self_target` whatever actor it names.
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
	ERROR_CANNOT_REVOKE_KEEPER_ADMIN,
	ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH,
	ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
	ERROR_ROLE_GRANT_OFFER_NOT_FOUND,
	ERROR_ROLE_GRANT_OFFER_SELF_TARGET,
	ERROR_ROLE_GRANT_OFFER_TERMINAL,
	RoleGrantOfferDeclineOutput,
	RoleGrantOfferHistoryOutput,
	RoleGrantOfferRetractOutput
} from '../../auth/role_grant_offer_action_specs.ts';
import { AdminAccountListOutput } from '../../auth/admin_action_specs.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import { expect_output } from './cross_rpc.ts';
import { JSONRPC_INVALID_REQUEST } from '../../http/jsonrpc.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import { assert_audit_metadata_fields, list_audit_events } from './audit_cross_helpers.ts';
import {
	create_active_role_grant,
	create_pending_role_grant_offer
} from './role_grant_cross_helpers.ts';
import type { TestAccount } from '../test_app.ts';
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

		test('a decline and a retract answer the terminal offer, as the history lists it', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'lifecycle_answered' });
			const grantor_headers = fixture.create_session_headers();

			const to_decline = await create_offer(fixture, recipient);
			const { offer: declined } = expect_output(
				await decline(fixture, to_decline.id, recipient.create_session_headers(), 'not now'),
				RoleGrantOfferDeclineOutput
			);
			assert.strictEqual(declined.id, to_decline.id);
			assert.ok(declined.declined_at, 'the declined offer carries declined_at');
			assert.strictEqual(declined.decline_reason, 'not now');
			assert.strictEqual(declined.retracted_at, null);

			const to_retract = await create_offer(fixture, recipient);
			const { offer: retracted } = expect_output(
				await retract(fixture, to_retract.id, grantor_headers),
				RoleGrantOfferRetractOutput
			);
			assert.strictEqual(retracted.id, to_retract.id);
			assert.ok(retracted.retracted_at, 'the retracted offer carries retracted_at');
			assert.strictEqual(retracted.declined_at, null);

			const { offers } = expect_output(
				await rpc(fixture, 'role_grant_offer_history', {}, grantor_headers),
				RoleGrantOfferHistoryOutput
			);
			assert.deepStrictEqual(
				offers.find((o) => o.id === declined.id),
				declined
			);
			assert.deepStrictEqual(
				offers.find((o) => o.id === retracted.id),
				retracted
			);
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

		test('an accept after a decline or a retract → 400 role_grant_offer_terminal, granting nothing; a second accept answers the first grant', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'lifecycle_late_accept' });
			const recipient_headers = recipient.create_session_headers();
			const grantor_headers = fixture.create_session_headers();

			/** The recipient's active grants of `role`, by id. */
			const held_grant_ids = async (): Promise<Array<string>> => {
				const listed = expect_output(
					await rpc(fixture, 'admin_account_list', {}, grantor_headers),
					AdminAccountListOutput
				);
				const entry = listed.accounts.find((a) => a.account.id === recipient.account.id);
				assert.ok(entry, 'the recipient is listed');
				return entry.role_grants.filter((g) => g.role === role).map((g) => g.id);
			};

			const declined = await create_offer(fixture, recipient);
			assert_ok(await decline(fixture, declined.id, recipient_headers), 'decline');
			assert_terminal(
				await accept(fixture, declined.id, recipient_headers),
				'an accept after decline'
			);
			const retracted = await create_offer(fixture, recipient);
			assert_ok(await retract(fixture, retracted.id, grantor_headers), 'retract');
			assert_terminal(
				await accept(fixture, retracted.id, recipient_headers),
				'an accept after retract'
			);

			// the refused accepts changed nothing: no grant, and each offer still
			// reads as it was decided
			assert.deepStrictEqual(await held_grant_ids(), [], 'a refused accept grants nothing');
			const { offers } = expect_output(
				await rpc(fixture, 'role_grant_offer_history', {}, grantor_headers),
				RoleGrantOfferHistoryOutput
			);
			for (const [offer_id, label] of [
				[declined.id, 'declined'],
				[retracted.id, 'retracted']
			] as const) {
				const offer = offers.find((o) => o.id === offer_id);
				assert.ok(offer, `the ${label} offer is in the history`);
				assert.strictEqual(offer.accepted_at, null, `the ${label} offer stays unaccepted`);
				assert.strictEqual(offer.resulting_role_grant_id, null, label);
			}

			// a replayed accept is idempotent: the grant the first one minted,
			// and no second grant
			const accepted = await create_offer(fixture, recipient);
			const first = await accept(fixture, accepted.id, recipient_headers);
			assert.ok(first.ok, `the first accept must succeed: ${JSON.stringify(first)}`);
			const second = await accept(fixture, accepted.id, recipient_headers);
			assert.ok(second.ok, `a second accept must answer: ${JSON.stringify(second)}`);
			const { role_grant_id } = first.result as { role_grant_id: string };
			assert.strictEqual(
				(second.result as { role_grant_id: string }).role_grant_id,
				role_grant_id,
				'a second accept answers the first grant'
			);
			assert.deepStrictEqual(await held_grant_ids(), [role_grant_id], 'one grant, not two');
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

	describe("a grantor's lost authority ends its pending offers", () => {
		/** A grantor holding a global `admin` grant (offer authority) and its id. */
		const setup_grantor = async (fixture: TestFixture, username: string) => {
			const grantor = await fixture.create_account({ username });
			const grant_id = await create_active_role_grant(fixture, grantor, {
				role: ROLE_ADMIN,
				rpc_path
			});
			return { grantor, grant_id };
		};

		/** The pending `role` offer `grantor` makes to `recipient`. */
		const offer_from = (fixture: TestFixture, grantor: TestAccount, recipient: TestAccount) =>
			create_pending_role_grant_offer(
				fixture,
				recipient.account.id,
				grantor.create_session_headers(),
				{ role, rpc_path }
			);

		const assert_superseded = async (
			fixture: TestFixture,
			recipient: TestAccount,
			offer_id: string,
			cause: { reason: string; cause_id: string }
		): Promise<void> => {
			assert.ok(!(await is_pending(fixture, recipient, offer_id)), 'gone from the recipient inbox');
			assert_terminal(
				await accept(fixture, offer_id, recipient.create_session_headers()),
				'an accept of the superseded offer'
			);
			const rows = (
				await list_audit_events(fixture, { event_type: 'role_grant_offer_supersede' }, rpc_path)
			).filter((e) => (e.metadata as { offer_id?: unknown } | null)?.offer_id === offer_id);
			assert.strictEqual(rows.length, 1, 'one role_grant_offer_supersede row');
			assert_audit_metadata_fields(fixture, rows[0]!.metadata, {
				offer_id,
				role,
				scope_id: null,
				...cause
			});
		};

		test("revoking the grantor's grant supersedes its pending offers", async () => {
			const fixture = await setup_test();
			const { grantor, grant_id } = await setup_grantor(fixture, 'lost_authority_revoked');
			const recipient = await fixture.create_account({ username: 'lost_authority_to' });
			const offer = await offer_from(fixture, grantor, recipient);
			// another grantor's offer to the same recipient is the control
			const control = await create_offer(fixture, recipient);

			assert_ok(
				await rpc(
					fixture,
					'role_grant_revoke',
					{ actor_id: grantor.actor.id, role_grant_id: grant_id },
					fixture.create_session_headers()
				),
				'revoke'
			);
			await assert_superseded(fixture, recipient, offer.id, {
				reason: 'role_grant_revoked',
				cause_id: grant_id
			});
			assert.ok(await is_pending(fixture, recipient, control.id), "the keeper's offer stays");
		});

		test("deleting the grantor's account supersedes its pending offers", async () => {
			const fixture = await setup_test();
			const { grantor } = await setup_grantor(fixture, 'lost_authority_deleted');
			const recipient = await fixture.create_account({ username: 'lost_authority_del_to' });
			const offer = await offer_from(fixture, grantor, recipient);

			assert_ok(
				await rpc(
					fixture,
					'account_delete',
					{ account_id: grantor.account.id },
					fixture.create_session_headers()
				),
				'account_delete'
			);
			await assert_superseded(fixture, recipient, offer.id, {
				reason: 'account_deleted',
				cause_id: grantor.account.id
			});
		});

		test("the keeper's admin grant refuses a revoke → 403 cannot_revoke_keeper_admin", async () => {
			const fixture = await setup_test();
			const listed = expect_output(
				await rpc(fixture, 'admin_account_list', {}, fixture.create_session_headers()),
				AdminAccountListOutput
			);
			const keeper = listed.accounts.find((a) => a.account.id === fixture.account.id);
			const keeper_admin = keeper?.role_grants.find(
				(g) => g.role === ROLE_ADMIN && g.scope_id === null
			);
			assert.ok(keeper_admin, "the keeper's global admin grant");
			const refused = await rpc(
				fixture,
				'role_grant_revoke',
				{ actor_id: fixture.actor.id, role_grant_id: keeper_admin.id },
				fixture.create_session_headers()
			);
			assert.ok(!refused.ok, 'the keeper keeps its admin grant');
			assert.strictEqual(refused.status, 403);
			assert.strictEqual(refused.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.deepStrictEqual(refused.error.data, { reason: ERROR_CANNOT_REVOKE_KEEPER_ADMIN });
		});
	});

	describe("a recipient's delete ends the offers made to it", () => {
		const delete_account = async (fixture: TestFixture, account: TestAccount): Promise<void> => {
			assert_ok(
				await rpc(
					fixture,
					'account_delete',
					{ account_id: account.account.id },
					fixture.create_session_headers()
				),
				'account_delete'
			);
		};

		/** The offers `headers`' account made or received, as its history lists them. */
		const history = async (fixture: TestFixture, headers: Record<string, string>) =>
			expect_output(
				await rpc(fixture, 'role_grant_offer_history', {}, headers),
				RoleGrantOfferHistoryOutput
			).offers;

		test('deleting the recipient supersedes every pending offer to it, account- and actor-addressed', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'incoming_deleted_to' });
			const bystander = await fixture.create_account({ username: 'incoming_bystander' });
			const grantor = await fixture.create_account({ username: 'incoming_grantor' });
			await create_active_role_grant(fixture, grantor, { role: ROLE_ADMIN, rpc_path });
			const by_account = await create_offer(fixture, recipient);
			const created = await rpc(
				fixture,
				'role_grant_offer_create',
				{ to_account_id: recipient.account.id, to_actor_id: recipient.actor.id, role },
				grantor.create_session_headers()
			);
			if (!created.ok) assert.fail(`actor-addressed offer: ${JSON.stringify(created)}`);
			const by_actor = (created.result as { offer: { id: string } }).offer;
			const control = await create_offer(fixture, bystander);

			await delete_account(fixture, recipient);

			const supersedes = await list_audit_events(
				fixture,
				{ event_type: 'role_grant_offer_supersede' },
				rpc_path
			);
			for (const [offer_id, grantor_headers, label] of [
				[by_account.id, fixture.create_session_headers(), 'the account-addressed offer'],
				[by_actor.id, grantor.create_session_headers(), 'the actor-addressed offer']
			] as const) {
				const rows = supersedes.filter(
					(e) => (e.metadata as { offer_id?: unknown } | null)?.offer_id === offer_id
				);
				assert.strictEqual(rows.length, 1, `one role_grant_offer_supersede row for ${label}`);
				assert_audit_metadata_fields(fixture, rows[0]!.metadata, {
					offer_id,
					role,
					scope_id: null,
					reason: 'account_deleted',
					cause_id: recipient.account.id
				});
				const listed = (await history(fixture, grantor_headers)).find((o) => o.id === offer_id);
				assert.ok(listed?.superseded_at, `the grantor's history lists ${label} superseded`);
				assert.strictEqual(listed.accepted_at, null, label);
			}
			assert.ok(
				await is_pending(fixture, bystander, control.id),
				"another account's offer stays pending"
			);
		});

		test('an offer to a deleted account or actor answers as one to a missing account or actor does, as role_grant_assign does', async () => {
			const fixture = await setup_test();
			const recipient = await fixture.create_account({ username: 'incoming_refused_to' });
			const live = await fixture.create_account({ username: 'incoming_refused_live' });
			await delete_account(fixture, recipient);

			const call = (method: string, params: Record<string, unknown>) =>
				rpc(fixture, method, { ...params, role }, fixture.create_session_headers());
			const answer = (res: RpcCallResult, label: string) => {
				assert.ok(!res.ok, `${label} must be refused: ${JSON.stringify(res)}`);
				return { status: res.status, error: res.error };
			};

			const deleted_account = { to_account_id: recipient.account.id };
			const missing_account = { to_account_id: NIL_UUID };
			const deleted_actor = {
				to_account_id: recipient.account.id,
				to_actor_id: recipient.actor.id
			};
			const missing_actor = { to_account_id: live.account.id, to_actor_id: NIL_UUID };

			const account_refusal = answer(
				await call('role_grant_offer_create', missing_account),
				'an offer to a missing account'
			);
			assert.strictEqual(account_refusal.status, 404);
			assert.strictEqual(account_refusal.error.code, JSONRPC_ERROR_CODES.not_found);
			const actor_refusal = answer(
				await call('role_grant_offer_create', missing_actor),
				'an offer naming a missing actor'
			);
			assert.strictEqual(actor_refusal.status, 400);
			assert.strictEqual(actor_refusal.error.code, JSONRPC_ERROR_CODES.invalid_params);
			assert.deepStrictEqual(actor_refusal.error.data, {
				reason: ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH
			});

			for (const [method, params, expected, label] of [
				[
					'role_grant_offer_create',
					deleted_account,
					account_refusal,
					'an offer to a deleted account'
				],
				[
					'role_grant_offer_create',
					deleted_actor,
					actor_refusal,
					'an offer naming a deleted actor'
				],
				['role_grant_assign', deleted_account, account_refusal, 'an assign to a deleted account'],
				['role_grant_assign', missing_account, account_refusal, 'an assign to a missing account'],
				['role_grant_assign', deleted_actor, actor_refusal, 'an assign naming a deleted actor'],
				['role_grant_assign', missing_actor, actor_refusal, 'an assign naming a missing actor']
			] as const) {
				assert.deepStrictEqual(answer(await call(method, params), label), expected, label);
			}

			// a grantor with no authority to confer learns nothing of the recipient
			const unauthorized = await fixture.create_account({ username: 'incoming_refused_by' });
			const refusals = [];
			for (const params of [deleted_account, missing_account, { to_account_id: live.account.id }]) {
				const res = await rpc(
					fixture,
					'role_grant_offer_create',
					{ ...params, role },
					unauthorized.create_session_headers()
				);
				const refusal = answer(res, 'an offer by a grantor without authority');
				assert.strictEqual(refusal.status, 403);
				assert.strictEqual(refusal.error.code, JSONRPC_ERROR_CODES.forbidden);
				assert.deepStrictEqual(refusal.error.data, {
					reason: ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED
				});
				refusals.push(refusal);
			}
			assert.deepStrictEqual(refusals[0], refusals[2], 'a deleted recipient: as a live one');
			assert.deepStrictEqual(refusals[1], refusals[2], 'a missing recipient: as a live one');

			// the self-target check comes first, whatever actor is named
			const self = answer(
				await call('role_grant_offer_create', {
					to_account_id: fixture.account.id,
					to_actor_id: live.actor.id
				}),
				'an offer to oneself naming another account’s actor'
			);
			assert.strictEqual(self.status, 400);
			assert.deepStrictEqual(self.error.data, { reason: ERROR_ROLE_GRANT_OFFER_SELF_TARGET });

			const offers = await history(fixture, fixture.create_session_headers());
			assert.ok(
				!offers.some((o) => o.to_account_id === recipient.account.id),
				'no offer to the deleted account was created'
			);
		});
	});
};
