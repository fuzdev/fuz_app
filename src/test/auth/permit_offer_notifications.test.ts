/**
 * Pure unit tests for the permit-offer notification builders and specs.
 *
 * Verifies method names round-trip through the spec, that each builder
 * produces a well-formed JSON-RPC notification envelope, and that
 * `PERMIT_OFFER_NOTIFICATION_SPECS` contains one entry per builder.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {
	PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD,
	PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	PERMIT_REVOKE_NOTIFICATION_METHOD,
	PERMIT_OFFER_NOTIFICATION_SPECS,
	build_permit_offer_received_notification,
	build_permit_offer_retracted_notification,
	build_permit_offer_accepted_notification,
	build_permit_offer_declined_notification,
	build_permit_offer_supersede_notification,
	build_permit_revoke_notification,
	permit_offer_received_notification_spec,
	permit_offer_retracted_notification_spec,
	permit_offer_accepted_notification_spec,
	permit_offer_declined_notification_spec,
	permit_offer_supersede_notification_spec,
	permit_revoke_notification_spec,
} from '$lib/auth/permit_offer_notifications.js';
import {JSONRPC_VERSION} from '$lib/http/jsonrpc.js';
import {create_uuid, type Uuid} from '$lib/uuid.js';
import type {PermitOfferJson} from '$lib/auth/permit_offer_schema.js';

const fake_offer = (): PermitOfferJson => {
	const now = new Date().toISOString();
	return {
		id: create_uuid(),
		from_actor_id: create_uuid(),
		to_account_id: create_uuid(),
		role: 'admin' as PermitOfferJson['role'],
		scope_id: null,
		message: 'hi',
		created_at: now,
		expires_at: now,
		accepted_at: null,
		declined_at: null,
		decline_reason: null,
		retracted_at: null,
		superseded_at: null,
		resulting_permit_id: null,
	};
};

describe('permit offer notification builders', () => {
	test('received builder produces a jsonrpc notification with the received method', () => {
		const offer = fake_offer();
		const msg = build_permit_offer_received_notification({offer});
		assert.strictEqual(msg.jsonrpc, JSONRPC_VERSION);
		assert.strictEqual(msg.method, PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD);
		assert.deepStrictEqual(msg.params, {offer});
		assert.ok(!('id' in msg), 'notification must not carry an id');
	});

	test('retracted builder uses the retracted method', () => {
		const offer = fake_offer();
		const msg = build_permit_offer_retracted_notification({offer});
		assert.strictEqual(msg.method, PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD);
		assert.deepStrictEqual(msg.params, {offer});
	});

	test('accepted builder uses the accepted method', () => {
		const offer = fake_offer();
		const msg = build_permit_offer_accepted_notification({offer});
		assert.strictEqual(msg.method, PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD);
		assert.deepStrictEqual(msg.params, {offer});
	});

	test('declined builder wraps offer; reason travels on offer.decline_reason', () => {
		const offer = fake_offer();
		const msg = build_permit_offer_declined_notification({offer});
		assert.strictEqual(msg.method, PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD);
		assert.deepStrictEqual(msg.params, {offer});
	});

	test('supersede builder carries reason and cause_id', () => {
		const offer = fake_offer();
		const cause_id = create_uuid();
		const msg = build_permit_offer_supersede_notification({
			offer,
			reason: 'sibling_accepted',
			cause_id,
		});
		assert.strictEqual(msg.method, PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD);
		assert.deepStrictEqual(msg.params, {offer, reason: 'sibling_accepted', cause_id});
	});

	test('permit_revoke builder produces the flat payload shape', () => {
		const permit_id: Uuid = create_uuid();
		const msg = build_permit_revoke_notification({
			permit_id,
			role: 'admin',
			scope_id: null,
			reason: 'misconduct',
		});
		assert.strictEqual(msg.method, PERMIT_REVOKE_NOTIFICATION_METHOD);
		assert.deepStrictEqual(msg.params, {
			permit_id,
			role: 'admin',
			scope_id: null,
			reason: 'misconduct',
		});
	});
});

describe('notification spec surface', () => {
	test('every builder has a corresponding spec at the same method name', () => {
		const pairs: Array<{method: string; spec_method: string}> = [
			{
				method: PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
				spec_method: permit_offer_received_notification_spec.method,
			},
			{
				method: PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD,
				spec_method: permit_offer_retracted_notification_spec.method,
			},
			{
				method: PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
				spec_method: permit_offer_accepted_notification_spec.method,
			},
			{
				method: PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD,
				spec_method: permit_offer_declined_notification_spec.method,
			},
			{
				method: PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
				spec_method: permit_offer_supersede_notification_spec.method,
			},
			{
				method: PERMIT_REVOKE_NOTIFICATION_METHOD,
				spec_method: permit_revoke_notification_spec.method,
			},
		];
		for (const pair of pairs) {
			assert.strictEqual(pair.method, pair.spec_method);
		}
	});

	test('every spec is remote_notification with auth=null and side_effects=true', () => {
		for (const spec of [
			permit_offer_received_notification_spec,
			permit_offer_retracted_notification_spec,
			permit_offer_accepted_notification_spec,
			permit_offer_declined_notification_spec,
			permit_offer_supersede_notification_spec,
			permit_revoke_notification_spec,
		]) {
			assert.strictEqual(spec.kind, 'remote_notification');
			assert.strictEqual(spec.auth, null);
			assert.strictEqual(spec.side_effects, true);
		}
	});

	test('PERMIT_OFFER_NOTIFICATION_SPECS mirrors every builder', () => {
		const methods = PERMIT_OFFER_NOTIFICATION_SPECS.map((s) => s.method);
		assert.deepStrictEqual(methods, [
			PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
			PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD,
			PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
			PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD,
			PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
			PERMIT_REVOKE_NOTIFICATION_METHOD,
		]);
	});
});
