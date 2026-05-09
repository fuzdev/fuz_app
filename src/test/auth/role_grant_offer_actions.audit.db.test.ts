/**
 * Cross-cutting audit emission coverage for the offer lifecycle —
 * success-shape events plus the three failure-outcome `role_grant_offer_create`
 * paths (admin-grant-path denial, `authorize` denial, self-target).
 *
 * The success paths live alongside each lifecycle method's tests in
 * sibling files (`create`, `accept`, `decline`, `retract`); this file
 * asserts the audit record is written with the right metadata shape.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_test_app} from '$lib/testing/app_server.js';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import {
	role_grant_offer_create_action_spec,
	role_grant_offer_accept_action_spec,
	role_grant_offer_decline_action_spec,
	role_grant_offer_retract_action_spec,
	ERROR_ROLE_GRANT_OFFER_SELF_TARGET,
	ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
	ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE,
} from '$lib/auth/role_grant_offer_action_specs.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {
	RPC_PATH,
	create_route_specs,
	describe_db,
	session_options,
} from './role_grant_offer_test_helpers.js';

describe_db('role_grant_offer_actions.audit', (get_db) => {
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

		test('create emits role_grant_offer_create with metadata', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'audit_create_recipient'});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok);
			const offer_id = res.result.offer.id;
			const match = events.find(
				(e) =>
					e.event_type === 'role_grant_offer_create' &&
					(e.metadata as {offer_id?: string}).offer_id === offer_id,
			);
			assert.ok(match, 'expected role_grant_offer_create event');
			assert.notStrictEqual(match.outcome, 'failure');
			assert.strictEqual(
				(match.metadata as {to_account_id?: string}).to_account_id,
				recipient.account.id,
			);
			// `role_grant_offer_create` is account-grain — the offer routes to
			// the account inbox; any actor on the account may accept.
			// `target_account_id` is set; `target_actor_id` stays null
			// (per audit_log_schema rule).
			assert.strictEqual(match.target_account_id, recipient.account.id);
			assert.strictEqual(match.target_actor_id, null);
		});

		test('non-admin-grant-path role emits failure-outcome create event', async () => {
			const events: Array<AuditLogEvent> = [];
			// bootstrap account has keeper role already but ROLE_KEEPER's
			// grant_paths is `['bootstrap']` (no `'admin'`); offering
			// keeper triggers the admin-grant-path gate.
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'audit_webgrant_recipient'});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_KEEPER},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE,
			);
			const failure = events.find(
				(e) => e.event_type === 'role_grant_offer_create' && e.outcome === 'failure',
			);
			assert.ok(failure, 'expected a failure-outcome role_grant_offer_create event');
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
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: caller.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 403);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
			);
			const failure = events.find(
				(e) =>
					e.event_type === 'role_grant_offer_create' &&
					e.outcome === 'failure' &&
					e.actor_id === caller.actor.id,
			);
			assert.ok(failure, 'expected a failure-outcome role_grant_offer_create event');
		});

		test('self-target emits failure-outcome create event', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: test_app.backend.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(!res.ok);
			assert.strictEqual(res.status, 400);
			assert.strictEqual(
				(res.error.data as {reason: string} | undefined)?.reason,
				ERROR_ROLE_GRANT_OFFER_SELF_TARGET,
			);
			const failure = events.find(
				(e) =>
					e.event_type === 'role_grant_offer_create' &&
					e.outcome === 'failure' &&
					e.target_account_id === test_app.backend.account.id,
			);
			assert.ok(failure, 'expected a failure-outcome role_grant_offer_create event');
			assert.strictEqual((failure.metadata as {role?: string}).role, ROLE_ADMIN);
			assert.strictEqual(
				(failure.metadata as {offer_id?: string}).offer_id,
				undefined,
				'no offer row was written, so metadata must not carry offer_id',
			);
		});

		test('accept emits role_grant_offer_accept + role_grant_create post-commit', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'audit_accept_recipient'});
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			const offer_id = create_res.result.offer.id;
			events.length = 0;
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_accept_action_spec,
				params: {offer_id},
				headers: recipient.create_session_headers(),
			});
			const types = events.map((e) => e.event_type);
			assert.ok(
				types.includes('role_grant_offer_accept'),
				`missing role_grant_offer_accept in ${types.join(',')}`,
			);
			assert.ok(
				types.includes('role_grant_create'),
				`missing role_grant_create in ${types.join(',')}`,
			);
		});

		test('decline emits role_grant_offer_decline', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'audit_decline_recipient'});
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			const offer_id = create_res.result.offer.id;
			events.length = 0;
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_decline_action_spec,
				params: {offer_id, reason: 'nah'},
				headers: recipient.create_session_headers(),
			});
			const match = events.find((e) => e.event_type === 'role_grant_offer_decline');
			assert.ok(match, 'expected role_grant_offer_decline event');
			assert.strictEqual((match.metadata as {offer_id?: string}).offer_id, offer_id);
			assert.strictEqual((match.metadata as {reason?: string}).reason, 'nah');
			// `role_grant_offer_decline` carries the original grantor in BOTH
			// target columns — `target_actor_id` is the grantor actor and
			// `target_account_id` is the grantor's account (joined into
			// the decline RETURNING). The "both populated → same account"
			// invariant holds (grantor's actor↔account binding is 1:1).
			assert.strictEqual(match.target_actor_id, test_app.backend.actor.id);
			assert.strictEqual(match.target_account_id, test_app.backend.account.id);
		});

		test('retract emits role_grant_offer_retract', async () => {
			const events: Array<AuditLogEvent> = [];
			const test_app = await build_app_with_audit(events);
			const recipient = await test_app.create_account({username: 'audit_retract_recipient'});
			const create_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_create_action_spec,
				params: {to_account_id: recipient.account.id, role: ROLE_ADMIN},
				headers: test_app.create_session_headers(),
			});
			assert.ok(create_res.ok);
			const offer_id = create_res.result.offer.id;
			events.length = 0;
			await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_offer_retract_action_spec,
				params: {offer_id},
				headers: test_app.create_session_headers(),
			});
			const match = events.find((e) => e.event_type === 'role_grant_offer_retract');
			assert.ok(match, 'expected role_grant_offer_retract event');
			assert.strictEqual((match.metadata as {offer_id?: string}).offer_id, offer_id);
			// `role_grant_offer_retract` carries the recipient account as
			// `target_account_id` per the audit_log_schema rule.
			// `target_actor_id` stays null (no actor binding yet).
			assert.strictEqual(match.target_account_id, recipient.account.id);
			assert.strictEqual(match.target_actor_id, null);
		});
	});
});
