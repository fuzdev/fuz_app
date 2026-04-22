/**
 * Integration tests for permit_offer_actions — the five RPC action handlers.
 *
 * Exercises each method end-to-end through a real `create_rpc_endpoint`
 * dispatch (envelope → auth → transaction → handler → audit). Error paths
 * confirm distinct `{reason}` data on the JSON-RPC error envelope so clients
 * can discriminate terminal / expired / not_found / self_target.
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
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {
	create_permit_offer_actions,
	PERMIT_OFFER_CREATE_METHOD,
	PERMIT_OFFER_ACCEPT_METHOD,
	PERMIT_OFFER_DECLINE_METHOD,
	PERMIT_OFFER_RETRACT_METHOD,
	PERMIT_OFFER_LIST_METHOD,
	PERMIT_REVOKE_METHOD,
	ERROR_OFFER_TERMINAL,
	ERROR_OFFER_NOT_FOUND,
	ERROR_OFFER_EXPIRED,
	ERROR_OFFER_SELF_TARGET,
	ERROR_OFFER_NOT_AUTHORIZED,
	ERROR_OFFER_ROLE_NOT_GRANTABLE,
} from '$lib/auth/permit_offer_actions.js';
import {
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_PERMIT_NOT_FOUND,
	ERROR_ROLE_NOT_WEB_GRANTABLE,
} from '$lib/http/error_schemas.js';
import {create_uuid} from '$lib/uuid.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {create_rpc_post_init} from '$lib/testing/rpc_helpers.js';
import type {Db} from '$lib/db/db.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RouteSpec} from '$lib/http/route_spec.js';
import type {Hono} from 'hono';

const session_options = create_session_config('test_session');

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, AUTH_INTEGRATION_TRUNCATE_TABLES);

const RPC_PATH = '/api/rpc';

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_permit_offer_actions(ctx.deps),
		log: ctx.deps.log,
	}),
];

interface RpcRequestOptions {
	headers: Record<string, string>;
	method: string;
	params?: unknown;
	id?: string | number;
}

const send_rpc = async (app: Hono, options: RpcRequestOptions): Promise<Response> => {
	const init = create_rpc_post_init(options.method, options.params ?? null, options.id ?? 'test');
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		host: 'localhost',
		origin: 'http://localhost:5173',
		...options.headers,
	};
	return app.request(RPC_PATH, {...init, headers});
};

describe_db('permit_offer_actions', (get_db) => {
	describe('permit_offer_create', () => {
		test('grantor holding admin role can offer admin', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'create_recipient'});
			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.ok(body.result?.offer?.id, JSON.stringify(body));
			assert.strictEqual(body.result.offer.role, ROLE_ADMIN);
			assert.strictEqual(body.result.offer.to_account_id, recipient.account.id);
			assert.strictEqual(body.result.offer.accepted_at, null);
		});

		test('caller without the role is forbidden (not_authorized)', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const recipient = await test_app.create_account({username: 'create_forbidden_recipient'});
			const caller = await test_app.create_account({username: 'create_forbidden_caller'});
			const res = await send_rpc(test_app.app, {
				headers: caller.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			assert.strictEqual(res.status, 403);
			const body = await res.json();
			assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(body.error.data?.reason, ERROR_OFFER_NOT_AUTHORIZED);
		});

		test('self-offer rejected with offer_self_target reason', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: test_app.backend.account.id, role: ROLE_ADMIN},
			});
			assert.strictEqual(res.status, 400);
			const body = await res.json();
			assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_params);
			assert.strictEqual(body.error.data?.reason, ERROR_OFFER_SELF_TARGET);
		});
	});

	describe('permit_offer_accept', () => {
		test('recipient accepts and receives permit_id + offer', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'accept_recipient'});
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const created = await create_res.json();
			const offer_id = created.result.offer.id;

			const accept_res = await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_ACCEPT_METHOD,
				params: {offer_id},
			});
			assert.strictEqual(accept_res.status, 200);
			const body = await accept_res.json();
			assert.ok(body.result.permit_id);
			assert.strictEqual(body.result.offer.id, offer_id);
			assert.ok(body.result.offer.accepted_at);
			assert.deepStrictEqual(body.result.superseded_offer_ids, []);
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
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_id = (await create_res.json()).result.offer.id;

			const res = await send_rpc(test_app.app, {
				headers: attacker.create_session_headers(),
				method: PERMIT_OFFER_ACCEPT_METHOD,
				params: {offer_id},
			});
			assert.strictEqual(res.status, 404);
			const body = await res.json();
			assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.not_found);
			assert.strictEqual(body.error.data?.reason, ERROR_OFFER_NOT_FOUND);
		});

		test('accepting a declined offer returns offer_terminal', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'accept_terminal_recipient'});
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_id = (await create_res.json()).result.offer.id;

			await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_DECLINE_METHOD,
				params: {offer_id},
			});

			const res = await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_ACCEPT_METHOD,
				params: {offer_id},
			});
			assert.strictEqual(res.status, 400);
			const body = await res.json();
			assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_request);
			assert.strictEqual(body.error.data?.reason, ERROR_OFFER_TERMINAL);
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
			const rows = await db.query<{id: string}>(
				`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
				 VALUES ($1, $2, $3, NOW() - INTERVAL '1 minute')
				 RETURNING id`,
				[test_app.backend.actor.id, recipient.account.id, ROLE_ADMIN],
			);
			const offer_id = rows[0]!.id;

			const res = await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_ACCEPT_METHOD,
				params: {offer_id},
			});
			assert.strictEqual(res.status, 400);
			const body = await res.json();
			assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.invalid_request);
			assert.strictEqual(body.error.data?.reason, ERROR_OFFER_EXPIRED);
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

			const create_a = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_a = (await create_a.json()).result.offer.id;

			const create_b = await send_rpc(test_app.app, {
				headers: grantor_b.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_b = (await create_b.json()).result.offer.id;

			const accept_res = await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_ACCEPT_METHOD,
				params: {offer_id: offer_a},
			});
			const body = await accept_res.json();
			assert.deepStrictEqual(body.result.superseded_offer_ids, [offer_b]);
		});
	});

	describe('permit_offer_decline', () => {
		test('recipient declines successfully', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'decline_recipient'});
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_id = (await create_res.json()).result.offer.id;

			const res = await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_DECLINE_METHOD,
				params: {offer_id, reason: 'no thanks'},
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.deepStrictEqual(body.result, {ok: true});
		});

		test('wrong account returns offer_not_found', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'decline_idor_recipient'});
			const attacker = await test_app.create_account({username: 'decline_idor_attacker'});
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_id = (await create_res.json()).result.offer.id;

			const res = await send_rpc(test_app.app, {
				headers: attacker.create_session_headers(),
				method: PERMIT_OFFER_DECLINE_METHOD,
				params: {offer_id},
			});
			assert.strictEqual(res.status, 404);
			const body = await res.json();
			assert.strictEqual(body.error.data?.reason, ERROR_OFFER_NOT_FOUND);
		});
	});

	describe('permit_offer_retract', () => {
		test('grantor retracts successfully', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'retract_recipient'});
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_id = (await create_res.json()).result.offer.id;

			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_RETRACT_METHOD,
				params: {offer_id},
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.deepStrictEqual(body.result, {ok: true});
		});

		test('non-grantor retract attempt returns offer_not_found', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'retract_other_recipient'});
			const other = await test_app.create_account({
				username: 'retract_other_actor',
				roles: [ROLE_ADMIN],
			});
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_id = (await create_res.json()).result.offer.id;

			const res = await send_rpc(test_app.app, {
				headers: other.create_session_headers(),
				method: PERMIT_OFFER_RETRACT_METHOD,
				params: {offer_id},
			});
			assert.strictEqual(res.status, 404);
			const body = await res.json();
			assert.strictEqual(body.error.data?.reason, ERROR_OFFER_NOT_FOUND);
		});
	});

	describe('permit_offer_list', () => {
		test('caller lists own inbox', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'list_recipient'});
			await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});

			const res = await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_LIST_METHOD,
				params: {},
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.strictEqual(body.result.offers.length, 1);
			assert.strictEqual(body.result.offers[0].to_account_id, recipient.account.id);
		});

		test('non-admin cross-account list is forbidden', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const other = await test_app.create_account({username: 'list_other_recipient'});
			const caller = await test_app.create_account({username: 'list_other_caller'});

			const res = await send_rpc(test_app.app, {
				headers: caller.create_session_headers(),
				method: PERMIT_OFFER_LIST_METHOD,
				params: {account_id: other.account.id},
			});
			assert.strictEqual(res.status, 403);
			const body = await res.json();
			assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.forbidden);
		});

		test('admin can list another account with account_id param', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'admin_list_target'});
			await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: target.account.id, role: ROLE_ADMIN},
			});

			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_LIST_METHOD,
				params: {account_id: target.account.id},
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.strictEqual(body.result.offers.length, 1);
		});
	});

	describe('scoped offers', () => {
		test('create-with-scope yields a scoped permit on accept', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'scope_recipient'});
			const scope_id = create_uuid();
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN, scope_id},
			});
			const created = await create_res.json();
			assert.strictEqual(created.result.offer.scope_id, scope_id);
			const accept_res = await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_ACCEPT_METHOD,
				params: {offer_id: created.result.offer.id},
			});
			const accepted = await accept_res.json();
			const permit_rows = await get_db().query<{scope_id: string | null}>(
				`SELECT scope_id FROM permit WHERE id = $1`,
				[accepted.result.permit_id],
			);
			assert.strictEqual(permit_rows[0]?.scope_id, scope_id);
		});

		test('sibling offers in different scopes do not supersede each other', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'scope_sibling_recipient'});
			const scope_a = create_uuid();
			const scope_b = create_uuid();
			const create_a = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN, scope_id: scope_a},
			});
			const offer_a = (await create_a.json()).result.offer.id;
			const create_b = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN, scope_id: scope_b},
			});
			const offer_b = (await create_b.json()).result.offer.id;
			const accept_res = await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_ACCEPT_METHOD,
				params: {offer_id: offer_a},
			});
			const accepted = await accept_res.json();
			// Sibling in a different scope stays pending.
			assert.deepStrictEqual(accepted.result.superseded_offer_ids, []);
			const rows = await get_db().query<{id: string; superseded_at: Date | null}>(
				`SELECT id, superseded_at FROM permit_offer WHERE id = ANY($1::uuid[])`,
				[[offer_a, offer_b]],
			);
			const by_id = new Map(rows.map((r) => [r.id, r]));
			assert.strictEqual(by_id.get(offer_b)?.superseded_at, null);
		});
	});

	describe('audit event fan-out', () => {
		const build_app_with_audit = async (
			events: Array<AuditLogEvent>,
		): Promise<Awaited<ReturnType<typeof create_test_app>>> =>
			create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
				on_audit_event: (event) => {
					events.push(event);
				},
			});

		test('create emits permit_offer_create with metadata', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'audit_create_recipient'});
			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const created = await res.json();
			const match = events.find(
				(e) =>
					e.event_type === 'permit_offer_create' &&
					(e.metadata as {offer_id?: string}).offer_id === created.result.offer.id,
			);
			assert.ok(match, 'expected permit_offer_create event');
			assert.notStrictEqual(match.outcome, 'failure');
			assert.strictEqual(
				(match.metadata as {to_account_id?: string}).to_account_id,
				recipient.account.id,
			);
		});

		test('web_grantable=false emits failure-outcome create event', async () => {
			const events: Array<AuditLogEvent> = [];
			// bootstrap account has keeper role already but ROLE_KEEPER is not web_grantable;
			// offering keeper triggers the web_grantable gate.
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'audit_webgrant_recipient'});
			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_KEEPER},
			});
			assert.strictEqual(res.status, 403);
			assert.strictEqual((await res.json()).error.data?.reason, ERROR_OFFER_ROLE_NOT_GRANTABLE);
			const failure = events.find(
				(e) => e.event_type === 'permit_offer_create' && e.outcome === 'failure',
			);
			assert.ok(failure, 'expected a failure-outcome permit_offer_create event');
			assert.strictEqual((failure.metadata as {role?: string}).role, ROLE_KEEPER);
		});

		test('authorize=false emits failure-outcome create event', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				on_audit_event: (event) => {
					events.push(event);
				},
			});
			const recipient = await test_app.create_account({username: 'audit_authz_recipient'});
			const caller = await test_app.create_account({username: 'audit_authz_caller'});
			const res = await send_rpc(test_app.app, {
				headers: caller.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			assert.strictEqual(res.status, 403);
			assert.strictEqual((await res.json()).error.data?.reason, ERROR_OFFER_NOT_AUTHORIZED);
			const failure = events.find(
				(e) =>
					e.event_type === 'permit_offer_create' &&
					e.outcome === 'failure' &&
					e.actor_id === caller.actor.id,
			);
			assert.ok(failure, 'expected a failure-outcome permit_offer_create event');
		});

		test('self-target emits failure-outcome create event', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: test_app.backend.account.id, role: ROLE_ADMIN},
			});
			assert.strictEqual(res.status, 400);
			assert.strictEqual((await res.json()).error.data?.reason, ERROR_OFFER_SELF_TARGET);
			const failure = events.find(
				(e) =>
					e.event_type === 'permit_offer_create' &&
					e.outcome === 'failure' &&
					e.target_account_id === test_app.backend.account.id,
			);
			assert.ok(failure, 'expected a failure-outcome permit_offer_create event');
			assert.strictEqual((failure.metadata as {role?: string}).role, ROLE_ADMIN);
			assert.strictEqual(
				(failure.metadata as {offer_id?: string}).offer_id,
				undefined,
				'no offer row was written, so metadata must not carry offer_id',
			);
		});

		test('accept emits permit_offer_accept + permit_grant post-commit', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'audit_accept_recipient'});
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_id = (await create_res.json()).result.offer.id;
			events.length = 0;
			await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_ACCEPT_METHOD,
				params: {offer_id},
			});
			const types = events.map((e) => e.event_type);
			assert.ok(
				types.includes('permit_offer_accept'),
				`missing permit_offer_accept in ${types.join(',')}`,
			);
			assert.ok(types.includes('permit_grant'), `missing permit_grant in ${types.join(',')}`);
		});

		test('decline emits permit_offer_decline', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'audit_decline_recipient'});
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_id = (await create_res.json()).result.offer.id;
			events.length = 0;
			await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_DECLINE_METHOD,
				params: {offer_id, reason: 'nah'},
			});
			const match = events.find((e) => e.event_type === 'permit_offer_decline');
			assert.ok(match, 'expected permit_offer_decline event');
			assert.strictEqual((match.metadata as {offer_id?: string}).offer_id, offer_id);
			assert.strictEqual((match.metadata as {reason?: string}).reason, 'nah');
		});

		test('retract emits permit_offer_retract', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'audit_retract_recipient'});
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_id = (await create_res.json()).result.offer.id;
			events.length = 0;
			await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_RETRACT_METHOD,
				params: {offer_id},
			});
			const match = events.find((e) => e.event_type === 'permit_offer_retract');
			assert.ok(match, 'expected permit_offer_retract event');
			assert.strictEqual((match.metadata as {offer_id?: string}).offer_id, offer_id);
		});
	});

	describe('decline semantics', () => {
		test('decline reason persists to decline_reason column', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'decline_reason_recipient'});
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_id = (await create_res.json()).result.offer.id;
			await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_DECLINE_METHOD,
				params: {offer_id, reason: 'wrong classroom'},
			});
			const rows = await get_db().query<{decline_reason: string | null}>(
				`SELECT decline_reason FROM permit_offer WHERE id = $1`,
				[offer_id],
			);
			assert.strictEqual(rows[0]?.decline_reason, 'wrong classroom');
		});
	});

	describe('terminal-on-accepted', () => {
		const setup_accepted_offer = async (username_suffix: string) => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({
				username: `accepted_terminal_${username_suffix}`,
			});
			const create_res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			const offer_id = (await create_res.json()).result.offer.id;
			await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_ACCEPT_METHOD,
				params: {offer_id},
			});
			return {test_app, recipient, offer_id};
		};

		test('decline on accepted offer returns offer_terminal', async () => {
			const {test_app, recipient, offer_id} = await setup_accepted_offer('decline');
			const res = await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_DECLINE_METHOD,
				params: {offer_id},
			});
			assert.strictEqual(res.status, 400);
			assert.strictEqual((await res.json()).error.data?.reason, ERROR_OFFER_TERMINAL);
		});

		test('retract on accepted offer returns offer_terminal', async () => {
			const {test_app, offer_id} = await setup_accepted_offer('retract');
			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_RETRACT_METHOD,
				params: {offer_id},
			});
			assert.strictEqual(res.status, 400);
			assert.strictEqual((await res.json()).error.data?.reason, ERROR_OFFER_TERMINAL);
		});
	});

	describe('re-offer upsert', () => {
		test('same grantor re-offering returns the same offer with refreshed message', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'reoffer_recipient'});
			const first = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN, message: 'first'},
			});
			const offer_id_1 = (await first.json()).result.offer.id;
			const second = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN, message: 'second'},
			});
			const body = await second.json();
			assert.strictEqual(body.result.offer.id, offer_id_1);
			assert.strictEqual(body.result.offer.message, 'second');
		});
	});

	describe('list edge cases', () => {
		test('empty inbox returns {offers: []}', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
			});
			const recipient = await test_app.create_account({username: 'list_empty_recipient'});
			const res = await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_LIST_METHOD,
				params: {},
			});
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual((await res.json()).result, {offers: []});
		});

		test('list orders by expires_at asc', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const grantor_b = await test_app.create_account({
				username: 'list_order_grantor_b',
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'list_order_recipient'});
			// Insert two offers directly with controlled expires_at so ordering is deterministic.
			const db = get_db();
			const later = await db.query<{id: string}>(
				`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
				 VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')
				 RETURNING id`,
				[test_app.backend.actor.id, recipient.account.id, ROLE_ADMIN],
			);
			const sooner = await db.query<{id: string}>(
				`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
				 VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')
				 RETURNING id`,
				[grantor_b.actor.id, recipient.account.id, ROLE_ADMIN],
			);
			const res = await send_rpc(test_app.app, {
				headers: recipient.create_session_headers(),
				method: PERMIT_OFFER_LIST_METHOD,
				params: {},
			});
			const offers = (await res.json()).result.offers as Array<{id: string}>;
			assert.deepStrictEqual(
				offers.map((o) => o.id),
				[sooner[0]?.id, later[0]?.id],
			);
		});
	});

	describe('permit_revoke', () => {
		test('admin revokes a permit and gets {ok, revoked}', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'revoke_target_basic'});
			const db = get_db();
			const permit_rows = await db.query<{id: string}>(
				`INSERT INTO permit (actor_id, role, granted_by)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
			);
			const permit_id = permit_rows[0]!.id;

			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_REVOKE_METHOD,
				params: {actor_id: target.actor.id, permit_id},
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.deepStrictEqual(body.result, {ok: true, revoked: true});

			const after = await db.query<{revoked_at: string | null}>(
				`SELECT revoked_at FROM permit WHERE id = $1`,
				[permit_id],
			);
			assert.ok(after[0]?.revoked_at, 'permit should be revoked');
		});

		test('non-admin caller forbidden with insufficient_permissions', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const caller = await test_app.create_account({username: 'revoke_non_admin'});
			const target = await test_app.create_account({username: 'revoke_target_nonadmin'});
			const db = get_db();
			const permit_rows = await db.query<{id: string}>(
				`INSERT INTO permit (actor_id, role, granted_by)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
			);

			const res = await send_rpc(test_app.app, {
				headers: caller.create_session_headers(),
				method: PERMIT_REVOKE_METHOD,
				params: {actor_id: target.actor.id, permit_id: permit_rows[0]!.id},
			});
			assert.strictEqual(res.status, 403);
			const body = await res.json();
			assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.strictEqual(body.error.data?.reason, ERROR_INSUFFICIENT_PERMISSIONS);

			const after = await db.query<{revoked_at: string | null}>(
				`SELECT revoked_at FROM permit WHERE id = $1`,
				[permit_rows[0]!.id],
			);
			assert.strictEqual(after[0]?.revoked_at, null);
		});

		test('cross-actor revoke returns permit_not_found (IDOR guard)', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'revoke_idor_target'});
			const other = await test_app.create_account({username: 'revoke_idor_other'});
			const db = get_db();
			const permit_rows = await db.query<{id: string}>(
				`INSERT INTO permit (actor_id, role, granted_by)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
			);
			// Pass the other account's actor_id with the real permit id —
			// the IDOR guard must treat this as not-found.
			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_REVOKE_METHOD,
				params: {actor_id: other.actor.id, permit_id: permit_rows[0]!.id},
			});
			assert.strictEqual(res.status, 404);
			const body = await res.json();
			assert.strictEqual(body.error.data?.reason, ERROR_PERMIT_NOT_FOUND);
		});

		test('keeper role rejected with role_not_web_grantable + failure audit', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				on_audit_event: (event) => {
					events.push(event);
				},
			});
			// bootstrap account holds the keeper permit.
			const keeper_rows = await get_db().query<{id: string; actor_id: string}>(
				`SELECT id, actor_id FROM permit WHERE role = $1 AND revoked_at IS NULL LIMIT 1`,
				[ROLE_KEEPER],
			);
			const keeper_permit = keeper_rows[0]!;

			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_REVOKE_METHOD,
				params: {actor_id: keeper_permit.actor_id, permit_id: keeper_permit.id},
			});
			assert.strictEqual(res.status, 403);
			const body = await res.json();
			assert.strictEqual(body.error.data?.reason, ERROR_ROLE_NOT_WEB_GRANTABLE);

			const failure = events.find(
				(e) => e.event_type === 'permit_revoke' && e.outcome === 'failure',
			);
			assert.ok(failure, 'expected a failure-outcome permit_revoke audit event');
			assert.strictEqual((failure.metadata as {role?: string}).role, ROLE_KEEPER);
		});

		test('nonexistent permit returns permit_not_found', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'revoke_missing_target'});
			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_REVOKE_METHOD,
				params: {actor_id: target.actor.id, permit_id: create_uuid()},
			});
			assert.strictEqual(res.status, 404);
			assert.strictEqual((await res.json()).error.data?.reason, ERROR_PERMIT_NOT_FOUND);
		});

		test('reason persists on permit.revoked_reason and audit metadata', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
				on_audit_event: (event) => {
					events.push(event);
				},
			});
			const target = await test_app.create_account({username: 'revoke_reason_target'});
			const db = get_db();
			const permit_rows = await db.query<{id: string}>(
				`INSERT INTO permit (actor_id, role, granted_by)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
			);
			const permit_id = permit_rows[0]!.id;

			await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_REVOKE_METHOD,
				params: {actor_id: target.actor.id, permit_id, reason: 'misuse'},
			});

			const after = await db.query<{revoked_reason: string | null}>(
				`SELECT revoked_reason FROM permit WHERE id = $1`,
				[permit_id],
			);
			assert.strictEqual(after[0]?.revoked_reason, 'misuse');

			const audit = events.find((e) => e.event_type === 'permit_revoke' && e.outcome !== 'failure');
			assert.ok(audit);
			assert.strictEqual((audit.metadata as {reason?: string}).reason, 'misuse');
		});

		test('supersedes pending sibling offers in the same transaction', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const grantor_b = await test_app.create_account({
				username: 'revoke_supersede_grantor_b',
				roles: [ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'revoke_supersede_target'});
			const db = get_db();
			const permit_rows = await db.query<{id: string}>(
				`INSERT INTO permit (actor_id, role, granted_by)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[target.actor.id, ROLE_ADMIN, test_app.backend.actor.id],
			);
			const permit_id = permit_rows[0]!.id;

			const offer_rows = await db.query<{id: string}>(
				`INSERT INTO permit_offer (from_actor_id, to_account_id, role, expires_at)
				 VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')
				 RETURNING id`,
				[grantor_b.actor.id, target.account.id, ROLE_ADMIN],
			);

			await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_REVOKE_METHOD,
				params: {actor_id: target.actor.id, permit_id},
			});

			const offer_after = await db.query<{superseded_at: string | null}>(
				`SELECT superseded_at FROM permit_offer WHERE id = $1`,
				[offer_rows[0]!.id],
			);
			assert.ok(offer_after[0]?.superseded_at);
		});
	});

	describe('custom authorize callback', () => {
		test('overrides default role-holding check', async () => {
			// Custom authorize allows anyone holding admin to offer any role.
			const custom_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
				...create_rpc_endpoint({
					path: RPC_PATH,
					actions: create_permit_offer_actions(ctx.deps, {
						authorize: async (auth) => auth.permits.some((p) => p.role === ROLE_ADMIN),
					}),
					log: ctx.deps.log,
				}),
			];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: custom_route_specs,
				db: get_db(),
				roles: [ROLE_ADMIN],
			});
			const recipient = await test_app.create_account({username: 'custom_auth_recipient'});
			// Admin is offering a role they don't hold — default policy would deny;
			// custom authorize allows because admin.permits contains ROLE_ADMIN.
			const res = await send_rpc(test_app.app, {
				headers: test_app.create_session_headers(),
				method: PERMIT_OFFER_CREATE_METHOD,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
			});
			assert.strictEqual(res.status, 200);
		});
	});
});
