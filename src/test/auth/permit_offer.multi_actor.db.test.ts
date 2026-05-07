/**
 * Multi-actor coverage for the permit-offer surface.
 *
 * Exercises actor-grain semantics that are invisible under v1's 1:1
 * `account ↔ actor` enforcement: a second actor inserted on the recipient
 * account, account-grain offers (any actor accepts) vs actor-grain offers
 * (only the named actor accepts), the audit envelope's `target_actor_id`
 * carrying the right actor (not whichever the index returns first), and
 * the `query_accept_offer` defense-in-depth check that rejects accepts by
 * an actor that doesn't belong to the recipient account.
 *
 * Sibling files own the rest of the suite:
 * - `permit_offer_queries.db.test.ts` — query-level happy path
 * - `permit_offer_actions.audit.db.test.ts` — single-actor audit envelope
 * - `cleanup.db.test.ts` — `permit_offer_expire` audit envelope
 *
 * @module
 */

import {assert, describe, test} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	permit_offer_create_action_spec,
	permit_offer_accept_action_spec,
	permit_offer_decline_action_spec,
	permit_offer_retract_action_spec,
	permit_revoke_action_spec,
	permit_offer_list_action_spec,
	ERROR_OFFER_ACTOR_ACCOUNT_MISMATCH,
	ERROR_OFFER_ACTOR_MISMATCH,
} from '$lib/auth/permit_offer_action_specs.js';
import {ERROR_ACTOR_REQUIRED} from '$lib/http/error_schemas.js';
import {
	query_accept_offer,
	query_permit_offer_create,
	PermitOfferActorAccountMismatchError,
	PermitOfferActorMismatchError,
	PermitOfferAlreadyTerminalError,
} from '$lib/auth/permit_offer_queries.js';
import {query_create_actor} from '$lib/auth/account_queries.js';
import {query_permit_revoke_for_scope, query_grant_permit} from '$lib/auth/permit_queries.js';
import {
	AUTH_SESSION_LIFETIME_MS,
	generate_session_token,
	hash_session_token,
	query_create_session,
} from '$lib/auth/session_queries.js';
import {create_session_cookie_value} from '$lib/auth/session_cookie.js';
import {cleanup_expired_permit_offers} from '$lib/auth/cleanup.js';
import {Logger} from '@fuzdev/fuz_util/log.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './permit_offer_test_helpers.js';

describe_db('permit_offer.multi_actor', (get_db) => {
	/** Build a test app where every audit event lands in `events`. */
	const build_app_with_audit = async (events: Array<AuditLogEvent>) =>
		create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
			roles: [ROLE_ADMIN],
			on_audit_event: (event) => {
				events.push(event);
			},
		});

	/** Insert a second actor on an existing account and return its id. */
	const add_second_actor = async (account_id: Uuid, name: string): Promise<Uuid> => {
		const actor = await query_create_actor({db: get_db()}, account_id, name);
		return actor.id;
	};

	describe('account-grain offers (`to_actor_id` null)', () => {
		test('any actor on the recipient account may accept', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_acct_recipient'});
			const second_actor_id = await add_second_actor(recipient.account.id, 'second');

			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			assert.strictEqual(create_res.result.offer.to_actor_id, null);

			// Direct query call exercises the `to_actor_id IS NULL` branch
			// where any actor on `to_account_id` may accept.
			const accepted = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: create_res.result.offer.id,
						to_account_id: recipient.account.id,
						actor_id: second_actor_id,
						ip: null,
					},
				),
			);
			assert.strictEqual(accepted.permit.actor_id, second_actor_id);
		});

		test('audit envelope leaves target_actor_id null on offer-shape events', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_acct_envelope'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);
			const create_event = events.find(
				(e) =>
					e.event_type === 'permit_offer_create' &&
					(e.metadata as {offer_id?: string}).offer_id === res.result.offer.id,
			);
			assert.ok(create_event);
			assert.strictEqual(create_event.target_account_id, recipient.account.id);
			assert.strictEqual(create_event.target_actor_id, null);
		});
	});

	describe('actor-grain offers (`to_actor_id` set)', () => {
		test('only the named actor may accept; wrong-actor rejects with permit_offer_actor_mismatch', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_target'});
			const second_actor_id = await add_second_actor(recipient.account.id, 'second');

			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: recipient.actor.id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			assert.strictEqual(create_res.result.offer.to_actor_id, recipient.actor.id);

			// Wrong actor (sibling on the same account) — must reject.
			const wrong_err = await assert_rejects(() =>
				get_db().transaction(async (tx) =>
					query_accept_offer(
						{db: tx},
						{
							offer_id: create_res.result.offer.id,
							to_account_id: recipient.account.id,
							actor_id: second_actor_id,
							ip: null,
						},
					),
				),
			);
			assert.ok(wrong_err instanceof PermitOfferActorMismatchError);

			// Correct actor — succeeds.
			const accepted = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: create_res.result.offer.id,
						to_account_id: recipient.account.id,
						actor_id: recipient.actor.id,
						ip: null,
					},
				),
			);
			assert.strictEqual(accepted.permit.actor_id, recipient.actor.id);
		});

		test.skip('action-level accept succeeds when the caller passes acting=actor_b [needs acting-as-param wiring]', async () => {
			// Closes the action-layer wrong-actor-accept gap end-to-end.
			// Sessions are account-grain (no actor binding); the per-request
			// `acting` field on the RPC params is what picks the acting
			// actor. With the dispatcher wired, the same recipient session
			// can pass `acting: actor_a` (rejected — wrong actor) or
			// `acting: actor_b` (accepted). Single account, two actors,
			// one session — the test as written below predates the walk-back
			// and still mints two sessions; it needs rewriting around
			// `acting:` once the dispatcher slice lands.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_b_session'});
			const second_actor_id = await add_second_actor(recipient.account.id, 'recipient_b');

			// Offer targeted at actor B.
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: second_actor_id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);

			// Default session (bound to actor A — recipient.actor.id) is
			// rejected even though caller's account matches.
			const wrong_session_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id: create_res.result.offer.id},
				headers: recipient.create_session_headers(),
			});
			assert.ok(!wrong_session_res.ok);
			assert.strictEqual(wrong_session_res.status, 403);
			assert.strictEqual(
				(wrong_session_res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_ACTOR_MISMATCH,
			);

			// Mint a session bound to actor B and retry — succeeds.
			const session_token = generate_session_token();
			const session_hash = hash_session_token(session_token);
			await query_create_session(
				{db: get_db()},
				session_hash,
				recipient.account.id,
				new Date(Date.now() + AUTH_SESSION_LIFETIME_MS),
			);
			const cookie_value = await create_session_cookie_value(
				test_app.backend.keyring,
				session_token,
				session_options,
			);
			const b_headers = {
				cookie: `${session_options.cookie_name}=${encodeURIComponent(cookie_value)}`,
			};

			const accept_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id: create_res.result.offer.id},
				headers: b_headers,
			});
			assert.ok(accept_res.ok);
			assert.strictEqual(accept_res.result.offer.to_actor_id, second_actor_id);
		});

		test.skip('action-level wrong-actor accept maps PermitOfferActorMismatchError to ERROR_OFFER_ACTOR_MISMATCH [needs acting-as-param wiring]', async () => {
			// Single account, two actors. Caller's session binds to the
			// account's first actor; the offer is targeted to the second.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_action_wrong'});
			const second_actor_id = await add_second_actor(recipient.account.id, 'second_wrong');

			// Offer targeted at the second actor; recipient's session is
			// bound to `recipient.actor.id` (the first actor on the account).
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: second_actor_id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);

			const accept_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id: create_res.result.offer.id},
				headers: recipient.create_session_headers(),
			});
			assert.ok(!accept_res.ok);
			assert.strictEqual(accept_res.status, 403);
			assert.strictEqual(
				(accept_res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_ACTOR_MISMATCH,
			);
		});

		test('create envelope carries the target actor on actor-grain offers', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_actor_envelope'});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: recipient.actor.id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);
			const create_event = events.find(
				(e) =>
					e.event_type === 'permit_offer_create' &&
					(e.metadata as {offer_id?: string}).offer_id === res.result.offer.id,
			);
			assert.ok(create_event);
			assert.strictEqual(create_event.target_account_id, recipient.account.id);
			assert.strictEqual(create_event.target_actor_id, recipient.actor.id);
		});

		test('to_actor_id from a different account rejects with offer_actor_account_mismatch', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_xacct_recipient'});
			const stranger = await test_app.create_account({username: 'multi_actor_xacct_stranger'});

			// Direct query: throws.
			const err = await assert_rejects(() =>
				query_permit_offer_create(
					{db: get_db()},
					{
						from_actor_id: test_app.backend.actor.id,
						to_account_id: recipient.account.id,
						to_actor_id: stranger.actor.id,
						role: ROLE_ADMIN,
						expires_at: new Date(Date.now() + 60 * 60 * 1000),
					},
				),
			);
			assert.ok(err instanceof PermitOfferActorAccountMismatchError);

			// Action-level: maps to invalid_params with the new reason.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: stranger.actor.id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_ACTOR_ACCOUNT_MISMATCH,
			);
		});

		test.skip('grantor-side self-target check still fires across multiple grantor actors [needs acting-as-param wiring]', async () => {
			// Two actors on the grantor's account: the self-target check
			// resolves the offering actor's account, not the recipient's.
			// Adding a sibling actor on the grantor must not unblock a
			// self-targeted offer.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			await add_second_actor(test_app.backend.account.id, 'admin_second');

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: test_app.backend.account.id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
		});
	});

	describe('cascade inheritance', () => {
		test('actor-targeted retract carries the actor on the audit envelope', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_actor_retract'});

			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: recipient.actor.id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);

			events.length = 0;
			const retract_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_retract_action_spec,
				params: {offer_id: create_res.result.offer.id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(retract_res.ok);

			const retract_event = events.find((e) => e.event_type === 'permit_offer_retract');
			assert.ok(retract_event);
			assert.strictEqual(retract_event.target_account_id, recipient.account.id);
			assert.strictEqual(retract_event.target_actor_id, recipient.actor.id);
		});

		test('actor-targeted decline still puts the grantor in both target columns', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_actor_decline'});

			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: recipient.actor.id,
					role: ROLE_ADMIN,
				},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);

			events.length = 0;
			const decline_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_decline_action_spec,
				params: {offer_id: create_res.result.offer.id},
				headers: recipient.create_session_headers(),
			});
			assert.ok(decline_res.ok);

			const decline_event = events.find((e) => e.event_type === 'permit_offer_decline');
			assert.ok(decline_event);
			// Decline is *to* the offering actor — both target columns
			// carry the grantor side, regardless of `to_actor_id` semantics.
			assert.strictEqual(decline_event.target_account_id, test_app.backend.account.id);
			assert.strictEqual(decline_event.target_actor_id, test_app.backend.actor.id);
		});

		test('expired actor-targeted offer carries the actor on the permit_offer_expire envelope', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_expire'});

			// Insert an already-past actor-targeted offer directly — the
			// create helper rejects past `expires_at` indirectly through
			// the inbox sweep semantics; bypass via raw insert is the
			// existing pattern for expiry tests.
			const rows = await get_db().query<{id: Uuid}>(
				`INSERT INTO permit_offer (from_actor_id, to_account_id, to_actor_id, role, expires_at)
				 VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 minute')
				 RETURNING id`,
				[test_app.backend.actor.id, recipient.account.id, recipient.actor.id, ROLE_ADMIN],
			);
			const offer_id = rows[0]!.id;

			const captured: Array<AuditLogEvent> = [];
			const count = await cleanup_expired_permit_offers({
				db: get_db(),
				log: new Logger('test_expire', {level: 'off'}),
				on_audit_event: (event) => {
					captured.push(event);
				},
			});
			assert.ok(count >= 1);
			const expire_event = captured.find(
				(e) =>
					e.event_type === 'permit_offer_expire' &&
					(e.metadata as {offer_id?: string}).offer_id === offer_id,
			);
			assert.ok(expire_event);
			assert.strictEqual(expire_event.target_account_id, recipient.account.id);
			assert.strictEqual(expire_event.target_actor_id, recipient.actor.id);
		});

		test('supersede cascade inherits to_actor_id when the sibling was actor-targeted', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'multi_actor_supersede'});
			const grantor_b = await test_app.create_account({
				username: 'multi_actor_supersede_b',
				roles: [ROLE_ADMIN],
			});

			// Offer A — account-grain (no `to_actor_id`).
			const offer_a_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(offer_a_res.ok);
			// Offer B — actor-targeted at the recipient's actor; from a
			// different grantor so the partial unique index allows both
			// to coexist.
			const offer_b_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {
					to_account_id: recipient.account.id,
					to_actor_id: recipient.actor.id,
					role: ROLE_ADMIN,
				},
				headers: grantor_b.create_session_headers(),
			});
			assert.ok(offer_b_res.ok);

			// Accept A — supersedes B in-tx. Audit emission is in-tx,
			// not via fire-and-forget; assert against the DB.
			const accept_result = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: offer_a_res.result.offer.id,
						to_account_id: recipient.account.id,
						actor_id: recipient.actor.id,
						ip: null,
					},
				),
			);
			assert.strictEqual(accept_result.superseded_offers.length, 1);
			const supersede_event = accept_result.audit_events.find(
				(e) => e.event_type === 'permit_offer_supersede',
			);
			assert.ok(supersede_event);
			assert.strictEqual(supersede_event.target_account_id, recipient.account.id);
			assert.strictEqual(supersede_event.target_actor_id, recipient.actor.id);
		});
	});

	describe('permit_revoke envelope on multi-actor accounts', () => {
		test('target_actor_id names the granted actor, not whichever the index returns first', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'multi_actor_revoke'});
			// Insert a second actor on the recipient before granting the
			// permit to the first one. A naive `first_actor_by_account`
			// lookup would now race between the two; the revoke audit
			// must still name the actually-bound actor.
			await add_second_actor(recipient.account.id, 'unbound_sibling');

			const permit = await query_grant_permit(
				{db: get_db()},
				{
					actor_id: recipient.actor.id,
					role: ROLE_ADMIN,
					granted_by: test_app.backend.actor.id,
				},
			);

			events.length = 0;
			const revoke_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_revoke_action_spec,
				params: {actor_id: recipient.actor.id, permit_id: permit.id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(revoke_res.ok);

			const revoke_event = events.find((e) => e.event_type === 'permit_revoke');
			assert.ok(revoke_event);
			assert.strictEqual(revoke_event.target_account_id, recipient.account.id);
			assert.strictEqual(revoke_event.target_actor_id, recipient.actor.id);
		});
	});

	describe('query_permit_revoke_for_scope returns actor + account per revoked permit', () => {
		test('cascade returns one entry per revoked permit with correct actor + account', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const a = await test_app.create_account({username: 'scope_revoke_a'});
			const b = await test_app.create_account({username: 'scope_revoke_b'});

			const scope: Uuid = '11111111-1111-4111-8111-111111111111' as Uuid;

			await query_grant_permit(
				{db: get_db()},
				{actor_id: a.actor.id, role: 'classroom_student', scope_id: scope, granted_by: null},
			);
			await query_grant_permit(
				{db: get_db()},
				{actor_id: b.actor.id, role: 'classroom_student', scope_id: scope, granted_by: null},
			);

			const result = await get_db().transaction(async (tx) =>
				query_permit_revoke_for_scope({db: tx}, scope, null, 'scope_destroyed'),
			);

			assert.strictEqual(result.revoked.length, 2);
			const by_actor = new Map<string, (typeof result.revoked)[number]>();
			for (const row of result.revoked) by_actor.set(row.actor_id, row);
			const a_row = by_actor.get(a.actor.id);
			const b_row = by_actor.get(b.actor.id);
			assert.ok(a_row);
			assert.ok(b_row);
			assert.strictEqual(a_row.account_id, a.account.id);
			assert.strictEqual(b_row.account_id, b.account.id);
			assert.strictEqual(a_row.scope_id, scope);
			assert.strictEqual(b_row.role, 'classroom_student');
		});
	});

	describe('middleware-level multi-actor 400', () => {
		test('authenticated request with multi-actor account hits 400 actor_required before any RPC dispatch', async () => {
			// Today's middleware passes `undefined` to `resolve_acting_actor`
			// (TODO[acting-as-param]) so under v1 1:1 the unique actor
			// resolves transparently. Once an account has 2+ actors, the
			// missing `acting` signal must surface as a 400 ahead of the
			// RPC dispatcher with the available actor list — never silently
			// pick. This is the v1 contract for multi-actor today; rewrite
			// to thread `acting:` through the dispatcher when the per-request
			// layer lands.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({
				username: 'multi_actor_middleware_400',
			});
			await add_second_actor(recipient.account.id, 'middleware_second');

			// Use a low-side-effect read action so we exercise the
			// middleware path without depending on handler logic.
			const post_init = {
				method: 'POST' as const,
				headers: {
					...recipient.create_session_headers(),
					host: 'localhost',
					origin: 'http://localhost:5173',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'test_actor_required',
					method: permit_offer_list_action_spec.method,
					params: {},
				}),
			};
			const res = await test_app.app.request(RPC_PATH, post_init);
			assert.strictEqual(res.status, 400);
			const body = (await res.json()) as {
				error: string;
				available: Array<{id: string; name: string}>;
			};
			assert.strictEqual(body.error, ERROR_ACTOR_REQUIRED);
			assert.ok(Array.isArray(body.available));
			assert.strictEqual(body.available.length, 2);
			const ids = new Set(body.available.map((a) => a.id));
			assert.ok(ids.has(recipient.actor.id));
		});

		test('authenticated single-actor account passes middleware (no false positive)', async () => {
			// Regression guard for the v1 1:1 default — middleware must
			// transparently pick the unique actor and not 400.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({
				username: 'multi_actor_single_passes',
			});

			const list_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_list_action_spec,
				params: {},
				headers: recipient.create_session_headers(),
			});
			assert.ok(list_res.ok);
		});
	});

	describe('account-grain accept race-loser actor mismatch', () => {
		test("losing actor on the same account gets PermitOfferAlreadyTerminalError, not someone else's permit", async () => {
			// Two actors on the recipient account both attempt to accept
			// the same account-grain offer. The race winner binds the
			// permit to actor_A; the loser must not silently receive
			// "you got the permit" with actor_A's permit row attached.
			// Under v1 1:1 this branch is unreachable; under multi-actor
			// it's the difference between truthful "offer is terminal"
			// and misleading "permit obtained" UI.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'race_loser_recipient'});
			const second_actor_id = await add_second_actor(recipient.account.id, 'race_loser_b');

			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);

			// Actor A wins the race.
			const winner = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: create_res.result.offer.id,
						to_account_id: recipient.account.id,
						actor_id: recipient.actor.id,
						ip: null,
					},
				),
			);
			assert.strictEqual(winner.permit.actor_id, recipient.actor.id);

			// Actor B (the loser) tries to accept the same offer. The
			// offer is now accepted; the locked.accepted_at branch fires.
			// permit.actor_id !== actor_id → terminal error.
			const err = await assert_rejects(() =>
				get_db().transaction(async (tx) =>
					query_accept_offer(
						{db: tx},
						{
							offer_id: create_res.result.offer.id,
							to_account_id: recipient.account.id,
							actor_id: second_actor_id,
							ip: null,
						},
					),
				),
			);
			assert.ok(
				err instanceof PermitOfferAlreadyTerminalError,
				`expected PermitOfferAlreadyTerminalError, got ${err.constructor.name}: ${err.message}`,
			);
		});

		test('same-actor retry on accepted offer still returns idempotent permit (no spurious terminal)', async () => {
			// Retry path — same actor attempts twice, second call observes
			// the already-accepted offer and returns the existing permit.
			// Must not be broken by the loser-mismatch guard: actor matches.
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'race_idempotent_retry'});

			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);

			const first = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: create_res.result.offer.id,
						to_account_id: recipient.account.id,
						actor_id: recipient.actor.id,
						ip: null,
					},
				),
			);
			const second = await get_db().transaction(async (tx) =>
				query_accept_offer(
					{db: tx},
					{
						offer_id: create_res.result.offer.id,
						to_account_id: recipient.account.id,
						actor_id: recipient.actor.id,
						ip: null,
					},
				),
			);
			assert.strictEqual(first.created, true);
			assert.strictEqual(second.created, false);
			assert.strictEqual(second.permit.id, first.permit.id);
			assert.strictEqual(second.permit.actor_id, recipient.actor.id);
		});
	});
});
