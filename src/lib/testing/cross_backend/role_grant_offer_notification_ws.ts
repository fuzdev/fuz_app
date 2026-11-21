import '../assert_dev_env.ts';

/**
 * Cross-process **role-grant-offer lifecycle WS notification** suite — the
 * machinery proof for the consentful-role-grants notification fan-out across
 * any spine backend. Covers every server-initiated notification of the
 * lifecycle:
 *
 * - `role_grant_offer_received` → recipient (offer created)
 * - `role_grant_offer_accepted` → grantor (recipient accepts)
 * - `role_grant_offer_declined` → grantor (recipient declines)
 * - `role_grant_offer_retracted` → recipient (grantor retracts)
 * - `role_grant_revoked` (flat, omits `revoked_by`) → revokee (active grant
 *   revoked by the `role_grant_revoke` action), for a global grant and a
 *   scoped one unless `scope_kind` is `null`
 * - `role_grant_offer_supersede` → each live party of an offer a cascade ended:
 *   an accept's siblings' grantors (`reason: 'sibling_accepted'`, the
 *   recipient being the caller), both parties of every offer a revoke ends
 *   (`reason: 'role_grant_revoked'` — the revokee's incoming siblings and its
 *   own outgoing offers), and the other party of every offer an account
 *   removal ends (`reason: 'account_deleted'`, delete and purge — gated on
 *   `capabilities.account_lifecycle` too; the removed account's socket closes
 *   and hears none of it)
 *
 * These exercise only spine primitives (accounts, role-grants, offers, WS
 * notifications) — zero consumer domain — so the suite lives here and runs
 * against any backend that mounts the standard RPC actions and a WS endpoint
 * their notifications reach: fuz_app's own spine self-tests
 * (`testing_spine_server` + the Rust `testing_spine_stub`) and downstream
 * twin-impl consumers (the fuz_forge Deno/Hono + Rust `fuz_forge_server`
 * backends) alike.
 *
 * Each case is a *targeted* server-initiated notification (vs the broadcast in
 * a `repo_updated`-style suite), so it opens the affected counterparty's socket,
 * drives the lifecycle RPC over HTTP, then asserts the frame lands on that
 * socket and strict-parses against the canonical wire schema — the guard
 * against serialization drift (field / null / datetime / the flat revoke shape /
 * the supersede `reason` + `cause_id`). Every case also holds a third account's
 * admitted socket open — a bystander, party to nothing the case drives — and,
 * once the targeted frame has landed, asserts the bystander received nothing
 * but the answers to its own requests, behind a `heartbeat` barrier on its
 * socket (`assert_bystander_heard_nothing` says why the barrier makes the
 * silence meaningful). A fan-out that reached past its target account fails
 * there. The target is held the same way, behind a barrier of its own: its
 * socket heard exactly the notifications the case addressed to it, each once,
 * in order — so a backend delivering one twice (a registry reached through
 * two paths) fails, which the frame's own `wait_for` can't see.
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
 * The revoke cases revoke the revokee's only `ROLE_ADMIN` grant. On an endpoint
 * gated on that role (`ws_required_roles`) the revokee's socket loses its
 * access by the same revoke: it is closed with `WS_CLOSE_PERMISSION_REVOKED`,
 * and its notifications may or may not reach it first (nothing orders the
 * two), so the cases assert the close there — and at most the start of what it
 * would have heard, in order — and the frames on an ungated endpoint.
 *
 * Cross-process only: `create_admitted_ws_transport` needs a real bound socket, so wire
 * it from a `*.cross.test.ts` file, never an in-process setup. Authed cookies
 * come from the per-account session minted by `fixture.create_account` /
 * `fixture.create_session_headers`.
 *
 * @module
 */

import { assert, describe } from 'vitest';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import { rpc_call } from '../rpc_helpers.ts';
import { WS_ADMISSION_PROBE_ID } from '../transports/ws_transport.ts';
import {
	is_notification,
	is_notification_with,
	is_response_for,
	type WsClient
} from '../transports/ws_client.ts';
import { ROLE_ADMIN, is_builtin_role } from '../../auth/role_schema.ts';
import {
	WS_CLOSE_PERMISSION_REVOKED,
	WS_CLOSE_PERMISSION_REVOKED_REASON
} from '../../actions/transports.ts';
import {
	ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	ROLE_GRANT_REVOKED_NOTIFICATION_METHOD,
	RoleGrantOfferReceivedParams,
	RoleGrantOfferAcceptedParams,
	RoleGrantOfferDeclinedParams,
	RoleGrantOfferRetractedParams,
	RoleGrantOfferSupersedeParams,
	RoleGrantRevokedParams
} from '../../auth/role_grant_offer_notifications.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import {
	create_active_role_grant,
	create_pending_role_grant_offer
} from './role_grant_cross_helpers.ts';
import { cross_account_purge } from './revocation_drivers.ts';
import type { TestAccount } from '../app_server.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import { SPINE_PARTICIPANT_ROLE, SPINE_RPC_PATH } from './spine_surface_constants.ts';
import { open_session_ws, type WsEndpointTarget, type WsSessionAccount } from './ws_endpoint.ts';

/** The request id the bystander's barrier `heartbeat` goes out under. */
const BYSTANDER_BARRIER_ID = 'bystander_barrier';

/** The request id the target's barrier `heartbeat` goes out under. */
const TARGET_BARRIER_ID = 'target_barrier';

/**
 * Name each frame a socket received but the answers to its admission probe and
 * its barrier: a notification by its method, anything else as its JSON, so an
 * unexpected response shows in the assertion's diff.
 */
const to_heard_frames = (ws: WsClient): Array<string> =>
	ws.messages
		.filter(
			(msg) =>
				!is_response_for(WS_ADMISSION_PROBE_ID)(msg) && !is_response_for(TARGET_BARRIER_ID)(msg)
		)
		.map((msg) => {
			const method = (msg as { method?: unknown } | null)?.method;
			return typeof method === 'string' ? method : JSON.stringify(msg);
		});

/** Configuration for `describe_role_grant_offer_notification_ws_tests`. */
export interface RoleGrantOfferNotificationWsTestOptions extends WsEndpointTarget {
	/** Per-test fixture producer (`default_cross_process_setup(handle, ...)`). */
	readonly setup_test: SetupTest;
	/** Backend capability flags; every case gates on `capabilities.ws`. */
	readonly capabilities: BackendCapabilities;
	/**
	 * The roles `ws_path` gates its upgrade on (its `required_roles`), or
	 * omitted / `[]` for an ungated endpoint. Declare them for a backend whose
	 * socket is role-gated: revoking `ROLE_ADMIN` then closes the revokee's
	 * socket with `WS_CLOSE_PERMISSION_REVOKED`, and the revoke case asserts
	 * that close instead of the notification frame.
	 */
	readonly ws_required_roles?: ReadonlyArray<string>;
	/**
	 * The role the scoped-revoke case assigns in a scope and revokes — one the
	 * backend's registry holds with the `admin` grant path. Default
	 * `SPINE_PARTICIPANT_ROLE`, the spine's own.
	 */
	readonly scoped_role?: string;
	/**
	 * A scope kind `scoped_role` applies to, for the scoped-revoke case; `null`
	 * skips that case. Default `'space'` (the spine participant's), or `null`
	 * for a builtin role, which is global-only.
	 */
	readonly scope_kind?: string | null;
}

/**
 * Register the role-grant-offer WS notification suite — cases over a real
 * upgrade, one per server-initiated notification (received / accepted /
 * declined / retracted / revoke, global and scoped, + supersede on the accept,
 * revoke, delete and purge cascades). Each opens every party's socket, drives
 * the lifecycle RPC, and strict-parses the delivered frames against their
 * canonical params schema. Gated on `capabilities.ws`, the removals on
 * `capabilities.account_lifecycle` too.
 */
export const describe_role_grant_offer_notification_ws_tests = (
	options: RoleGrantOfferNotificationWsTestOptions
): void => {
	const { setup_test, capabilities, ws_required_roles = [] } = options;
	const revoke_closes_the_socket = ws_required_roles.includes(ROLE_ADMIN);
	const scoped_role = options.scoped_role ?? SPINE_PARTICIPANT_ROLE;
	const scope_kind =
		options.scope_kind === undefined
			? is_builtin_role(scoped_role)
				? null
				: 'space'
			: options.scope_kind;

	// -- shared helpers -------------------------------------------------------

	/**
	 * Open a WS transport on an account's session, admitted before it resolves:
	 * a targeted notification is delivered only to an admitted connection, and
	 * the handshake alone doesn't say it is one.
	 */
	const open_ws = (account: WsSessionAccount): Promise<WsClient> =>
		open_session_ws(options, account, { admitted: true });

	/**
	 * A third account's admitted socket — party to nothing a case drives. It
	 * holds `ROLE_ADMIN`, as every account here does, so it opens a socket
	 * gated on that role too. Opened before the lifecycle call, after the
	 * account's own offer and accept have run.
	 */
	const open_bystander = async (fixture: TestFixture): Promise<WsClient> => {
		const bystander = await fixture.create_account({ roles: [ROLE_ADMIN] });
		return open_ws(bystander);
	};

	/**
	 * Assert the bystander's socket received nothing but the answers to its
	 * own requests. Called once the targeted party holds its frame, and
	 * meaningful only behind the barrier it sends first: a `heartbeat` round
	 * trip on the bystander's socket.
	 *
	 * Why the barrier makes the silence a finding: both spines queue one
	 * fan-out to every recipient in a single pass with no await in it (the TS
	 * transport's `broadcast_filtered` loop, the Rust registry's
	 * `deliver_all`), and neither writes a response ahead of a notification
	 * already queued for the same connection. On the TS spine responses and
	 * notifications share one outbound queue. On the Rust spine a response is
	 * written directly, but the loop's completion arm first writes every
	 * frame already queued for the connection (`flush_queued_frames` in
	 * `fuz_realtime`'s `ws_endpoint.rs`). So a frame the pass addressed to the
	 * bystander reaches it ahead of the barrier's response, and reading that
	 * response first means the pass sent it nothing. On the TS spine this is
	 * strict: a fan-out is sent in one synchronous closure. On the Rust spine
	 * `deliver_all` pushes to recipients one after another on one worker
	 * while the target's connection loop runs on another, so the target's
	 * frame can be written while the pass is still pushing — a window the
	 * barrier's round trip outlasts in practice. Either way the check covers
	 * every pass of the drain, not just the one that reached the target: TS
	 * calls every queued send in one synchronous loop
	 * (`flush_post_commit_effects`), and `PostCommitEffects::drain_all` joins
	 * effects whose notify futures push synchronously, so every pass
	 * completes in the drain's first poll.
	 */
	const assert_bystander_heard_nothing = async (bystander_ws: WsClient): Promise<void> => {
		await bystander_ws.request(BYSTANDER_BARRIER_ID, 'heartbeat', {}, 5000);
		const strays = bystander_ws.messages.filter(
			(msg) =>
				!is_response_for(WS_ADMISSION_PROBE_ID)(msg) && !is_response_for(BYSTANDER_BARRIER_ID)(msg)
		);
		assert.deepStrictEqual(strays, [], 'a bystander socket received frames addressed to others');
	};

	/**
	 * Assert the targeted socket heard exactly `expected` — the notifications
	 * the case addressed to it, in order, each once — and nothing else but the
	 * answers to its own requests. Called once the targeted frame has landed,
	 * behind a `heartbeat` barrier on the target's own socket, which makes the
	 * absence of a second copy a finding for the reason
	 * `assert_bystander_heard_nothing` gives: a fan-out queues every copy it
	 * sends in the pass that sent the first, ahead of the barrier's response.
	 */
	const assert_target_heard_exactly = async (
		target_ws: WsClient,
		expected: ReadonlyArray<string>
	): Promise<void> => {
		await target_ws.request(TARGET_BARRIER_ID, 'heartbeat', {}, 5000);
		assert.deepStrictEqual(
			to_heard_frames(target_ws),
			expected,
			'the target socket did not hear exactly the notifications addressed to it, each once'
		);
	};

	/**
	 * Wait for the `role_grant_offer_supersede` frame of `offer_id` on `ws` and
	 * strict-parse its params against the canonical wire schema.
	 */
	const wait_for_supersede = async (
		ws: WsClient,
		offer_id: string
	): Promise<RoleGrantOfferSupersedeParams> => {
		const frame = await ws.wait_for(
			is_notification_with<{ offer: { id: string } }>(
				ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
				(p) => p.offer.id === offer_id
			),
			5000
		);
		const params = parse_or_throw(RoleGrantOfferSupersedeParams, frame.params);
		assert.strictEqual(params.offer.id, offer_id);
		assert.isNotNull(params.offer.superseded_at);
		return params;
	};

	/** The offer ids of the supersede frames `ws` heard, in order. */
	const supersede_offer_ids = (ws: WsClient): Array<string> =>
		ws.messages
			.filter(is_notification(ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD))
			.map((msg) => (msg as { params: { offer: { id: string } } }).params.offer.id);

	/** Drive a JSON-RPC call over the fixture's HTTP transport. */
	const rpc = (
		fixture: TestFixture,
		method: string,
		params: unknown,
		headers: Record<string, string>
	) => rpc_call({ app: fixture.transport, path: SPINE_RPC_PATH, method, params, headers });

	/** A fresh pending `ROLE_ADMIN` offer, from the keeper unless a grantor is given. */
	const create_pending_offer = (
		fixture: TestFixture,
		to_account_id: string,
		grantor_headers?: Record<string, string>
	): Promise<{ id: string }> =>
		create_pending_role_grant_offer(fixture, to_account_id, grantor_headers, {
			rpc_path: SPINE_RPC_PATH
		});

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

				const bystander_ws = await open_bystander(fixture);
				try {
					const recipient_ws = await open_ws(recipient);
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
						const params = parse_or_throw(RoleGrantOfferReceivedParams, frame.params);
						assert.strictEqual(params.offer.to_account_id, recipient.account.id);
						assert.strictEqual(params.offer.role, ROLE_ADMIN);
						await assert_target_heard_exactly(recipient_ws, [
							ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD
						]);
						await assert_bystander_heard_nothing(bystander_ws);
					} finally {
						await recipient_ws.close();
					}
				} finally {
					await bystander_ws.close();
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
				const bystander_ws = await open_bystander(fixture);
				try {
					const grantor = await open_ws(fixture);
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
						const params = parse_or_throw(RoleGrantOfferAcceptedParams, frame.params);
						assert.strictEqual(params.offer.id, offer.id);
						assert.isNotNull(params.offer.accepted_at);
						await assert_target_heard_exactly(grantor, [
							ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD
						]);
						await assert_bystander_heard_nothing(bystander_ws);
					} finally {
						await grantor.close();
					}
				} finally {
					await bystander_ws.close();
				}
			}
		);

		test_if(
			capabilities.ws,
			'decline delivers role_grant_offer_declined to the grantor WS',
			async () => {
				const fixture = await setup_test();
				const recipient = await fixture.create_account({ roles: [ROLE_ADMIN] });

				const bystander_ws = await open_bystander(fixture);
				try {
					const grantor = await open_ws(fixture);
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
						const params = parse_or_throw(RoleGrantOfferDeclinedParams, frame.params);
						assert.strictEqual(params.offer.id, offer.id);
						// Decline reason rides inside the offer row, not a sibling field.
						assert.strictEqual(params.offer.decline_reason, 'no thanks');
						await assert_target_heard_exactly(grantor, [
							ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD
						]);
						await assert_bystander_heard_nothing(bystander_ws);
					} finally {
						await grantor.close();
					}
				} finally {
					await bystander_ws.close();
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
				const bystander_ws = await open_bystander(fixture);
				try {
					const recipient_ws = await open_ws(recipient);
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
						const params = parse_or_throw(RoleGrantOfferRetractedParams, frame.params);
						assert.strictEqual(params.offer.id, offer.id);
						assert.strictEqual(params.offer.to_account_id, recipient.account.id);
						assert.isNotNull(params.offer.retracted_at);
						// the offer's create, made with the socket open, notified it first
						await assert_target_heard_exactly(recipient_ws, [
							ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
							ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD
						]);
						await assert_bystander_heard_nothing(bystander_ws);
					} finally {
						await recipient_ws.close();
					}
				} finally {
					await bystander_ws.close();
				}
			}
		);

		test_if(
			capabilities.ws,
			revoke_closes_the_socket
				? 'revoke closes the revokee WS gated on the revoked role'
				: 'revoke delivers a flat role_grant_revoked to the revokee WS',
			async () => {
				const fixture = await setup_test();
				const revokee = await fixture.create_account({ roles: [ROLE_ADMIN] });

				const role_grant_id = await create_active_role_grant(fixture, revokee, {
					rpc_path: SPINE_RPC_PATH
				});

				const bystander_ws = await open_bystander(fixture);
				try {
					const revokee_ws = await open_ws(revokee);
					try {
						const revoked = await rpc(
							fixture,
							'role_grant_revoke',
							{ actor_id: revokee.actor.id, role_grant_id, reason: 'cleanup' },
							fixture.create_session_headers()
						);
						assert.isTrue(revoked.ok, `revoke failed: ${JSON.stringify(revoked)}`);

						const is_revoke_frame = is_notification_with<{ role_grant_id: string }>(
							ROLE_GRANT_REVOKED_NOTIFICATION_METHOD,
							(p) => p.role_grant_id === role_grant_id
						);
						// Flat params — guards the no-`offer`-wrapper, `revoked_by`-omitted
						// shape against drift.
						const assert_flat_revoke = (frame: { params?: unknown }): void => {
							const params = parse_or_throw(RoleGrantRevokedParams, frame.params);
							assert.strictEqual(params.role_grant_id, role_grant_id);
							assert.strictEqual(params.role, ROLE_ADMIN);
							assert.strictEqual(params.scope_kind, null);
							assert.strictEqual(params.scope_id, null);
							assert.strictEqual(params.reason, 'cleanup');
							assert.notProperty(frame.params, 'revoked_by');
						};

						if (revoke_closes_the_socket) {
							// the socket lost the role its endpoint requires; the revoke
							// notification may land just ahead of the close or not at all,
							// and is held to the same shape when it does
							const closed = await revokee_ws.wait_for_close(5000);
							assert.ok(closed, 'the gated socket did not close after the revoke');
							assert.strictEqual(revokee_ws.close_code, WS_CLOSE_PERMISSION_REVOKED);
							assert.strictEqual(revokee_ws.close_reason, WS_CLOSE_PERMISSION_REVOKED_REASON);
							const early = revokee_ws.messages.find(is_revoke_frame);
							if (early) assert_flat_revoke(early);
							// a closed socket takes no barrier: what reached it ahead of the
							// close is the notification once, or nothing
							assert.deepStrictEqual(
								to_heard_frames(revokee_ws),
								early ? [ROLE_GRANT_REVOKED_NOTIFICATION_METHOD] : [],
								'the gated socket heard more than the one notification before its close'
							);
							await assert_bystander_heard_nothing(bystander_ws);
							return;
						}

						assert_flat_revoke(await revokee_ws.wait_for(is_revoke_frame, 5000));
						await assert_target_heard_exactly(revokee_ws, [ROLE_GRANT_REVOKED_NOTIFICATION_METHOD]);
						await assert_bystander_heard_nothing(bystander_ws);
					} finally {
						await revokee_ws.close();
					}
				} finally {
					await bystander_ws.close();
				}
			}
		);

		test_if(
			capabilities.ws && scope_kind !== null,
			'a scoped revoke delivers its scope_kind and scope_id to the revokee WS',
			async () => {
				const fixture = await setup_test();
				// `ROLE_ADMIN` opens a socket gated on it; the scoped revoke below takes
				// no global grant, so a gated socket stays open
				const revokee = await fixture.create_account({ roles: [ROLE_ADMIN] });
				const scope_id = '44444444-4444-4444-8444-444444444444';
				const assigned = await rpc(
					fixture,
					'role_grant_assign',
					{ to_account_id: revokee.account.id, role: scoped_role, scope_kind, scope_id },
					fixture.create_session_headers()
				);
				assert.isTrue(assigned.ok, `assign failed: ${JSON.stringify(assigned)}`);
				const { role_grant_id } = assigned.result as { role_grant_id: string };

				const bystander_ws = await open_bystander(fixture);
				try {
					const revokee_ws = await open_ws(revokee);
					try {
						const revoked = await rpc(
							fixture,
							'role_grant_revoke',
							{ actor_id: revokee.actor.id, role_grant_id },
							fixture.create_session_headers()
						);
						assert.isTrue(revoked.ok, `revoke failed: ${JSON.stringify(revoked)}`);

						const frame = await revokee_ws.wait_for(
							is_notification_with<{ role_grant_id: string }>(
								ROLE_GRANT_REVOKED_NOTIFICATION_METHOD,
								(p) => p.role_grant_id === role_grant_id
							),
							5000
						);
						const params = parse_or_throw(RoleGrantRevokedParams, frame.params);
						assert.strictEqual(params.role, scoped_role);
						assert.strictEqual(params.scope_kind, scope_kind);
						assert.strictEqual(params.scope_id, scope_id);
						assert.strictEqual(params.reason, null);
						await assert_target_heard_exactly(revokee_ws, [ROLE_GRANT_REVOKED_NOTIFICATION_METHOD]);
						await assert_bystander_heard_nothing(bystander_ws);
					} finally {
						await revokee_ws.close();
					}
				} finally {
					await bystander_ws.close();
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
				const bystander_ws = await open_bystander(fixture);
				try {
					const grantor1_ws = await open_ws(fixture);
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
						const params = parse_or_throw(RoleGrantOfferSupersedeParams, frame.params);
						assert.strictEqual(params.offer.id, keeper_offer.id);
						assert.strictEqual(params.reason, 'sibling_accepted');
						// cause_id points at the accepted sibling (grantor 2's offer).
						assert.strictEqual(params.cause_id, grantor2_offer.id);
						assert.isNotNull(params.offer.superseded_at);
						await assert_target_heard_exactly(grantor1_ws, [
							ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD
						]);
						await assert_bystander_heard_nothing(bystander_ws);
					} finally {
						await grantor1_ws.close();
					}
				} finally {
					await bystander_ws.close();
				}
			}
		);

		test_if(
			capabilities.ws,
			"revoke supersedes the revokee's pending offers both ways and notifies both parties of each",
			async () => {
				const fixture = await setup_test();
				const grantor = await fixture.create_account({ roles: [ROLE_ADMIN] });
				const revokee = await fixture.create_account({ roles: [ROLE_ADMIN] });
				const recipient = await fixture.create_account({ roles: [ROLE_ADMIN] });

				const role_grant_id = await create_active_role_grant(fixture, revokee, {
					rpc_path: SPINE_RPC_PATH
				});

				// A pending sibling for the revoked grant's (account, role), and an
				// offer the revokee made — the revoke's two cascades, in that order.
				const sibling_offer = await create_pending_offer(
					fixture,
					revokee.account.id,
					grantor.create_session_headers()
				);
				const outgoing_offer = await create_pending_offer(
					fixture,
					recipient.account.id,
					revokee.create_session_headers()
				);

				const bystander_ws = await open_bystander(fixture);
				const grantor_ws = await open_ws(grantor);
				const revokee_ws = await open_ws(revokee);
				const recipient_ws = await open_ws(recipient);
				try {
					const revoked = await rpc(
						fixture,
						'role_grant_revoke',
						{ actor_id: revokee.actor.id, role_grant_id },
						fixture.create_session_headers()
					);
					assert.isTrue(revoked.ok, `revoke failed: ${JSON.stringify(revoked)}`);

					const assert_supersede = async (ws: WsClient, offer_id: string): Promise<void> => {
						const params = await wait_for_supersede(ws, offer_id);
						assert.strictEqual(params.reason, 'role_grant_revoked');
						// cause_id points at the revoked role_grant.
						assert.strictEqual(params.cause_id, role_grant_id);
					};
					// the sibling's grantor and the outgoing offer's recipient
					await assert_supersede(grantor_ws, sibling_offer.id);
					await assert_target_heard_exactly(grantor_ws, [
						ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD
					]);
					await assert_supersede(recipient_ws, outgoing_offer.id);
					await assert_target_heard_exactly(recipient_ws, [
						ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD
					]);
					// the revokee is the sibling's recipient and the outgoing offer's
					// grantor: the revoke, then the two offers in the cascade's order
					const revokee_heard = [
						ROLE_GRANT_REVOKED_NOTIFICATION_METHOD,
						ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
						ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD
					];
					if (revoke_closes_the_socket) {
						// the gated socket closes with the revoke, hearing at most the
						// start of what it would have heard, in order
						const closed = await revokee_ws.wait_for_close(5000);
						assert.ok(closed, 'the gated socket did not close after the revoke');
						assert.strictEqual(revokee_ws.close_code, WS_CLOSE_PERMISSION_REVOKED);
						const heard = to_heard_frames(revokee_ws);
						assert.deepStrictEqual(heard, revokee_heard.slice(0, heard.length));
					} else {
						await assert_supersede(revokee_ws, outgoing_offer.id);
						await assert_target_heard_exactly(revokee_ws, revokee_heard);
						assert.deepStrictEqual(
							supersede_offer_ids(revokee_ws),
							[sibling_offer.id, outgoing_offer.id],
							"the revokee hears the sibling's supersede, then its own offer's"
						);
					}
					await assert_bystander_heard_nothing(bystander_ws);
				} finally {
					await Promise.all([recipient_ws.close(), revokee_ws.close(), grantor_ws.close()]);
					await bystander_ws.close();
				}
			}
		);

		/**
		 * The account removals: `remove` ends `removed`'s account, whose pending
		 * offers both ways are superseded with `reason: 'account_deleted'`, the
		 * account as the grantor's cause and its actor as the recipient's. Each
		 * offer's other party hears it once; the removed account's socket closes
		 * and hears none of it.
		 */
		const removal_case = async (
			remove: (fixture: TestFixture, removed: TestAccount) => Promise<void>
		): Promise<void> => {
			const fixture = await setup_test();
			const removed = await fixture.create_account({ roles: [ROLE_ADMIN] });
			const recipient = await fixture.create_account({ roles: [ROLE_ADMIN] });
			const grantor = await fixture.create_account({ roles: [ROLE_ADMIN] });
			const outgoing_offer = await create_pending_offer(
				fixture,
				recipient.account.id,
				removed.create_session_headers()
			);
			const incoming_offer = await create_pending_offer(
				fixture,
				removed.account.id,
				grantor.create_session_headers()
			);

			const bystander_ws = await open_bystander(fixture);
			const removed_ws = await open_ws(removed);
			const recipient_ws = await open_ws(recipient);
			const grantor_ws = await open_ws(grantor);
			try {
				await remove(fixture, removed);

				// the recipient is sent the grantor's actor, an id it already holds —
				// never the removed account's id; the grantor is sent the removed
				// account, its offer's `to_account_id`
				for (const [ws, offer_id, cause_id] of [
					[recipient_ws, outgoing_offer.id, removed.actor.id],
					[grantor_ws, incoming_offer.id, removed.account.id]
				] as const) {
					const params = await wait_for_supersede(ws, offer_id);
					assert.strictEqual(params.reason, 'account_deleted');
					assert.strictEqual(params.cause_id, cause_id);
					await assert_target_heard_exactly(ws, [ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD]);
				}
				const closed = await removed_ws.wait_for_close(5000);
				assert.ok(closed, "the removed account's socket did not close");
				// binds only on a spine that delivers a frame queued ahead of the close;
				// one whose close drops it passes either way, so the spine's own fan-out
				// tests are what hold a send to the removed account out
				assert.deepStrictEqual(
					to_heard_frames(removed_ws),
					[],
					"the removed account's socket heard a notification before its close"
				);
				await assert_bystander_heard_nothing(bystander_ws);
			} finally {
				await Promise.all([grantor_ws.close(), recipient_ws.close(), removed_ws.close()]);
				await bystander_ws.close();
			}
		};

		test_if(
			capabilities.ws && capabilities.account_lifecycle,
			"delete supersedes the account's pending offers both ways and notifies each other party",
			() =>
				removal_case(async (fixture, removed) => {
					const deleted = await rpc(
						fixture,
						'account_delete',
						{ account_id: removed.account.id },
						fixture.create_session_headers()
					);
					assert.isTrue(deleted.ok, `delete failed: ${JSON.stringify(deleted)}`);
				})
		);

		test_if(
			capabilities.ws && capabilities.account_lifecycle,
			"purge supersedes the account's pending offers both ways and notifies each other party",
			() =>
				removal_case((fixture, removed) =>
					cross_account_purge(fixture, SPINE_RPC_PATH, removed.account.id)
				)
		);
	});
};
