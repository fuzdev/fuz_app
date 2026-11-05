/**
 * Pure unit tests for the role-grant-offer notification builders and specs.
 *
 * Verifies method names round-trip through the spec, that each builder
 * produces a well-formed JSON-RPC notification envelope, that
 * `role_grant_offer_notification_specs` and
 * `role_grant_offer_notification_actions` contain one entry per builder, and
 * that `create_validated_notification_sender` checks what it sends under DEV
 * alone.
 *
 * @module
 */

import { describe, test, assert, afterEach, vi } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	ROLE_GRANT_REVOKED_NOTIFICATION_METHOD,
	role_grant_offer_notification_specs,
	role_grant_offer_notification_actions,
	create_validated_notification_sender,
	type NotificationSender,
	build_role_grant_offer_received_notification,
	build_role_grant_offer_retracted_notification,
	build_role_grant_offer_accepted_notification,
	build_role_grant_offer_declined_notification,
	build_role_grant_offer_supersede_notification,
	build_role_grant_revoked_notification,
	role_grant_offer_received_notification_spec,
	role_grant_offer_retracted_notification_spec,
	role_grant_offer_accepted_notification_spec,
	role_grant_offer_declined_notification_spec,
	role_grant_offer_supersede_notification_spec,
	role_grant_revoked_notification_spec
} from '#lib/auth/role_grant_offer_notifications.ts';
import { JSONRPC_VERSION } from '#lib/http/jsonrpc.ts';
import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';
import type { RoleGrantOfferJson } from '#lib/auth/role_grant_offer_schema.ts';

const fake_offer = (): RoleGrantOfferJson => {
	const now = new Date().toISOString();
	return {
		id: create_uuid(),
		from_actor_id: create_uuid(),
		to_account_id: create_uuid(),
		to_actor_id: null,
		role: 'admin',
		scope_kind: null,
		scope_id: null,
		message: 'hi',
		created_at: now,
		expires_at: now,
		accepted_at: null,
		declined_at: null,
		decline_reason: null,
		retracted_at: null,
		superseded_at: null,
		resulting_role_grant_id: null
	};
};

describe('role_grant offer notification builders', () => {
	test('received builder produces a jsonrpc notification with the received method', () => {
		const offer = fake_offer();
		const msg = build_role_grant_offer_received_notification({ offer });
		assert.strictEqual(msg.jsonrpc, JSONRPC_VERSION);
		assert.strictEqual(msg.method, ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD);
		assert.deepStrictEqual(msg.params, { offer });
		assert.ok(!('id' in msg), 'notification must not carry an id');
	});

	test('retracted builder uses the retracted method', () => {
		const offer = fake_offer();
		const msg = build_role_grant_offer_retracted_notification({ offer });
		assert.strictEqual(msg.method, ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD);
		assert.deepStrictEqual(msg.params, { offer });
	});

	test('accepted builder uses the accepted method', () => {
		const offer = fake_offer();
		const msg = build_role_grant_offer_accepted_notification({ offer });
		assert.strictEqual(msg.method, ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD);
		assert.deepStrictEqual(msg.params, { offer });
	});

	test('declined builder wraps offer; reason travels on offer.decline_reason', () => {
		const offer = fake_offer();
		const msg = build_role_grant_offer_declined_notification({ offer });
		assert.strictEqual(msg.method, ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD);
		assert.deepStrictEqual(msg.params, { offer });
	});

	test('supersede builder carries reason and cause_id', () => {
		const offer = fake_offer();
		const cause_id = create_uuid();
		const msg = build_role_grant_offer_supersede_notification({
			offer,
			reason: 'sibling_accepted',
			cause_id
		});
		assert.strictEqual(msg.method, ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD);
		assert.deepStrictEqual(msg.params, { offer, reason: 'sibling_accepted', cause_id });
	});

	test('role_grant_revoked builder produces the flat payload shape', () => {
		const role_grant_id: Uuid = create_uuid();
		const msg = build_role_grant_revoked_notification({
			role_grant_id,
			role: 'admin',
			scope_kind: null,
			scope_id: null,
			reason: 'misconduct'
		});
		assert.strictEqual(msg.method, ROLE_GRANT_REVOKED_NOTIFICATION_METHOD);
		assert.strictEqual(ROLE_GRANT_REVOKED_NOTIFICATION_METHOD, 'role_grant_revoked');
		assert.deepStrictEqual(msg.params, {
			role_grant_id,
			role: 'admin',
			scope_kind: null,
			scope_id: null,
			reason: 'misconduct'
		});
	});
});

describe('notification spec surface', () => {
	test('every builder has a corresponding spec at the same method name', () => {
		const pairs: Array<{ method: string; spec_method: string }> = [
			{
				method: ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
				spec_method: role_grant_offer_received_notification_spec.method
			},
			{
				method: ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD,
				spec_method: role_grant_offer_retracted_notification_spec.method
			},
			{
				method: ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
				spec_method: role_grant_offer_accepted_notification_spec.method
			},
			{
				method: ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD,
				spec_method: role_grant_offer_declined_notification_spec.method
			},
			{
				method: ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
				spec_method: role_grant_offer_supersede_notification_spec.method
			},
			{
				method: ROLE_GRANT_REVOKED_NOTIFICATION_METHOD,
				spec_method: role_grant_revoked_notification_spec.method
			}
		];
		for (const pair of pairs) {
			assert.strictEqual(pair.method, pair.spec_method);
		}
	});

	test('every spec is remote_notification with auth=null and side_effects=true', () => {
		for (const spec of [
			role_grant_offer_received_notification_spec,
			role_grant_offer_retracted_notification_spec,
			role_grant_offer_accepted_notification_spec,
			role_grant_offer_declined_notification_spec,
			role_grant_offer_supersede_notification_spec,
			role_grant_revoked_notification_spec
		]) {
			assert.strictEqual(spec.kind, 'remote_notification');
			assert.strictEqual(spec.auth, null);
			assert.strictEqual(spec.side_effects, true);
		}
	});

	test('role_grant_offer_notification_specs mirrors every builder', () => {
		const methods = role_grant_offer_notification_specs.map((s) => s.method);
		assert.deepStrictEqual(methods, [
			ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
			ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD,
			ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
			ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD,
			ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
			ROLE_GRANT_REVOKED_NOTIFICATION_METHOD
		]);
	});
});

describe('role_grant_offer_notification_actions', () => {
	test('holds every spec, handler-less, in the order of the event specs', () => {
		assert.deepStrictEqual(
			role_grant_offer_notification_actions.map((a) => a.spec.method),
			role_grant_offer_notification_specs.map((s) => s.method)
		);
		for (const action of role_grant_offer_notification_actions) {
			assert.strictEqual(action.handler, undefined, action.spec.method);
			assert.strictEqual(action.spec.kind, 'remote_notification');
		}
	});
});

describe('create_validated_notification_sender', () => {
	afterEach(() => {
		vi.doUnmock('esm-env');
		vi.resetModules();
	});

	const create_capture = () => {
		const sent: Array<{ account_id: string; method: string; params: unknown }> = [];
		const errors: Array<Array<unknown>> = [];
		const sender: NotificationSender = {
			send_to_account: (account_id, message) => {
				sent.push({ account_id, method: message.method, params: message.params });
				return 1;
			}
		};
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args);
		};
		return { sent, errors, sender, log };
	};

	const account_id = create_uuid();

	test('under DEV logs a params mismatch and sends the notification unchanged', () => {
		const { sent, errors, sender, log } = create_capture();
		const validated = create_validated_notification_sender(sender, log);
		assert.notStrictEqual(validated, sender);
		const bad = build_role_grant_revoked_notification({
			role_grant_id: create_uuid(),
			role: 'admin',
			scope_kind: 'GLOBAL',
			scope_id: null,
			reason: null
		});
		assert.strictEqual(validated.send_to_account(account_id, bad), 1);
		assert.deepStrictEqual(sent, [{ account_id, method: bad.method, params: bad.params }]);
		assert.strictEqual(errors.length, 1);
		assert.strictEqual(
			errors[0]![0],
			`notification params schema mismatch: ${ROLE_GRANT_REVOKED_NOTIFICATION_METHOD}`
		);
	});

	test('under DEV passes a matching payload and an unknown method without a log', () => {
		const { sent, errors, sender, log } = create_capture();
		const validated = create_validated_notification_sender(sender, log);
		validated.send_to_account(
			account_id,
			build_role_grant_offer_received_notification({ offer: fake_offer() })
		);
		validated.send_to_account(account_id, {
			jsonrpc: JSONRPC_VERSION,
			method: 'something_else',
			params: { anything: true }
		});
		assert.strictEqual(sent.length, 2);
		assert.deepStrictEqual(errors, []);
	});

	test('in production returns the sender as it is', async () => {
		vi.resetModules();
		vi.doMock('esm-env', () => ({ DEV: false, BROWSER: false }));
		const module = await import('#lib/auth/role_grant_offer_notifications.ts');
		const { sender, log, sent, errors } = create_capture();
		const validated = module.create_validated_notification_sender(sender, log);
		assert.strictEqual(validated, sender);
		validated.send_to_account(
			account_id,
			module.build_role_grant_revoked_notification({
				role_grant_id: create_uuid(),
				role: 'admin',
				scope_kind: 'GLOBAL',
				scope_id: null,
				reason: null
			})
		);
		assert.strictEqual(sent.length, 1);
		assert.deepStrictEqual(errors, []);
	});
});
