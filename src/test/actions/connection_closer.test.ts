/**
 * Tests for `connection_closer.ts` — the `RealtimeCloser` fan-out and
 * `queue_connection_close`.
 *
 * The revocation sites that hold the closer are covered against a database in
 * `auth/connection_closer.db.test.ts`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';

import {
	close_connections,
	create_realtime_closer,
	queue_connection_close,
	type ConnectionCloser,
	type ConnectionCloseTarget
} from '$lib/actions/connection_closer.ts';
import { flush_post_commit_effects } from '$lib/http/pending_effects.ts';
import {
	create_recording_closer,
	type RecordedClose
} from '$lib/testing/connection_closer_helpers.ts';

const ACCOUNT = create_uuid();

/** One target per `ConnectionCloser` method, and the call each one records. */
const targets: Array<{ target: ConnectionCloseTarget } & RecordedClose> = [
	{
		target: { kind: 'session', session_token_hash: 'session_hash' },
		method: 'session',
		id: 'session_hash'
	},
	{ target: { kind: 'token', api_token_id: 'token_id' }, method: 'token', id: 'token_id' },
	{ target: { kind: 'account', account_id: ACCOUNT }, method: 'account', id: ACCOUNT }
];

/** A closer whose every method throws `error`. */
const create_throwing_closer = (error: unknown): ConnectionCloser => {
	const fail = (): number => {
		throw error;
	};
	return {
		close_sockets_for_session: fail,
		close_sockets_for_token: fail,
		close_sockets_for_account: fail,
		close_all_sockets: fail
	};
};

describe('create_realtime_closer', () => {
	test('each close fans out to every member and returns the sum', () => {
		const closer = create_realtime_closer();
		const a = create_recording_closer();
		const b = create_recording_closer();
		closer.add(a.closer);
		closer.add(b.closer);
		// one member per reference, however many additions
		closer.add(a.closer);

		for (const { target, method, id } of targets) {
			assert.strictEqual(close_connections(closer, target), 2);
			assert.deepStrictEqual(a.calls.at(-1), { method, id });
			assert.deepStrictEqual(b.calls.at(-1), { method, id });
		}
		assert.strictEqual(a.calls.length, targets.length);
		assert.strictEqual(b.calls.length, targets.length);
	});

	for (const { target, method, id } of targets) {
		test(`a member that throws does not stop the ${method} fan-out`, () => {
			// A throwing member ahead of the others would otherwise leave their
			// connections open on a revoked credential, silently.
			const closer = create_realtime_closer();
			const before = create_recording_closer();
			const after = create_recording_closer();
			const boom = new Error('transport close failed');
			closer.add(before.closer);
			closer.add(create_throwing_closer(boom));
			closer.add(after.closer);

			assert.throws(() => close_connections(closer, target), boom);
			assert.deepStrictEqual(before.calls, [{ method, id }]);
			assert.deepStrictEqual(after.calls, [{ method, id }], 'the member after the throw ran');
		});
	}

	test('add returns a remover that takes the member out of the fan-out, idempotently', () => {
		const closer = create_realtime_closer();
		const a = create_recording_closer();
		const b = create_recording_closer();
		const remove_a = closer.add(a.closer);
		closer.add(b.closer);
		assert.strictEqual(closer.member_count(), 2);

		remove_a();
		assert.strictEqual(closer.member_count(), 1);
		assert.strictEqual(closer.close_all_sockets(), 1);
		assert.deepStrictEqual(a.calls, [], 'a removed member is not reached');
		assert.deepStrictEqual(b.calls, [{ method: 'all', id: null }]);

		// a second call is a no-op — it does not release anyone else's addition
		remove_a();
		assert.strictEqual(closer.member_count(), 1);
	});

	test('a closer added twice stays a member until both additions are removed', () => {
		// two endpoints sharing one transport: one owner releasing it must not
		// leave the other's sockets out of the revocation fan-out
		const closer = create_realtime_closer();
		const shared = create_recording_closer();
		const remove_first = closer.add(shared.closer);
		const remove_second = closer.add(shared.closer);
		assert.strictEqual(closer.member_count(), 1, 'one member, however many additions');

		remove_first();
		remove_first();
		assert.strictEqual(closer.member_count(), 1, 'the second addition still holds it');
		assert.strictEqual(closer.close_all_sockets(), 1);
		assert.strictEqual(shared.calls.length, 1, 'reached once, not once per addition');

		remove_second();
		assert.strictEqual(closer.member_count(), 0);
		assert.strictEqual(closer.close_all_sockets(), 0);
	});

	test('close_all_sockets fans out to every member and returns the sum', () => {
		const closer = create_realtime_closer();
		const a = create_recording_closer();
		const b = create_recording_closer();
		closer.add(a.closer);
		closer.add(b.closer);

		assert.strictEqual(closer.close_all_sockets(), 2);
		assert.deepStrictEqual(a.calls, [{ method: 'all', id: null }]);
		assert.deepStrictEqual(b.calls, [{ method: 'all', id: null }]);
	});

	test('a member that throws does not stop the close_all_sockets fan-out', () => {
		// at shutdown, a broken transport must not leave another's connections open
		const closer = create_realtime_closer();
		const before = create_recording_closer();
		const after = create_recording_closer();
		const boom = new Error('transport close failed');
		closer.add(before.closer);
		closer.add(create_throwing_closer(boom));
		closer.add(after.closer);

		assert.throws(() => closer.close_all_sockets(), boom);
		assert.deepStrictEqual(before.calls, [{ method: 'all', id: null }]);
		assert.deepStrictEqual(after.calls, [{ method: 'all', id: null }]);
	});

	test('the first error is the one thrown when several members fail', () => {
		const closer = create_realtime_closer();
		const first = new Error('first');
		const recording = create_recording_closer();
		closer.add(create_throwing_closer(first));
		closer.add(create_throwing_closer(new Error('second')));
		closer.add(recording.closer);

		assert.throws(() => closer.close_sockets_for_account(ACCOUNT), first);
		assert.deepStrictEqual(recording.calls, [{ method: 'account', id: ACCOUNT }]);
	});

	test('a member that throws a falsy value still fails the close', () => {
		const closer = create_realtime_closer();
		const recording = create_recording_closer();
		closer.add(create_throwing_closer(undefined));
		closer.add(recording.closer);

		let threw = false;
		try {
			closer.close_sockets_for_account(ACCOUNT);
		} catch (error) {
			threw = true;
			assert.strictEqual(error, undefined);
		}
		assert.ok(threw);
		assert.strictEqual(recording.calls.length, 1);
	});
});

describe('queue_connection_close', () => {
	test('closes nothing until the post-commit queue is flushed', async () => {
		const { closer, calls } = create_recording_closer();
		const ctx = { post_commit_effects: [] };

		queue_connection_close(ctx, closer, { kind: 'account', account_id: ACCOUNT });
		assert.deepStrictEqual(calls, []);

		await flush_post_commit_effects(ctx.post_commit_effects, new Logger('test', { level: 'off' }));
		assert.deepStrictEqual(calls, [{ method: 'account', id: ACCOUNT }]);
	});

	test('a failing member is logged by the flush, and the rest still close', async () => {
		const closer = create_realtime_closer();
		const recording = create_recording_closer();
		const boom = new Error('transport close failed');
		closer.add(create_throwing_closer(boom));
		closer.add(recording.closer);
		const ctx = { post_commit_effects: [] };
		const errors: Array<Array<unknown>> = [];
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args);
		};

		queue_connection_close(ctx, closer, { kind: 'account', account_id: ACCOUNT });
		await flush_post_commit_effects(ctx.post_commit_effects, log);

		assert.deepStrictEqual(recording.calls, [{ method: 'account', id: ACCOUNT }]);
		assert.deepStrictEqual(errors, [['post-commit side effect failed:', boom]]);
	});
});
