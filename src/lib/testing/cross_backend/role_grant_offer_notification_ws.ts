import '../assert_dev_env.ts';

/**
 * Cross-process **role-grant-offer lifecycle WS notification** suite — the
 * machinery proof for the consentful-role-grants notification fan-out across
 * any spine backend. Covers all seven server-initiated notifications:
 *
 * - `role_grant_offer_received` → recipient (offer created)
 * - `role_grant_offer_accepted` → grantor (recipient accepts)
 * - `role_grant_offer_declined` → grantor (recipient declines)
 * - `role_grant_offer_retracted` → recipient (grantor retracts)
 * - `role_grant_revoke` (flat, omits `revoked_by`) → revokee (active grant revoked)
 * - `role_grant_offer_supersede` → each superseded sibling's grantor, fired on
 *   BOTH the accept-cascade (`reason: 'sibling_accepted'`) and the
 *   revoke-cascade (`reason: 'role_grant_revoked'`)
 *
 * These exercise only spine primitives (accounts, role-grants, offers, WS
 * notifications) — zero consumer domain — so the suite lives here and runs
 * against any backend that wires the standard RPC actions' `notification_sender`
 * and mounts a registered WS socket: fuz_app's own spine self-tests
 * (`testing_spine_server` + the Rust `testing_spine_stub`) and downstream
 * twin-impl consumers (the fuz_forge Deno/Hono + Rust `fuz_forge_server`
 * backends) alike.
 *
 * Each case is a *targeted* server-initiated notification (vs the broadcast in
 * a `repo_updated`-style suite), so it opens the affected counterparty's socket,
 * drives the lifecycle RPC over HTTP, then asserts the frame lands on that
 * socket and strict-parses against the canonical wire schema — the guard
 * against serialization drift (field / null / datetime / the flat revoke shape /
 * the supersede `reason` + `cause_id`).
 *
 * Sends are queued on the post-commit drain (handler-emit, not audit-derived),
 * so a frame may land a beat after the RPC resolves — `WsClient.wait_for` polls
 * already-received messages then waits, absorbing the fan-out latency without a
 * sleep, and its method+predicate filter ignores unrelated frames (e.g. the
 * `received` push the recipient also gets). `ROLE_ADMIN` is the only
 * admin-grantable role; accounts that already hold it can still be offered it
 * again (a fresh pending row — the prior accept is terminal, no already-granted
 * guard), and accept stays idempotent on the role_grant while still superseding
 * pending siblings. Gated on `capabilities.ws`.
 *
 * Cross-process only: `create_ws_transport` needs a real bound socket, so wire
 * it from a `*.cross.test.ts` file, never an in-process setup. Authed cookies
 * come from the per-account session minted by `fixture.create_account` /
 * `fixture.create_session_headers`.
 *
 * @module
 */

import { assert, describe } from 'vitest';

import { rpc_call } from '../rpc_helpers.ts';
import { create_ws_transport } from '../transports/ws_transport.ts';
import { is_notification_with } from '../transports/ws_client.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import {
	ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	ROLE_GRANT_REVOKE_NOTIFICATION_METHOD,
	RoleGrantOfferReceivedParams,
	RoleGrantOfferAcceptedParams,
	RoleGrantOfferDeclinedParams,
	RoleGrantOfferRetractedParams,
	RoleGrantOfferSupersedeParams,
	RoleGrantRevokeParams
} from '../../auth/role_grant_offer_notifications.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import type { SetupTest, TestAccountFixture, TestFixture } from './setup.ts';

/** JSON-RPC endpoint path — matches the spine's `/api/rpc` (and the forge's). */
const RPC_PATH = '/api/rpc';

/** Configuration for {@link describe_role_grant_offer_notification_ws_tests}. */
export interface RoleGrantOfferNotificationWsTestOptions {
	/** Per-test fixture producer (`default_cross_process_setup(handle, ...)`). */
	readonly setup_test: SetupTest;
	/** Backend capability flags; every case gates on `capabilities.ws`. */
	readonly capabilities: BackendCapabilities;
	/** Base URL the backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** WebSocket endpoint path on the backend (e.g. `/api/ws`). */
	readonly ws_path: string;
}

/**
 * Register the role-grant-offer WS notification suite — seven cases over a real
 * upgrade, one per server-initiated notification (received / accepted /
 * declined / retracted / revoke + supersede on both the accept and revoke
 * cascades). Each opens the affected counterparty's socket, drives the
 * lifecycle RPC, and strict-parses the delivered frame against its canonical
 * params schema. Gated on `capabilities.ws`.
 */
export const describe_role_grant_offer_notification_ws_tests = (
	options: RoleGrantOfferNotificationWsTestOptions
): void => {
	const { setup_test, capabilities, base_url, ws_path } = options;

	// -- shared helpers -------------------------------------------------------

	/** Open a WS transport for a single session cookie (`<name>=<value>`). */
	const open_ws = (cookie: string | undefined) => {
		assert.ok(cookie, 'expected a session cookie for the WS upgrade');
		return create_ws_transport({ base_url, ws_path, cookies: [cookie], origin: base_url });
	};

	/** Drive a JSON-RPC call over the fixture's HTTP transport. */
	const rpc = (
		fixture: TestFixture,
		method: string,
		params: unknown,
		headers: Record<string, string>
	) => rpc_call({ app: fixture.transport, path: RPC_PATH, method, params, headers });

	/**
	 * Create a fresh pending `ROLE_ADMIN` offer from `grantor_headers` (defaults
	 * to the keeper) to `to_account_id`, returning the created offer.
	 */
	const create_pending_offer = async (
		fixture: TestFixture,
		to_account_id: string,
		grantor_headers: Record<string, string> = fixture.create_session_headers()
	): Promise<{ id: string }> => {
		const res = await rpc(
			fixture,
			'role_grant_offer_create',
			{ to_account_id, role: ROLE_ADMIN },
			grantor_headers
		);
		if (!res.ok) assert.fail(`offer create failed: ${JSON.stringify(res)}`);
		return (res.result as { offer: { id: string } }).offer;
	};

	/**
	 * Materialize an active `ROLE_ADMIN` role_grant on `recipient` via a fresh
	 * keeper offer + recipient accept (idempotent on a grant the account already
	 * holds), returning its `role_grant_id` — the handle `role_grant_revoke`
	 * keys on.
	 */
	const create_active_role_grant = async (
		fixture: TestFixture,
		recipient: TestAccountFixture
	): Promise<string> => {
		const offer = await create_pending_offer(fixture, recipient.account.id);
		const accepted = await rpc(
			fixture,
			'role_grant_offer_accept',
			{ offer_id: offer.id },
			recipient.create_session_headers()
		);
		if (!accepted.ok) assert.fail(`accept failed: ${JSON.stringify(accepted)}`);
		return (accepted.result as { role_grant_id: string }).role_grant_id;
	};

	// -- tests ----------------------------------------------------------------

	describe('role_grant_offer WS notifications (cross-process)', () => {
		test_if(
			capabilities.ws,
			'an offer create delivers role_grant_offer_received to the recipient WS',
			async () => {
				const fixture = await setup_test();

				// Seed a second admin account — admin so it can open the
				// ROLE_ADMIN-gated WS (forge); harmless on the auth-only spine.
				// `create_account` rides the real offer/accept handlers (that
				// earlier notification lands before the socket opens, so it's not
				// the one we observe).
				const recipient = await fixture.create_account({ roles: [ROLE_ADMIN] });

				const recipient_ws = await open_ws(recipient.create_session_headers().cookie);
				try {
					// The keeper (grantor, holds ROLE_ADMIN) offers the recipient a
					// role over RPC — fresh pending offer, emits the notification
					// post-commit.
					const created = await rpc(
						fixture,
						'role_grant_offer_create',
						{ to_account_id: recipient.account.id, role: ROLE_ADMIN },
						fixture.create_session_headers()
					);
					assert.isTrue(created.ok, `offer create failed: ${JSON.stringify(created)}`);

					const frame = await recipient_ws.wait_for(
						is_notification_with<{ offer: { to_account_id: string } }>(
							ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
							(p) => p.offer.to_account_id === recipient.account.id
						),
						5000
					);

					// Params strict-parse against the canonical wire schema — guards
					// the serialization against field/null/datetime drift.
					const params = RoleGrantOfferReceivedParams.parse(frame.params);
					assert.strictEqual(params.offer.to_account_id, recipient.account.id);
					assert.strictEqual(params.offer.role, ROLE_ADMIN);
				} finally {
					await recipient_ws.close();
				}
			}
		);

		test_if(
			capabilities.ws,
			'accept delivers role_grant_offer_accepted to the grantor WS',
			async () => {
				const fixture = await setup_test();
				const recipient = await fixture.create_account({ roles: [ROLE_ADMIN] });

				// Grantor = keeper; open its socket BEFORE the recipient accepts.
				const grantor = await open_ws(fixture.create_session_headers().cookie);
				try {
					const offer = await create_pending_offer(fixture, recipient.account.id);
					const accepted = await rpc(
						fixture,
						'role_grant_offer_accept',
						{ offer_id: offer.id },
						recipient.create_session_headers()
					);
					assert.isTrue(accepted.ok, `accept failed: ${JSON.stringify(accepted)}`);

					const frame = await grantor.wait_for(
						is_notification_with<{ offer: { id: string } }>(
							ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
							(p) => p.offer.id === offer.id
						),
						5000
					);
					const params = RoleGrantOfferAcceptedParams.parse(frame.params);
					assert.strictEqual(params.offer.id, offer.id);
					assert.isNotNull(params.offer.accepted_at);
				} finally {
					await grantor.close();
				}
			}
		);

		test_if(
			capabilities.ws,
			'decline delivers role_grant_offer_declined to the grantor WS',
			async () => {
				const fixture = await setup_test();
				const recipient = await fixture.create_account({ roles: [ROLE_ADMIN] });

				const grantor = await open_ws(fixture.create_session_headers().cookie);
				try {
					const offer = await create_pending_offer(fixture, recipient.account.id);
					const declined = await rpc(
						fixture,
						'role_grant_offer_decline',
						{ offer_id: offer.id, reason: 'no thanks' },
						recipient.create_session_headers()
					);
					assert.isTrue(declined.ok, `decline failed: ${JSON.stringify(declined)}`);

					const frame = await grantor.wait_for(
						is_notification_with<{ offer: { id: string } }>(
							ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD,
							(p) => p.offer.id === offer.id
						),
						5000
					);
					const params = RoleGrantOfferDeclinedParams.parse(frame.params);
					assert.strictEqual(params.offer.id, offer.id);
					// Decline reason rides inside the offer row, not a sibling field.
					assert.strictEqual(params.offer.decline_reason, 'no thanks');
				} finally {
					await grantor.close();
				}
			}
		);

		test_if(
			capabilities.ws,
			'retract delivers role_grant_offer_retracted to the recipient WS',
			async () => {
				const fixture = await setup_test();
				const recipient = await fixture.create_account({ roles: [ROLE_ADMIN] });

				// Recipient learns their pending offer was pulled — open its socket.
				const recipient_ws = await open_ws(recipient.create_session_headers().cookie);
				try {
					const offer = await create_pending_offer(fixture, recipient.account.id);
					const retracted = await rpc(
						fixture,
						'role_grant_offer_retract',
						{ offer_id: offer.id },
						fixture.create_session_headers()
					);
					assert.isTrue(retracted.ok, `retract failed: ${JSON.stringify(retracted)}`);

					const frame = await recipient_ws.wait_for(
						is_notification_with<{ offer: { id: string } }>(
							ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD,
							(p) => p.offer.id === offer.id
						),
						5000
					);
					const params = RoleGrantOfferRetractedParams.parse(frame.params);
					assert.strictEqual(params.offer.id, offer.id);
					assert.strictEqual(params.offer.to_account_id, recipient.account.id);
					assert.isNotNull(params.offer.retracted_at);
				} finally {
					await recipient_ws.close();
				}
			}
		);

		test_if(
			capabilities.ws,
			'revoke delivers a flat role_grant_revoke to the revokee WS',
			async () => {
				const fixture = await setup_test();
				const revokee = await fixture.create_account({ roles: [ROLE_ADMIN] });

				const role_grant_id = await create_active_role_grant(fixture, revokee);

				const revokee_ws = await open_ws(revokee.create_session_headers().cookie);
				try {
					const revoked = await rpc(
						fixture,
						'role_grant_revoke',
						{ actor_id: revokee.actor.id, role_grant_id, reason: 'cleanup' },
						fixture.create_session_headers()
					);
					assert.isTrue(revoked.ok, `revoke failed: ${JSON.stringify(revoked)}`);

					const frame = await revokee_ws.wait_for(
						is_notification_with<{ role_grant_id: string }>(
							ROLE_GRANT_REVOKE_NOTIFICATION_METHOD,
							(p) => p.role_grant_id === role_grant_id
						),
						5000
					);
					// Flat params — guards the no-`offer`-wrapper, `revoked_by`-omitted
					// shape against drift.
					const params = RoleGrantRevokeParams.parse(frame.params);
					assert.strictEqual(params.role_grant_id, role_grant_id);
					assert.strictEqual(params.role, ROLE_ADMIN);
					assert.strictEqual(params.reason, 'cleanup');
					assert.notProperty(frame.params, 'revoked_by');
				} finally {
					await revokee_ws.close();
				}
			}
		);

		test_if(
			capabilities.ws,
			'accept of a sibling delivers role_grant_offer_supersede to the other grantor WS',
			async () => {
				const fixture = await setup_test();
				// Three identities: keeper (grantor 1, socket), a second admin grantor
				// (grantor 2), and the recipient.
				const grantor2 = await fixture.create_account({ roles: [ROLE_ADMIN] });
				const recipient = await fixture.create_account({ roles: [ROLE_ADMIN] });

				// Two coexisting pending offers for the same (recipient, role) — keyed
				// per grantor, so they don't upsert each other.
				const keeper_offer = await create_pending_offer(fixture, recipient.account.id);
				const grantor2_offer = await create_pending_offer(
					fixture,
					recipient.account.id,
					grantor2.create_session_headers()
				);

				// Open grantor 1 (keeper) — its offer is the one that gets superseded
				// when the recipient accepts grantor 2's offer.
				const grantor1_ws = await open_ws(fixture.create_session_headers().cookie);
				try {
					const accepted = await rpc(
						fixture,
						'role_grant_offer_accept',
						{ offer_id: grantor2_offer.id },
						recipient.create_session_headers()
					);
					assert.isTrue(accepted.ok, `accept failed: ${JSON.stringify(accepted)}`);

					const frame = await grantor1_ws.wait_for(
						is_notification_with<{ offer: { id: string } }>(
							ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
							(p) => p.offer.id === keeper_offer.id
						),
						5000
					);
					const params = RoleGrantOfferSupersedeParams.parse(frame.params);
					assert.strictEqual(params.offer.id, keeper_offer.id);
					assert.strictEqual(params.reason, 'sibling_accepted');
					// cause_id points at the accepted sibling (grantor 2's offer).
					assert.strictEqual(params.cause_id, grantor2_offer.id);
					assert.isNotNull(params.offer.superseded_at);
				} finally {
					await grantor1_ws.close();
				}
			}
		);

		test_if(
			capabilities.ws,
			'revoke supersedes a pending sibling offer and notifies its grantor WS',
			async () => {
				const fixture = await setup_test();
				const grantor = await fixture.create_account({ roles: [ROLE_ADMIN] });
				const revokee = await fixture.create_account({ roles: [ROLE_ADMIN] });

				const role_grant_id = await create_active_role_grant(fixture, revokee);

				// A *pending* sibling offer for the same (account, role) — this is what
				// the revoke cascade supersedes.
				const sibling_offer = await create_pending_offer(
					fixture,
					revokee.account.id,
					grantor.create_session_headers()
				);

				// Watch the sibling grantor's socket for the supersede push.
				const grantor_ws = await open_ws(grantor.create_session_headers().cookie);
				try {
					const revoked = await rpc(
						fixture,
						'role_grant_revoke',
						{ actor_id: revokee.actor.id, role_grant_id },
						fixture.create_session_headers()
					);
					assert.isTrue(revoked.ok, `revoke failed: ${JSON.stringify(revoked)}`);

					const frame = await grantor_ws.wait_for(
						is_notification_with<{ offer: { id: string } }>(
							ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
							(p) => p.offer.id === sibling_offer.id
						),
						5000
					);
					const params = RoleGrantOfferSupersedeParams.parse(frame.params);
					assert.strictEqual(params.offer.id, sibling_offer.id);
					assert.strictEqual(params.reason, 'role_grant_revoked');
					// cause_id points at the revoked role_grant.
					assert.strictEqual(params.cause_id, role_grant_id);
					assert.isNotNull(params.offer.superseded_at);
				} finally {
					await grantor_ws.close();
				}
			}
		);
	});
};
