/**
 * Integration tests for `permit_offer_accept`.
 *
 * Covers the happy path, IDOR 404 mask, terminal-state rejection, expired
 * rejection, sibling supersede reporting, and terminal-on-accepted
 * semantics for subsequent decline/retract. Audit emission on accept
 * lives in `permit_offer_actions.audit.db.test.ts`; scope-aware accept
 * flows live in `permit_offer_actions.scoped.db.test.ts`.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	permit_offer_create_action_spec,
	permit_offer_accept_action_spec,
	permit_offer_decline_action_spec,
	permit_offer_retract_action_spec,
	ERROR_OFFER_NOT_FOUND,
	ERROR_OFFER_TERMINAL,
	ERROR_OFFER_EXPIRED,
} from '$lib/auth/permit_offer_action_specs.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './permit_offer_test_helpers.js';

describe_db('permit_offer_actions.accept', (get_db) => {
	describe('permit_offer_accept', () => {
		test('recipient accepts and receives permit_id + offer', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'accept_recipient'});
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			const offer_id = create_res.result.offer.id;

			const accept_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id},
				headers: recipient.create_session_headers(),
			});
			assert.ok(accept_res.ok);
			assert.strictEqual(accept_res.status, 200);
			assert.ok(accept_res.result.permit_id);
			assert.strictEqual(accept_res.result.offer.id, offer_id);
			assert.ok(accept_res.result.offer.accepted_at);
			assert.deepStrictEqual(accept_res.result.superseded_offer_ids, []);
		});

		test('wrong account returns offer_not_found (IDOR mask)', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'accept_idor_recipient'});
			const attacker = await test_app.create_account({username: 'accept_idor_attacker'});
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			const offer_id = create_res.result.offer.id;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id},
				headers: attacker.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.not_found);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_NOT_FOUND,
			);
		});

		test('accepting a declined offer returns offer_terminal', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'accept_terminal_recipient'});
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			const offer_id = create_res.result.offer.id;

			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_decline_action_spec,
				params: {offer_id},
				headers: recipient.create_session_headers(),
			});

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id},
				headers: recipient.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_request);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_TERMINAL,
			);
		});

		test('accepting an expired offer returns offer_expired', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'accept_expired_recipient'});
			const db = get_db();

			// Insert an already-expired offer directly.
			const rows = await db.query<{id: Uuid}>(
				`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
				 VALUES ($1, $2, $3, NOW() - INTERVAL '1 minute')
				 RETURNING id`,
				[test_app.backend.actor.id, recipient.account.id, ROLE_ADMIN],
			);
			const offer_id = rows[0]!.id;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id},
				headers: recipient.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_request);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_EXPIRED,
			);
		});

		test('accept reports superseded siblings', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const grantor_b = await test_app.create_account({
				username: 'sibling_grantor_b',
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'sibling_recipient'});

			const create_a = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_a.ok);
			const offer_a = create_a.result.offer.id;

			const create_b = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: grantor_b.create_session_headers(),
			});
			assert.ok(create_b.ok);
			const offer_b = create_b.result.offer.id;

			const accept_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id: offer_a},
				headers: recipient.create_session_headers(),
			});
			assert.ok(accept_res.ok);
			assert.deepStrictEqual(accept_res.result.superseded_offer_ids, [offer_b]);
		});
	});

	describe('terminal-on-accepted', () => {
		const setup_accepted_offer = async (username_suffix: string, get_db_fn: typeof get_db) => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db_fn(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({
				username: `accepted_terminal_${username_suffix}`,
			});
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			const offer_id = create_res.result.offer.id;
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_accept_action_spec,
				params: {offer_id},
				headers: recipient.create_session_headers(),
			});
			return {test_app, recipient, offer_id};
		};

		test('decline on accepted offer returns offer_terminal', async () => {
			const {test_app, recipient, offer_id} = await setup_accepted_offer('decline', get_db);
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_decline_action_spec,
				params: {offer_id},
				headers: recipient.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_TERMINAL,
			);
		});

		test('retract on accepted offer returns offer_terminal', async () => {
			const {test_app, offer_id} = await setup_accepted_offer('retract', get_db);
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: permit_offer_retract_action_spec,
				params: {offer_id},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_OFFER_TERMINAL,
			);
		});
	});
});
