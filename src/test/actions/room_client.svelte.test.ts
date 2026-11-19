/**
 * Tests for `RoomClient` and `RoomState` — joining, watching, the `seq`
 * buffer and drop, messages held for a join in flight, member events,
 * listeners that throw, state sets, sends, the one-request-at-a-time runner,
 * and dispose. Reconnects and lost seats are in
 * `room_client.svelte.reconnect.test.ts`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { create_uuid } from '#lib/primitive_schemas.ts';
import {
	ERROR_ROOM_FULL,
	ERROR_ROOM_JOIN_SUPERSEDED,
	ERROR_ROOM_NOT_JOINED,
	type MemberId
} from '#lib/actions/room_action_specs.ts';
import {
	RoomClient,
	is_room_notification_method,
	type RoomListener
} from '#lib/actions/room_client.svelte.ts';

import {
	create_fake_room_rpc,
	join_output,
	member,
	occupancy,
	refusal
} from './room_client_fakes.ts';
import { settle } from '../fake_timers.ts';

const ROOM = 'room_1';

/** A client, its fake rpc, and one room with a recording listener. */
const setup = () => {
	const fake = create_fake_room_rpc();
	const client = new RoomClient(fake.rpc);
	client.sync_connection();
	const room = client.room(ROOM);
	const heard: Array<string> = [];
	const listener: RoomListener = {
		seated: (seat) => heard.push(`seated ${seat.member_id}`),
		unseated: (_seat, reason) => heard.push(`unseated ${reason}`),
		member_joined: (m) => heard.push(`joined ${m.member_id}`),
		member_left: (id, reason) => heard.push(`left ${id} ${reason}`),
		member_state: (m) => heard.push(`state ${m.member_id} ${m.state}`),
		message: (m) => heard.push(`message ${m.payload}`)
	};
	room.add_listener(listener);
	return { ...fake, client, room, heard };
};

/** Join `ROOM` as a fresh member beside `others`, answered at `seq`. */
const join = async (ctx: ReturnType<typeof setup>, seq = 5, others = [member()]) => {
	const me = member();
	const joined = ctx.room.join();
	await settle();
	ctx.take('room_join').resolve(join_output(ROOM, me.member_id, seq, [...others, me]));
	const result = await joined;
	assert.ok(result.ok);
	return { me, others };
};

const joined_params = (seq: number, m = member()) => ({ room_id: ROOM, seq, member: m });
const left_params = (seq: number, member_id: MemberId) => ({
	room_id: ROOM,
	seq,
	member_id,
	reason: 'left'
});
const message_params = (seq: number, from: MemberId, to: MemberId | null, payload: string) => ({
	room_id: ROOM,
	seq,
	from,
	to,
	payload
});

describe('RoomState.join', () => {
	test('a join takes a seat and holds the room as of its answer', async () => {
		const ctx = setup();
		assert.strictEqual(ctx.room.seat_status, 'idle');
		const joined = ctx.room.join({ state: 'muted' });
		assert.strictEqual(ctx.room.seat_status, 'joining');
		await settle();
		const call = ctx.take('room_join');
		assert.strictEqual(call.input.room_id, ROOM);
		assert.strictEqual(call.input.state, 'muted');
		assert.isUndefined(call.input.rejoin_of);
		const me = member();
		const other = member();
		call.resolve(join_output(ROOM, me.member_id, 3, [other, me]));
		const result = await joined;
		assert.ok(result.ok);
		assert.strictEqual(result.value.member_id, me.member_id);
		assert.strictEqual(ctx.room.seat?.member_id, me.member_id);
		assert.strictEqual(ctx.room.seat_status, 'joined');
		assert.deepEqual(ctx.room.members, [other, me]);
		assert.deepEqual(ctx.heard, [`seated ${me.member_id}`]);
	});

	test('a join while seated answers the seat without a request', async () => {
		const ctx = setup();
		await join(ctx);
		const again = await ctx.room.join();
		assert.ok(again.ok);
		await settle();
		assert.strictEqual(ctx.calls.length, 0);
	});

	test('a refused join records the error and stops wanting the seat', async () => {
		const ctx = setup();
		const joined = ctx.room.join();
		await settle();
		ctx.take('room_join').resolve(refusal(ERROR_ROOM_FULL));
		const result = await joined;
		assert.ok(!result.ok);
		assert.strictEqual((result.error.data as { reason: string }).reason, ERROR_ROOM_FULL);
		assert.strictEqual(ctx.room.seat_status, 'idle');
		assert.strictEqual(ctx.room.error, result.error);
		await settle();
		assert.strictEqual(ctx.calls.length, 0);
	});

	test('the acting actor rides every verb', async () => {
		const fake = create_fake_room_rpc();
		const acting = create_uuid();
		const client = new RoomClient(fake.rpc, { acting });
		void client.room(ROOM).join();
		await settle();
		assert.strictEqual(fake.take('room_join').input.acting, acting);
	});
});

describe('seq', () => {
	test('events before the join answer are buffered, then replayed past its seq', async () => {
		const ctx = setup();
		const joined = ctx.room.join();
		await settle();
		const me = member();
		const early = member(); // joined at seq 4, already in the answer
		const late = member(); // joined at seq 6, after the answer
		ctx.client.receive('room_member_joined', joined_params(4, early));
		ctx.client.receive('room_member_joined', joined_params(6, late));
		ctx.client.receive('room_message', message_params(7, late.member_id, me.member_id, 'hi'));
		assert.deepEqual(ctx.heard, []);
		assert.deepEqual(ctx.room.members, []);

		ctx.take('room_join').resolve(join_output(ROOM, me.member_id, 5, [early, me]));
		await joined;
		assert.deepEqual(ctx.room.members, [early, me, late]);
		assert.deepEqual(ctx.heard, [
			`seated ${me.member_id}`,
			`joined ${late.member_id}`,
			'message hi'
		]);
	});

	test('a live room drops events at or below its last seq', async () => {
		const ctx = setup();
		const { others } = await join(ctx, 5);
		const stale = member();
		ctx.client.receive('room_member_joined', joined_params(5, stale));
		ctx.client.receive('room_member_joined', joined_params(2, stale));
		assert.isFalse(ctx.room.members.some((m) => m.member_id === stale.member_id));

		ctx.client.receive('room_member_left', left_params(6, others[0]!.member_id));
		assert.isFalse(ctx.room.members.some((m) => m.member_id === others[0]!.member_id));
		// the same seq again is a duplicate
		const fresh = member();
		ctx.client.receive('room_member_joined', joined_params(6, fresh));
		assert.isFalse(ctx.room.members.some((m) => m.member_id === fresh.member_id));
		ctx.client.receive('room_member_joined', joined_params(7, fresh));
		assert.isTrue(ctx.room.members.some((m) => m.member_id === fresh.member_id));
	});

	test('events for a room with nothing live or in flight are dropped', () => {
		const ctx = setup();
		ctx.client.receive('room_member_joined', joined_params(1));
		ctx.client.receive('room_member_joined', { ...joined_params(1), room_id: 'elsewhere' });
		assert.deepEqual(ctx.room.members, []);
		assert.deepEqual(ctx.heard, []);
		assert.isFalse(ctx.client.rooms.has('elsewhere'));
	});

	test('a join answered behind a live watch keeps the live members', async () => {
		const ctx = setup();
		const a = member();
		void ctx.room.watch();
		await settle();
		ctx.take('room_watch').resolve(occupancy(ROOM, 10, [a]));
		await settle();
		assert.isTrue(ctx.room.watching);

		const joined = ctx.room.join();
		await settle();
		const me = member();
		const b = member();
		// the watch hears the caller's own join (12) and a later one (13) before the answer
		ctx.client.receive('room_member_joined', joined_params(12, me));
		ctx.client.receive('room_member_joined', joined_params(13, b));
		ctx.take('room_join').resolve(join_output(ROOM, me.member_id, 12, [a, me]));
		await joined;
		assert.deepEqual(ctx.room.members, [a, me, b]);
	});
});

describe('messages while watching', () => {
	test('a message for the seat being left is not held for the next one', async () => {
		const ctx = setup();
		const a = member();
		void ctx.room.watch();
		await settle();
		ctx.take('room_watch').resolve(occupancy(ROOM, 1, [a]));
		await settle();
		const { me } = await join(ctx, 2, [a]);
		void ctx.room.leave();
		const rejoined = ctx.room.join();
		await settle();
		const leave = ctx.take('room_leave');
		// the server still seats the old member until the leave lands
		ctx.client.receive('room_message', message_params(3, a.member_id, me.member_id, 'old'));
		leave.resolve({ ok: true, value: { left: true } });
		await settle();
		const again = member();
		ctx.take('room_join').resolve(join_output(ROOM, again.member_id, 4, [a, again]));
		await rejoined;
		assert.notInclude(ctx.heard, 'message old');
	});

	test('a message on a live watch while the join is in flight is held for the seat', async () => {
		const ctx = setup();
		const a = member();
		void ctx.room.watch();
		await settle();
		ctx.take('room_watch').resolve(occupancy(ROOM, 10, [a]));
		await settle();

		const joined = ctx.room.join();
		await settle();
		const me = member();
		const b = member();
		ctx.client.receive('room_member_joined', joined_params(11, me));
		ctx.client.receive('room_message', message_params(12, a.member_id, me.member_id, 'first'));
		ctx.client.receive('room_member_joined', joined_params(13, b));
		ctx.client.receive('room_message', message_params(14, a.member_id, null, 'second'));
		assert.deepEqual(ctx.heard, [`joined ${me.member_id}`, `joined ${b.member_id}`]);

		ctx.take('room_join').resolve(join_output(ROOM, me.member_id, 11, [a, me]));
		await joined;
		assert.deepEqual(ctx.heard, [
			`joined ${me.member_id}`,
			`joined ${b.member_id}`,
			`seated ${me.member_id}`,
			'message first',
			'message second'
		]);
		// once seated, messages go straight through
		ctx.client.receive('room_message', message_params(15, a.member_id, me.member_id, 'third'));
		assert.strictEqual(ctx.heard.at(-1), 'message third');
	});

	test('messages held for a refused join are dropped', async () => {
		const ctx = setup();
		const a = member();
		void ctx.room.watch();
		await settle();
		ctx.take('room_watch').resolve(occupancy(ROOM, 10, [a]));
		await settle();
		const joined = ctx.room.join();
		await settle();
		ctx.client.receive('room_message', message_params(11, a.member_id, null, 'held'));
		ctx.take('room_join').resolve(refusal(ERROR_ROOM_FULL));
		await joined;
		const retry = ctx.room.join();
		await settle();
		const me = member();
		ctx.take('room_join').resolve(join_output(ROOM, me.member_id, 12, [a, me]));
		await retry;
		assert.deepEqual(ctx.heard, [`seated ${me.member_id}`]);
	});

	test('without a join in flight, a watch hears no messages', async () => {
		const ctx = setup();
		void ctx.room.watch();
		await settle();
		ctx.take('room_watch').resolve(occupancy(ROOM, 1, []));
		await settle();
		ctx.client.receive('room_message', message_params(2, member().member_id, null, 'p'));
		assert.deepEqual(ctx.heard, []);
	});
});

describe('listeners that throw', () => {
	test('a seated listener that throws: the join resolves, the buffer replays, others hear', async () => {
		const ctx = setup();
		const thrower: Array<string> = [];
		ctx.room.add_listener({
			seated: () => {
				thrower.push('seated');
				throw new Error('bad ice servers');
			},
			member_joined: () => {
				throw new Error('also bad');
			}
		});
		const joined = ctx.room.join();
		await settle();
		const me = member();
		const late = member();
		ctx.client.receive('room_member_joined', joined_params(6, late));
		ctx.take('room_join').resolve(join_output(ROOM, me.member_id, 5, [me]));
		const result = await joined;
		assert.ok(result.ok);
		assert.deepEqual(thrower, ['seated']);
		assert.deepEqual(ctx.heard, [`seated ${me.member_id}`, `joined ${late.member_id}`]);
		assert.deepEqual(ctx.room.members, [me, late]);

		// the runner isn't wedged: a state set still goes out
		void ctx.room.set_state('x');
		await settle();
		assert.strictEqual(ctx.take('room_state_set').input.state, 'x');
	});

	test('an unseated listener that throws still ends the seat for the others', async () => {
		const ctx = setup();
		ctx.room.add_listener({
			unseated: () => {
				throw new Error('teardown failed');
			}
		});
		await join(ctx);
		const left = ctx.room.leave();
		assert.isNull(ctx.room.seat);
		assert.strictEqual(ctx.heard.at(-1), 'unseated left');
		await settle();
		ctx.take('room_leave').resolve({ ok: true, value: { left: true } });
		await left;
	});
});

describe('member events', () => {
	test('state changes update the member, and messages reach the listener', async () => {
		const ctx = setup();
		const { me, others } = await join(ctx, 5);
		const [other] = others;
		ctx.heard.length = 0;
		ctx.client.receive('room_member_state', {
			room_id: ROOM,
			seq: 6,
			member_id: other!.member_id,
			state: 'speaking'
		});
		assert.strictEqual(
			ctx.room.members.find((m) => m.member_id === other!.member_id)?.state,
			'speaking'
		);
		ctx.client.receive('room_message', message_params(7, other!.member_id, me.member_id, 'p'));
		assert.deepEqual(ctx.heard, [`state ${other!.member_id} speaking`, 'message p']);
	});

	test('a malformed notification is dropped; other methods are not the client’s', () => {
		const ctx = setup();
		assert.isTrue(ctx.client.receive('room_member_joined', { room_id: ROOM }));
		assert.isFalse(ctx.client.receive('account_verify', {}));
		assert.isTrue(is_room_notification_method('room_seat_lost'));
		assert.isFalse(is_room_notification_method('room_join'));
	});
});

describe('RoomState.watch', () => {
	test('a watch holds the occupancy and its events; unwatch drops it', async () => {
		const ctx = setup();
		const a = member();
		const watched = ctx.room.watch();
		await settle();
		ctx.take('room_watch').resolve(occupancy(ROOM, 2, [a]));
		await watched;
		assert.isTrue(ctx.room.watching);
		assert.deepEqual(ctx.room.members, [a]);
		const b = member();
		ctx.client.receive('room_member_joined', joined_params(3, b));
		assert.deepEqual(ctx.room.members, [a, b]);

		const unwatched = ctx.room.unwatch();
		assert.isFalse(ctx.room.watching);
		assert.deepEqual(ctx.room.members, []);
		await settle();
		ctx.take('room_unwatch').resolve({ ok: true, value: { unwatched: true } });
		await unwatched;
	});

	test('the server ending a watch ends it here, not taken again', async () => {
		const ctx = setup();
		void ctx.room.watch();
		await settle();
		ctx.take('room_watch').resolve(occupancy(ROOM, 2, [member()]));
		await settle();
		ctx.client.receive('room_watch_ended', { room_id: ROOM, reason: 'evicted' });
		assert.isFalse(ctx.room.watching);
		assert.isFalse(ctx.room.want_watch);
		assert.strictEqual(ctx.room.watch_ended, 'evicted');
		assert.deepEqual(ctx.room.members, []);
		ctx.set_connection({});
		ctx.client.sync_connection();
		await settle();
		assert.strictEqual(ctx.calls.length, 0);
	});
});

describe('the runner', () => {
	test('a leave before the join answers waits for it, then leaves', async () => {
		const ctx = setup();
		const joined = ctx.room.join();
		await settle();
		const join_call = ctx.take('room_join');
		const left = ctx.room.leave();
		const result = await joined;
		assert.ok(!result.ok);
		assert.strictEqual(
			(result.error.data as { reason: string }).reason,
			ERROR_ROOM_JOIN_SUPERSEDED
		);
		assert.strictEqual(ctx.calls.length, 0, 'the leave waits for the join');

		const me = member();
		join_call.resolve(join_output(ROOM, me.member_id, 1, [me]));
		await settle();
		assert.isNull(ctx.room.seat);
		ctx.take('room_leave').resolve({ ok: true, value: { left: true } });
		await left;
		assert.deepEqual(ctx.heard, [], 'never seated here');
	});

	test('join, leave, join converges on one seat', async () => {
		const ctx = setup();
		void ctx.room.join();
		await settle();
		const first = ctx.take('room_join');
		void ctx.room.leave();
		const joined = ctx.room.join();
		const a = member();
		first.resolve(join_output(ROOM, a.member_id, 1, [a]));
		await settle();
		// seated by the first join, still wanted: no second join, no leave
		assert.strictEqual(ctx.calls.length, 0);
		const result = await joined;
		assert.ok(result.ok);
		assert.strictEqual(result.value.member_id, a.member_id);
	});

	test('leave ends the seat at once and tells the server', async () => {
		const ctx = setup();
		const { me } = await join(ctx);
		const left = ctx.room.leave();
		assert.isNull(ctx.room.seat);
		assert.strictEqual(ctx.room.seat_status, 'idle');
		assert.deepEqual(ctx.room.members, []);
		assert.deepEqual(ctx.heard, [`seated ${me.member_id}`, 'unseated left']);
		await settle();
		ctx.take('room_leave').resolve({ ok: true, value: { left: true } });
		await left;
		// later events are not this seat's
		ctx.client.receive('room_member_joined', joined_params(9));
		assert.deepEqual(ctx.room.members, []);
	});
});

describe('RoomState.set_state', () => {
	test('a state set while seated is sent, the latest of a burst only', async () => {
		const ctx = setup();
		const { me } = await join(ctx);
		await settle(); // the runner goes idle
		void ctx.room.set_state('a');
		void ctx.room.set_state('b');
		void ctx.room.set_state('c');
		await settle();
		const first = ctx.take('room_state_set');
		assert.strictEqual(first.input.state, 'a');
		first.resolve({ ok: true, value: { seq: 6 } });
		await settle();
		const second = ctx.take('room_state_set');
		assert.strictEqual(second.input.state, 'c');
		second.resolve({ ok: true, value: { seq: 7 } });
		await settle();
		assert.strictEqual(ctx.calls.length, 0);
		assert.strictEqual(ctx.room.members.find((m) => m.member_id === me.member_id)?.state, 'c');
	});

	test('a state set before the join rides the join', async () => {
		const ctx = setup();
		void ctx.room.set_state('ready');
		const joined = ctx.room.join();
		await settle();
		const call = ctx.take('room_join');
		assert.strictEqual(call.input.state, 'ready');
		const me = member();
		call.resolve(join_output(ROOM, me.member_id, 1, [{ ...me, state: 'ready' }]));
		await joined;
		await settle();
		assert.strictEqual(ctx.calls.length, 0, 'no separate state set');
	});

	test('a refused state is not sent again', async () => {
		const ctx = setup();
		await join(ctx);
		void ctx.room.set_state('x'.repeat(10));
		await settle();
		ctx.take('room_state_set').resolve(refusal('room_state_too_large'));
		await settle();
		assert.strictEqual(ctx.calls.length, 0);
		assert.ok(ctx.room.error);
	});
});

describe('RoomState.send', () => {
	test('a send without a seat is refused here; with one it goes out at once', async () => {
		const ctx = setup();
		const refused = await ctx.room.send(null, 'p');
		assert.ok(!refused.ok);
		assert.strictEqual((refused.error.data as { reason: string }).reason, ERROR_ROOM_NOT_JOINED);

		const { others } = await join(ctx);
		const to = others[0]!.member_id;
		const first = ctx.room.send(to, 'one');
		const second = ctx.room.send(null, 'two');
		const c1 = ctx.take('room_send');
		const c2 = ctx.take('room_send');
		assert.deepEqual([c1.input.to, c1.input.payload], [to, 'one']);
		assert.deepEqual([c2.input.to, c2.input.payload], [null, 'two']);
		c2.resolve({ ok: true, value: null });
		c1.resolve({ ok: true, value: null });
		assert.ok((await first).ok);
		assert.ok((await second).ok);
	});
});

describe('RoomClient.dispose', () => {
	test('dispose leaves every seat and drops every watch', async () => {
		const ctx = setup();
		await join(ctx);
		const other = ctx.client.room('room_2');
		void other.watch();
		await settle();
		ctx.take('room_watch').resolve(occupancy('room_2', 1, []));
		await settle();

		const disposed = ctx.client.dispose();
		assert.isTrue(ctx.client.disposed);
		assert.isNull(ctx.room.seat);
		assert.isFalse(other.watching);
		assert.deepEqual(ctx.heard.at(-1), 'unseated closed');
		await settle();
		const methods = ctx.calls.map((c) => c.method).sort();
		assert.deepEqual(methods, ['room_leave', 'room_unwatch']);
		for (const c of ctx.calls.splice(0)) c.resolve({ ok: true, value: {} });
		await disposed;

		const after = await ctx.room.join();
		assert.ok(!after.ok);
		await settle();
		assert.strictEqual(ctx.calls.length, 0);
	});
});

describe('releasing a watch and disposing', () => {
	test('unwatch while seated keeps the seat’s members and stream', async () => {
		const ctx = setup();
		const { me, others } = await join(ctx);
		const watched = ctx.room.watch();
		await settle();
		ctx.take('room_watch').resolve(occupancy(ROOM, 6, [...others, me]));
		await watched;
		assert.isTrue(ctx.room.watching);

		const unwatched = ctx.room.unwatch();
		assert.isFalse(ctx.room.watching);
		assert.deepEqual(ctx.room.members, [...others, me]);
		await settle();
		ctx.take('room_unwatch').resolve({ ok: true, value: { unwatched: true } });
		await unwatched;
		const b = member();
		ctx.client.receive('room_member_joined', joined_params(7, b));
		assert.deepEqual(ctx.room.members, [...others, me, b]);
	});

	test('dispose: an unseated listener reads the watch as unwanted', async () => {
		const ctx = setup();
		const { me, others } = await join(ctx);
		void ctx.room.watch();
		await settle();
		ctx.take('room_watch').resolve(occupancy(ROOM, 6, [...others, me]));
		await settle();
		const read: Array<boolean> = [];
		ctx.room.add_listener({ unseated: () => read.push(ctx.room.want_watch) });
		void ctx.client.dispose();
		assert.deepEqual(read, [false]);
	});
});
