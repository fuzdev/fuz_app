/**
 * Tests for `notification_sender.ts` — the `RealtimeNotificationSender`
 * fan-out and `noop_notification_sender`.
 *
 * That the dispatchers put the backend's sender on every handler context is
 * covered in `actions/action_rpc.test.ts`, `actions/register_action_ws.test.ts`
 * and, through an assembled app, in
 * `server/create_app_server_ws_endpoints.dispatch.db.test.ts`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';
import {
	create_realtime_notification_sender,
	noop_notification_sender,
	type NotificationSender
} from '#lib/actions/notification_sender.ts';
import type { JsonrpcNotification } from '#lib/http/jsonrpc.ts';
import { create_jsonrpc_notification } from '#lib/http/jsonrpc_helpers.ts';

const ACCOUNT = create_uuid();
const MESSAGE = create_jsonrpc_notification('poked', { n: 1 });

/** A sender that records each send and answers `sockets` for it. */
const create_recording_sender = (
	sockets = 1
): {
	sender: NotificationSender;
	calls: Array<{ account_id: Uuid; message: JsonrpcNotification }>;
} => {
	const calls: Array<{ account_id: Uuid; message: JsonrpcNotification }> = [];
	return {
		sender: {
			send_to_account: (account_id, message) => {
				calls.push({ account_id, message });
				return sockets;
			}
		},
		calls
	};
};

/** A sender whose every send throws `error`. */
const create_throwing_sender = (error: unknown): NotificationSender => ({
	send_to_account: () => {
		throw error;
	}
});

describe('create_realtime_notification_sender', () => {
	test('a send reaches every member and returns the sum', () => {
		const fan_out = create_realtime_notification_sender();
		const a = create_recording_sender(2);
		const b = create_recording_sender(3);
		fan_out.add(a.sender);
		fan_out.add(b.sender);

		assert.strictEqual(fan_out.send_to_account(ACCOUNT, MESSAGE), 5);
		assert.deepStrictEqual(a.calls, [{ account_id: ACCOUNT, message: MESSAGE }]);
		assert.deepStrictEqual(b.calls, [{ account_id: ACCOUNT, message: MESSAGE }]);
	});

	test('an empty fan-out sends to no one', () => {
		// a server mounting no WebSocket endpoint
		assert.strictEqual(create_realtime_notification_sender().send_to_account(ACCOUNT, MESSAGE), 0);
	});

	test('a sender added twice is one member, reached once', () => {
		// two endpoints sharing one registry: a second reach would put every
		// notification on its sockets twice
		const fan_out = create_realtime_notification_sender();
		const shared = create_recording_sender();
		const remove_first = fan_out.add(shared.sender);
		const remove_second = fan_out.add(shared.sender);
		assert.strictEqual(fan_out.member_count(), 1, 'one member, however many additions');

		assert.strictEqual(fan_out.send_to_account(ACCOUNT, MESSAGE), 1);
		assert.strictEqual(shared.calls.length, 1, 'reached once, not once per addition');

		// one owner releasing it leaves the other's addition holding it
		remove_first();
		remove_first();
		assert.strictEqual(fan_out.member_count(), 1, 'the second addition still holds it');
		fan_out.send_to_account(ACCOUNT, MESSAGE);
		assert.strictEqual(shared.calls.length, 2);

		remove_second();
		assert.strictEqual(fan_out.member_count(), 0);
		assert.strictEqual(fan_out.send_to_account(ACCOUNT, MESSAGE), 0);
		assert.strictEqual(shared.calls.length, 2, 'a removed member is not reached');
	});

	test('add returns a remover that takes the member out, idempotently', () => {
		const fan_out = create_realtime_notification_sender();
		const a = create_recording_sender();
		const b = create_recording_sender();
		const remove_a = fan_out.add(a.sender);
		fan_out.add(b.sender);
		assert.strictEqual(fan_out.member_count(), 2);

		remove_a();
		assert.strictEqual(fan_out.member_count(), 1);
		assert.strictEqual(fan_out.send_to_account(ACCOUNT, MESSAGE), 1);
		assert.deepStrictEqual(a.calls, [], 'a removed member is not reached');
		assert.strictEqual(b.calls.length, 1);

		// a second call is a no-op — it does not release anyone else's addition
		remove_a();
		assert.strictEqual(fan_out.member_count(), 1);
	});

	test('a member that throws does not keep the notification from the others', () => {
		// one registry's failure must not keep the account's sockets on another
		// from hearing it
		const fan_out = create_realtime_notification_sender();
		const before = create_recording_sender();
		const after = create_recording_sender();
		const boom = new Error('registry send failed');
		fan_out.add(before.sender);
		fan_out.add(create_throwing_sender(boom));
		fan_out.add(after.sender);

		assert.throws(() => fan_out.send_to_account(ACCOUNT, MESSAGE), boom);
		assert.strictEqual(before.calls.length, 1);
		assert.strictEqual(after.calls.length, 1, 'the member after the throw ran');
	});

	test('the first error is the one thrown when several members fail', () => {
		const fan_out = create_realtime_notification_sender();
		const first = new Error('first');
		const recording = create_recording_sender();
		fan_out.add(create_throwing_sender(first));
		fan_out.add(create_throwing_sender(new Error('second')));
		fan_out.add(recording.sender);

		assert.throws(() => fan_out.send_to_account(ACCOUNT, MESSAGE), first);
		assert.strictEqual(recording.calls.length, 1);
	});

	test('a member that throws a falsy value still fails the send', () => {
		const fan_out = create_realtime_notification_sender();
		const recording = create_recording_sender();
		fan_out.add(create_throwing_sender(undefined));
		fan_out.add(recording.sender);

		let threw = false;
		try {
			fan_out.send_to_account(ACCOUNT, MESSAGE);
		} catch (error) {
			threw = true;
			assert.strictEqual(error, undefined);
		}
		assert.ok(threw);
		assert.strictEqual(recording.calls.length, 1);
	});
});

describe('noop_notification_sender', () => {
	test('sends to no one', () => {
		assert.strictEqual(noop_notification_sender.send_to_account(ACCOUNT, MESSAGE), 0);
	});
});
