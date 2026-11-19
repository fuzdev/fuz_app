/**
 * Tests for `RoomClient` across connections and lost seats: a seat lost to a
 * disconnect is rejoined naming it (`rejoin_of`), one the server moved,
 * evicted, or closed is not, a rejoin refused as moved ends as moved, one
 * refused `rate_limited` is retried after its `retry_after` (bounded), a
 * close and reopen seen at once still counts as a new connection, and an
 * answer that lands after its connection closed is dropped.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { ERROR_ROOM_SEAT_MOVED } from '#lib/actions/room_action_specs.ts';
import {
	ROOM_REJOIN_RATE_LIMITED_RETRIES_MAX,
	RoomClient,
	type RoomClientOptions
} from '#lib/actions/room_client.svelte.ts';
import { jsonrpc_error_messages } from '#lib/http/jsonrpc_errors.ts';
import { create_fake_timers, settle } from '../fake_timers.ts';

import {
	create_fake_room_rpc,
	join_output,
	member,
	occupancy,
	refusal
} from './room_client_fakes.ts';

const ROOM = 'room_1';

const setup = async (options?: RoomClientOptions) => {
	const fake = create_fake_room_rpc();
	const client = new RoomClient(fake.rpc, options);
	client.sync_connection();
	const room = client.room(ROOM);
	const heard: Array<string> = [];
	room.add_listener({
		seated: (seat) => heard.push(`seated ${seat.member_id}`),
		unseated: (_seat, reason) => heard.push(`unseated ${reason}`)
	});
	const me = member();
	const joined = room.join();
	await settle();
	fake.take('room_join').resolve(join_output(ROOM, me.member_id, 3, [member(), me]));
	await joined;
	return { ...fake, client, room, heard, me };
};

describe('room_seat_lost', () => {
	const reasons: Array<[reason: 'moved' | 'evicted' | 'room_closed', moved_to: string | null]> = [
		['moved', 'room_2'],
		['evicted', null],
		['room_closed', null]
	];

	test.each(reasons)('%s ends the seat, and no reconnect rejoins it', async (reason, moved_to) => {
		const ctx = await setup();
		ctx.client.receive('room_seat_lost', {
			room_id: ROOM,
			member_id: ctx.me.member_id,
			reason,
			moved_to
		});
		assert.isNull(ctx.room.seat);
		assert.strictEqual(ctx.room.seat_status, 'idle');
		assert.deepEqual(ctx.room.ended, { reason, moved_to });
		assert.deepEqual(ctx.room.members, []);
		assert.strictEqual(ctx.heard.at(-1), `unseated ${reason}`);

		ctx.set_connection(null);
		ctx.client.sync_connection();
		ctx.set_connection({});
		ctx.client.sync_connection();
		await settle();
		assert.strictEqual(ctx.calls.length, 0);
	});

	test('a seat lost for another member id is not this seat', async () => {
		const ctx = await setup();
		ctx.client.receive('room_seat_lost', {
			room_id: ROOM,
			member_id: member().member_id,
			reason: 'moved',
			moved_to: 'room_2'
		});
		assert.strictEqual(ctx.room.seat?.member_id, ctx.me.member_id);
	});
});

describe('disconnect', () => {
	test('a seat lost to a disconnect is rejoined on the next connection, naming it', async () => {
		const ctx = await setup();
		ctx.set_connection(null);
		ctx.client.sync_connection();
		assert.isNull(ctx.room.seat);
		assert.strictEqual(ctx.room.seat_status, 'rejoining');
		assert.strictEqual(ctx.room.rejoin_of, ctx.me.member_id);
		assert.deepEqual(ctx.room.members, []);
		assert.strictEqual(ctx.heard.at(-1), 'unseated disconnected');
		await settle();
		assert.strictEqual(ctx.calls.length, 0, 'nothing is sent while down');

		ctx.set_connection({});
		ctx.client.sync_connection();
		await settle();
		const call = ctx.take('room_join');
		assert.strictEqual(call.input.rejoin_of, ctx.me.member_id);
		const again = member();
		call.resolve(join_output(ROOM, again.member_id, 1, [again]));
		await settle();
		assert.strictEqual(ctx.client.room(ROOM).seat?.member_id, again.member_id);
		assert.strictEqual(ctx.room.seat_status, 'joined');
		assert.isNull(ctx.room.rejoin_of);
		assert.strictEqual(ctx.heard.at(-1), `seated ${again.member_id}`);
	});

	test('a rejoin refused as moved ends as moved and is not retried', async () => {
		const ctx = await setup();
		ctx.set_connection({});
		ctx.client.sync_connection();
		await settle();
		ctx.take('room_join').resolve(refusal(ERROR_ROOM_SEAT_MOVED));
		await settle();
		assert.strictEqual(ctx.room.seat_status, 'idle');
		assert.deepEqual(ctx.room.ended, { reason: 'moved', moved_to: null });
		assert.ok(ctx.room.error);
		assert.isNull(ctx.room.rejoin_of);

		ctx.set_connection({});
		ctx.client.sync_connection();
		await settle();
		assert.strictEqual(ctx.calls.length, 0);
	});

	test('a close and reopen seen at once is still a new connection', async () => {
		const ctx = await setup();
		ctx.set_connection({}); // never seen as `null`
		ctx.client.sync_connection();
		assert.strictEqual(ctx.heard.at(-1), 'unseated disconnected');
		await settle();
		assert.strictEqual(ctx.take('room_join').input.rejoin_of, ctx.me.member_id);
	});

	test('a request notices the new connection without a sync', async () => {
		const ctx = await setup();
		ctx.set_connection({});
		// a notification on the new connection runs the sync on its own
		ctx.client.receive('room_member_joined', { room_id: ROOM, seq: 9, member: member() });
		assert.isNull(ctx.room.seat);
		await settle();
		assert.strictEqual(ctx.take('room_join').input.rejoin_of, ctx.me.member_id);
	});

	test('a join answered after its connection closed is rejoined, not applied', async () => {
		const fake = create_fake_room_rpc();
		const client = new RoomClient(fake.rpc);
		client.sync_connection();
		const room = client.room(ROOM);
		const joined = room.join();
		await settle();
		const call = fake.take('room_join');
		fake.set_connection({});
		const me = member();
		call.resolve(join_output(ROOM, me.member_id, 1, [me]));
		await settle();
		assert.isNull(room.seat);
		const rejoin = fake.take('room_join');
		assert.strictEqual(rejoin.input.rejoin_of, me.member_id);
		const again = member();
		rejoin.resolve(join_output(ROOM, again.member_id, 2, [again]));
		const result = await joined;
		assert.ok(result.ok);
		assert.strictEqual(result.value.member_id, again.member_id);
	});

	test('a join made while down waits for the connection', async () => {
		const fake = create_fake_room_rpc();
		fake.set_connection(null);
		const client = new RoomClient(fake.rpc);
		client.sync_connection();
		const room = client.room(ROOM);
		const joined = room.join();
		await settle();
		assert.strictEqual(fake.calls.length, 0);
		assert.strictEqual(room.seat_status, 'joining');
		fake.set_connection({});
		client.sync_connection();
		await settle();
		const me = member();
		fake.take('room_join').resolve(join_output(ROOM, me.member_id, 1, [me]));
		assert.ok((await joined).ok);
	});

	test('a leave while down drops the rejoin and sends nothing', async () => {
		const ctx = await setup();
		ctx.set_connection(null);
		ctx.client.sync_connection();
		await ctx.room.leave();
		assert.strictEqual(ctx.room.seat_status, 'idle');
		assert.isNull(ctx.room.rejoin_of);
		ctx.set_connection({});
		ctx.client.sync_connection();
		await settle();
		assert.strictEqual(ctx.calls.length, 0);
	});

	test('a watch lost to a disconnect is taken again', async () => {
		const fake = create_fake_room_rpc();
		const client = new RoomClient(fake.rpc);
		client.sync_connection();
		const room = client.room(ROOM);
		void room.watch();
		await settle();
		fake.take('room_watch').resolve(occupancy(ROOM, 4, [member()]));
		await settle();
		fake.set_connection({});
		client.sync_connection();
		assert.isFalse(room.watching);
		assert.deepEqual(room.members, []);
		await settle();
		const a = member();
		fake.take('room_watch').resolve(occupancy(ROOM, 1, [a]));
		await settle();
		// the room was made anew: its seq starts over, and the snapshot applies
		assert.deepEqual(room.members, [a]);
	});
});

describe('a rejoin refused rate_limited', () => {
	const rate_limited = (retry_after?: number) => ({
		ok: false as const,
		error: jsonrpc_error_messages.rate_limited(
			'rate limited',
			retry_after === undefined ? undefined : { retry_after }
		)
	});

	/** Seated, then the connection changed: the first rejoin is in flight. */
	const setup_rejoin = async () => {
		const timers = create_fake_timers();
		const ctx = await setup({
			set_timeout: timers.set_timeout,
			clear_timeout: timers.clear_timeout
		});
		ctx.set_connection({});
		ctx.client.sync_connection();
		await settle();
		return { ...ctx, timers };
	};

	test('is retried after retry_after, still naming the seat', async () => {
		const ctx = await setup_rejoin();
		ctx.take('room_join').resolve(rate_limited(2));
		await settle();
		assert.deepEqual(ctx.timers.pending(), [2000]);
		assert.strictEqual(ctx.calls.length, 0, 'nothing until the wait is over');
		assert.strictEqual(ctx.room.seat_status, 'rejoining');
		assert.strictEqual(ctx.room.rejoin_of, ctx.me.member_id);
		assert.ok(ctx.room.error);

		ctx.timers.fire_all();
		await settle();
		const retry = ctx.take('room_join');
		assert.strictEqual(retry.input.rejoin_of, ctx.me.member_id);
		const again = member();
		retry.resolve(join_output(ROOM, again.member_id, 1, [again]));
		await settle();
		assert.strictEqual(ctx.room.seat?.member_id, again.member_id);
		assert.isNull(ctx.room.error);
	});

	test('a refusal without retry_after waits a second', async () => {
		const ctx = await setup_rejoin();
		ctx.take('room_join').resolve(rate_limited());
		await settle();
		assert.deepEqual(ctx.timers.pending(), [1000]);
	});

	test('gives up after the bounded retries', async () => {
		const ctx = await setup_rejoin();
		for (let i = 0; i < ROOM_REJOIN_RATE_LIMITED_RETRIES_MAX; i++) {
			ctx.take('room_join').resolve(rate_limited(1));
			await settle();
			assert.strictEqual(ctx.timers.pending().length, 1);
			ctx.timers.fire_all();
			await settle();
		}
		ctx.take('room_join').resolve(rate_limited(1));
		await settle();
		assert.deepEqual(ctx.timers.pending(), []);
		assert.strictEqual(ctx.room.seat_status, 'idle');
		assert.isNull(ctx.room.rejoin_of);
		assert.ok(ctx.room.error);
		assert.strictEqual(ctx.calls.length, 0);
	});

	test('a new connection rejoins at once, its wait dropped', async () => {
		const ctx = await setup_rejoin();
		ctx.take('room_join').resolve(rate_limited(30));
		await settle();
		ctx.set_connection({});
		ctx.client.sync_connection();
		assert.deepEqual(ctx.timers.pending(), []);
		await settle();
		assert.strictEqual(ctx.take('room_join').input.rejoin_of, ctx.me.member_id);
	});

	test('a new connection starts the retries afresh', async () => {
		const ctx = await setup_rejoin();
		for (let i = 0; i < ROOM_REJOIN_RATE_LIMITED_RETRIES_MAX; i++) {
			ctx.take('room_join').resolve(rate_limited(1));
			await settle();
			ctx.timers.fire_all();
			await settle();
		}
		// the retries are spent, the last one in flight as the socket reopens
		const spent = ctx.take('room_join');
		ctx.set_connection({});
		ctx.client.sync_connection();
		spent.resolve(rate_limited(1));
		await settle();
		ctx.take('room_join').resolve(rate_limited(1));
		await settle();
		assert.deepEqual(ctx.timers.pending(), [1000]);
		assert.strictEqual(ctx.room.seat_status, 'rejoining');
	});

	test('a leave during the wait drops it', async () => {
		const ctx = await setup_rejoin();
		ctx.take('room_join').resolve(rate_limited(30));
		await settle();
		await ctx.room.leave();
		assert.deepEqual(ctx.timers.pending(), []);
		assert.strictEqual(ctx.room.seat_status, 'idle');
	});

	test('a first join refused rate_limited is the caller’s, not retried', async () => {
		const timers = create_fake_timers();
		const fake = create_fake_room_rpc();
		const client = new RoomClient(fake.rpc, {
			set_timeout: timers.set_timeout,
			clear_timeout: timers.clear_timeout
		});
		const joined = client.room(ROOM).join();
		await settle();
		fake.take('room_join').resolve(rate_limited(2));
		const result = await joined;
		assert.ok(!result.ok);
		assert.deepEqual(timers.pending(), []);
	});
});

describe('answers after the connection changed', () => {
	test('a state set answered after the connection changed is dropped', async () => {
		const ctx = await setup();
		await settle();
		void ctx.room.set_state('a');
		await settle();
		const call = ctx.take('room_state_set');
		ctx.set_connection({});
		ctx.client.sync_connection();
		call.resolve(refusal('room_state_too_large'));
		await settle();
		assert.isNull(ctx.room.error, 'the refusal was for a seat that is gone');
		const rejoin = ctx.take('room_join');
		assert.strictEqual(rejoin.input.state, 'a', 'the state rides the rejoin');
	});
});

describe('send across connections', () => {
	test('a send after the connection changed is refused, not sent on the stale seat', async () => {
		const ctx = await setup();
		ctx.set_connection({});
		const result = await ctx.room.send(null, 'p');
		assert.ok(!result.ok);
		assert.isFalse(ctx.calls.some((c) => c.method === 'room_send'));
	});
});
