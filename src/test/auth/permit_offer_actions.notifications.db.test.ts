/**
 * End-to-end tests for the WS notification send sites in the permit-offer
 * RPC handlers. Injects a capturing `NotificationSender` into
 * `create_permit_offer_actions` and asserts that each lifecycle transition
 * (create/retract/accept/decline) fires a notification to the right account
 * with the right method and payload shape.
 *
 * Exercises the full handler stack (RPC dispatcher + transaction + post-commit
 * fan-out), so sends fire strictly after the response is returned.
 * `create_test_app` sets `await_pending_effects: true`, which waits for those
 * sends before yielding control back to the test.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {
	create_pglite_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
} from '$lib/testing/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {
	PERMIT_OFFER_CREATE_METHOD,
	PERMIT_OFFER_ACCEPT_METHOD,
	PERMIT_OFFER_DECLINE_METHOD,
	PERMIT_OFFER_RETRACT_METHOD,
} from '$lib/auth/permit_offer_actions.js';
import {
	PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD,
	PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
} from '$lib/auth/permit_offer_notifications.js';
import {create_rpc_post_init} from '$lib/testing/rpc_helpers.js';
import type {Db} from '$lib/db/db.js';
import type {Hono} from 'hono';
import {
	NOTIFICATION_TEST_RPC_PATH,
	create_capture_sender,
	create_notification_route_specs_factory,
	type CapturedNotificationCall,
} from './notification_helpers.js';

const session_options = create_session_config('test_session');
const RPC_PATH = NOTIFICATION_TEST_RPC_PATH;

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, AUTH_INTEGRATION_TRUNCATE_TABLES);

const send_rpc = async (
	app: Hono,
	path: string,
	method: string,
	params: unknown,
	headers: Record<string, string>,
): Promise<Response> => {
	const init = create_rpc_post_init(method, params ?? null, 'test');
	return app.request(path, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			host: 'localhost',
			origin: 'http://localhost:5173',
			...headers,
		},
	});
};

describe_db('permit_offer_actions notifications', (get_db) => {
	describe('create fires permit_offer_received to the recipient', () => {
		test('single recipient, single call', async () => {
			const calls: Array<CapturedNotificationCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_notification_route_specs_factory(sender),
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'notif_create_recipient'});

			const res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_CREATE_METHOD,
				{to_account_id: recipient.account.id, role: ROLE_ADMIN},
				test_app.create_session_headers(),
			);
			assert.strictEqual(res.status, 200);

			const matches = calls.filter((c) => c.method === PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD);
			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0]?.account_id, recipient.account.id);
			const params = matches[0]?.params as {offer?: {role?: string; to_account_id?: string}};
			assert.strictEqual(params.offer?.role, ROLE_ADMIN);
			assert.strictEqual(params.offer?.to_account_id, recipient.account.id);
		});
	});

	describe('retract fires permit_offer_retracted to the recipient', () => {
		test('retract after create', async () => {
			const calls: Array<CapturedNotificationCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_notification_route_specs_factory(sender),
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'notif_retract_recipient'});

			const create_res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_CREATE_METHOD,
				{to_account_id: recipient.account.id, role: ROLE_ADMIN},
				test_app.create_session_headers(),
			);
			const offer_id = (await create_res.json()).result.offer.id;
			calls.length = 0;

			const retract_res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_RETRACT_METHOD,
				{offer_id},
				test_app.create_session_headers(),
			);
			assert.strictEqual(retract_res.status, 200);

			const matches = calls.filter((c) => c.method === PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD);
			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0]?.account_id, recipient.account.id);
			const params = matches[0]?.params as {offer?: {id?: string}};
			assert.strictEqual(params.offer?.id, offer_id);
		});
	});

	describe('decline fires permit_offer_declined to the grantor', () => {
		test('decline with reason', async () => {
			const calls: Array<CapturedNotificationCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_notification_route_specs_factory(sender),
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'notif_decline_recipient'});

			const create_res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_CREATE_METHOD,
				{to_account_id: recipient.account.id, role: ROLE_ADMIN},
				test_app.create_session_headers(),
			);
			const offer_id = (await create_res.json()).result.offer.id;
			calls.length = 0;

			const decline_res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_DECLINE_METHOD,
				{offer_id, reason: 'no thanks'},
				recipient.create_session_headers(),
			);
			assert.strictEqual(decline_res.status, 200);

			const matches = calls.filter((c) => c.method === PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD);
			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0]?.account_id, test_app.backend.account.id);
			const params = matches[0]?.params as {
				offer?: {id?: string; decline_reason?: string | null};
			};
			assert.strictEqual(params.offer?.id, offer_id);
			assert.strictEqual(params.offer?.decline_reason, 'no thanks');
		});

		test('decline without reason carries null', async () => {
			const calls: Array<CapturedNotificationCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_notification_route_specs_factory(sender),
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'notif_decline_no_reason'});

			const create_res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_CREATE_METHOD,
				{to_account_id: recipient.account.id, role: ROLE_ADMIN},
				test_app.create_session_headers(),
			);
			const offer_id = (await create_res.json()).result.offer.id;
			calls.length = 0;

			await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_DECLINE_METHOD,
				{offer_id},
				recipient.create_session_headers(),
			);
			const match = calls.find((c) => c.method === PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD);
			assert.ok(match);
			const params = match.params as {offer?: {decline_reason?: string | null}};
			assert.strictEqual(params.offer?.decline_reason, null);
		});
	});

	describe('accept fires accepted to grantor plus supersedes to every sibling grantor', () => {
		test('two siblings, one accepted, one superseded', async () => {
			const calls: Array<CapturedNotificationCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_notification_route_specs_factory(sender),
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const grantor_b = await test_app.create_account({
				username: 'notif_accept_grantor_b',
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'notif_accept_recipient'});

			const offer_a_res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_CREATE_METHOD,
				{to_account_id: recipient.account.id, role: ROLE_ADMIN},
				test_app.create_session_headers(),
			);
			const offer_a_id = (await offer_a_res.json()).result.offer.id;
			const offer_b_res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_CREATE_METHOD,
				{to_account_id: recipient.account.id, role: ROLE_ADMIN},
				grantor_b.create_session_headers(),
			);
			const offer_b_id = (await offer_b_res.json()).result.offer.id;
			calls.length = 0;

			const accept_res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_ACCEPT_METHOD,
				{offer_id: offer_a_id},
				recipient.create_session_headers(),
			);
			assert.strictEqual(accept_res.status, 200);

			const accepted = calls.filter((c) => c.method === PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD);
			assert.strictEqual(accepted.length, 1);
			assert.strictEqual(accepted[0]?.account_id, test_app.backend.account.id);
			const accepted_params = accepted[0]?.params as {offer?: {id?: string}};
			assert.strictEqual(accepted_params.offer?.id, offer_a_id);

			const supersedes = calls.filter(
				(c) => c.method === PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
			);
			assert.strictEqual(supersedes.length, 1);
			assert.strictEqual(supersedes[0]?.account_id, grantor_b.account.id);
			const supersede_params = supersedes[0]?.params as {
				offer?: {id?: string};
				reason?: string;
				cause_id?: string;
			};
			assert.strictEqual(supersede_params.offer?.id, offer_b_id);
			assert.strictEqual(supersede_params.reason, 'sibling_accepted');
			assert.strictEqual(supersede_params.cause_id, offer_a_id);
		});

		test('solo accept (no siblings) fires only the accepted notification', async () => {
			const calls: Array<CapturedNotificationCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_notification_route_specs_factory(sender),
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'notif_solo_accept_recipient'});

			const create_res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_CREATE_METHOD,
				{to_account_id: recipient.account.id, role: ROLE_ADMIN},
				test_app.create_session_headers(),
			);
			const offer_id = (await create_res.json()).result.offer.id;
			calls.length = 0;

			await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_ACCEPT_METHOD,
				{offer_id},
				recipient.create_session_headers(),
			);
			const accepted = calls.filter((c) => c.method === PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD);
			assert.strictEqual(accepted.length, 1);
			const supersedes = calls.filter(
				(c) => c.method === PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
			);
			assert.strictEqual(supersedes.length, 0);
		});
	});

	describe('failure paths do not fire notifications', () => {
		test('authorize=false produces no notification', async () => {
			const calls: Array<CapturedNotificationCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_notification_route_specs_factory(sender),
				db: get_db(),
			});
			const recipient = await test_app.create_account({username: 'notif_fail_recipient'});
			const caller = await test_app.create_account({username: 'notif_fail_caller'});

			const res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_CREATE_METHOD,
				{to_account_id: recipient.account.id, role: ROLE_ADMIN},
				caller.create_session_headers(),
			);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(calls.length, 0);
		});

		test('decline on terminal offer produces no notification', async () => {
			const calls: Array<CapturedNotificationCall> = [];
			const sender = create_capture_sender(calls);
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_notification_route_specs_factory(sender),
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'notif_terminal_recipient'});

			const create_res = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_CREATE_METHOD,
				{to_account_id: recipient.account.id, role: ROLE_ADMIN},
				test_app.create_session_headers(),
			);
			const offer_id = (await create_res.json()).result.offer.id;
			await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_DECLINE_METHOD,
				{offer_id},
				recipient.create_session_headers(),
			);
			calls.length = 0;

			const retry = await send_rpc(
				test_app.app,
				RPC_PATH,
				PERMIT_OFFER_DECLINE_METHOD,
				{offer_id},
				recipient.create_session_headers(),
			);
			assert.strictEqual(retry.status, 400);
			assert.strictEqual(calls.length, 0);
		});
	});
});
