// @vitest-environment jsdom

/**
 * Tests for `RoomClient` under Svelte's client runtime: the verbs called from
 * an `$effect` don't make it depend on the room state they touch, and the
 * client follows `RoomRpc.connection` with its own effect.
 *
 * @module
 */

import { describe, test, assert, vi } from 'vitest';
import { flushSync } from 'svelte';

import { RoomClient, type RoomRpc } from '#lib/actions/room_client.svelte.ts';
import { RtcMesh } from '#lib/rtc/rtc_mesh.svelte.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { create_fake_room_rpc, join_output, member, occupancy } from './room_client_fakes.ts';
import { settle as settle_tasks } from '../fake_timers.ts';
import { create_fake_rtc_deps, create_fake_track } from '../rtc/rtc_fakes.ts';

// vitest resolves the server builds, whose effects never run — load the client builds
vi.mock('svelte', async () =>
	(await import('../ui/svelte_client_test_helpers.ts')).import_svelte_client('.')
);
vi.mock('svelte/reactivity', async () =>
	(await import('../ui/svelte_client_test_helpers.ts')).import_svelte_client('./reactivity')
);

const ROOM = 'room_1';

/** Let queued work run, then flush Svelte's effects, twice over. */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 2; i++) {
		await settle_tasks();
		flushSync();
	}
};

/**
 * A client and a room, settled so the client's own effect has run and the
 * room's runner is idle: a verb called from an effect then runs its requests'
 * first steps inside that effect, where a tracked read would register.
 */
const setup = async () => {
	const fake = create_fake_room_rpc();
	const client = new RoomClient(fake.rpc);
	const room = client.room(ROOM);
	await settle();
	return { ...fake, client, room };
};

/** `setup`, then seated. */
const setup_seated = async () => {
	const ctx = await setup();
	const joined = ctx.room.join();
	await settle();
	const me = member();
	ctx.take('room_join').resolve(join_output(ROOM, me.member_id, 1, [me]));
	await joined;
	await settle();
	return { ...ctx, me };
};

/** Run `body` in an `$effect`, counting its runs. */
const in_effect = (body: () => void | (() => void)) => {
	const counter = { runs: 0, stop: () => {} };
	counter.stop = $effect.root(() => {
		$effect(() => {
			counter.runs++;
			return body();
		});
	});
	return counter;
};

describe('RoomState verbs in an $effect', () => {
	test('a join, left in the teardown, runs the effect once and sends one join', async () => {
		const { client, room, take, calls } = await setup();
		const effect = in_effect(() => {
			void room.join({ state: 'quiet' });
			return () => void room.leave();
		});
		await settle();
		const me = member();
		take('room_join').resolve(join_output(ROOM, me.member_id, 1, [me]));
		await settle();
		assert.strictEqual(room.seat?.member_id, me.member_id);
		void room.set_state('loud');
		await settle();
		take('room_state_set').resolve({ ok: true, value: { seq: 2 } });
		await settle();
		assert.strictEqual(effect.runs, 1);
		assert.strictEqual(calls.length, 0);

		effect.stop();
		await settle();
		take('room_leave').resolve({ ok: true, value: { left: true } });
		await settle();
		assert.strictEqual(calls.length, 0);
		await client.dispose();
	});

	test('a watch, unwatched in the teardown, runs the effect once and sends one watch', async () => {
		const { client, room, take, calls } = await setup();
		const effect = in_effect(() => {
			void room.watch();
			return () => void room.unwatch();
		});
		await settle();
		take('room_watch').resolve(occupancy(ROOM, 1, [member()]));
		await settle();
		assert.isTrue(room.watching);
		assert.strictEqual(effect.runs, 1);
		assert.strictEqual(calls.length, 0);

		effect.stop();
		await settle();
		take('room_unwatch').resolve({ ok: true, value: { unwatched: true } });
		await settle();
		assert.strictEqual(calls.length, 0);
		await client.dispose();
	});

	test('a leave from an $effect runs it once', async () => {
		const { client, room, take } = await setup_seated();
		const effect = in_effect(() => void room.leave());
		await settle();
		take('room_leave').resolve({ ok: true, value: { left: true } });
		await settle();
		assert.isNull(room.seat);
		assert.strictEqual(effect.runs, 1);
		effect.stop();
		await client.dispose();
	});

	test('an unwatch from an $effect runs it once', async () => {
		const { client, room, take } = await setup();
		void room.watch();
		await settle();
		take('room_watch').resolve(occupancy(ROOM, 1, [member()]));
		await settle();
		const effect = in_effect(() => void room.unwatch());
		await settle();
		take('room_unwatch').resolve({ ok: true, value: { unwatched: true } });
		await settle();
		assert.isFalse(room.watching);
		assert.strictEqual(effect.runs, 1);
		effect.stop();
		await client.dispose();
	});

	test('a state set from an $effect does not track the seat', async () => {
		const { client, room, take } = await setup_seated();
		const effect = in_effect(() => void room.set_state('ready'));
		await settle();
		take('room_state_set').resolve({ ok: true, value: { seq: 2 } });
		await settle();
		void room.leave();
		await settle();
		assert.strictEqual(effect.runs, 1);
		effect.stop();
		void client.dispose(); // the leave stays unanswered
	});

	test('a send from an $effect does not track the seat', async () => {
		const { client, room, take } = await setup_seated();
		const effect = in_effect(() => void room.send(null, 'hello'));
		await settle();
		take('room_send').resolve({ ok: true, value: null });
		void room.leave();
		await settle();
		assert.strictEqual(effect.runs, 1);
		effect.stop();
		void client.dispose(); // the leave stays unanswered
	});
});

describe('a cached room outlives the effect that made it', () => {
	test('its seat_status keeps following after that effect ends', async () => {
		const fake = create_fake_room_rpc();
		const client = new RoomClient(fake.rpc);
		await settle();
		let room!: ReturnType<RoomClient['room']>;
		let first_status: string | undefined;
		const effect = in_effect(() => {
			room = client.room(ROOM);
			first_status = room.seat_status;
		});
		await settle();
		assert.strictEqual(first_status, 'idle');
		effect.stop();
		void room.join();
		assert.strictEqual(room.seat_status, 'joining');
		void client.dispose();
	});

	test('a $derived may ask for a room the client has not made yet', async () => {
		const fake = create_fake_room_rpc();
		const client = new RoomClient(fake.rpc);
		await settle();
		const seen: Array<string> = [];
		const stop = $effect.root(() => {
			const room = $derived(client.room(ROOM));
			$effect(() => {
				seen.push(room.seat_status);
			});
		});
		await settle();
		void client.room(ROOM).join();
		await settle();
		assert.deepEqual(seen, ['idle', 'joining']);
		stop();
		void client.dispose();
	});
});

describe('an RtcMesh made in an $effect', () => {
	test('a member joining and the seat ending do not rebuild it', async () => {
		const ctx = await setup_seated();
		const { deps } = create_fake_rtc_deps();
		let closes = 0;
		const effect = in_effect(() => {
			const mesh = new RtcMesh(deps, { room: ctx.room });
			return () => {
				closes++;
				mesh.close();
			};
		});
		await settle();
		ctx.client.receive('room_member_joined', { room_id: ROOM, seq: 2, member: member() });
		await settle();
		void ctx.room.leave();
		await settle();
		assert.strictEqual(effect.runs, 1);
		assert.strictEqual(closes, 0);
		effect.stop();
		void ctx.client.dispose();
	});
});

describe('RtcMesh.set_track in an $effect', () => {
	test('a peer joining or closing does not re-run it', async () => {
		const ctx = await setup_seated();
		const { deps } = create_fake_rtc_deps();
		const mesh = new RtcMesh(deps, { room: ctx.room });
		// a lower id, so this end is impolite and its peer has transceivers at once
		const other = member('00000000-0000-4000-8000-000000000000' as Uuid);
		ctx.client.receive('room_member_joined', { room_id: ROOM, seq: 2, member: other });
		await settle();
		assert.strictEqual(mesh.peers.size, 1);
		const mic = create_fake_track();
		const effect = in_effect(() => {
			void mesh.set_track('mic', mic);
		});
		await settle();
		ctx.client.receive('room_member_joined', { room_id: ROOM, seq: 3, member: member() });
		await settle();
		assert.strictEqual(mesh.peers.size, 2);
		ctx.client.receive('room_member_left', {
			room_id: ROOM,
			seq: 4,
			member_id: other.member_id,
			reason: 'left'
		});
		await settle();
		assert.strictEqual(mesh.peers.size, 1);
		assert.strictEqual(effect.runs, 1);
		effect.stop();
		mesh.close();
		void ctx.client.dispose();
	});
});

describe('RoomClient follows the connection', () => {
	/** A fake rpc whose connection is reactive state. */
	const create_reactive_rpc = () => {
		const fake = create_fake_room_rpc();
		let connection: object | null = $state({});
		const rpc: RoomRpc = {
			...fake.rpc,
			get connection() {
				return connection;
			}
		};
		return {
			...fake,
			rpc,
			set_reactive_connection: (c: object | null) => {
				connection = c;
			}
		};
	};

	test('dispose stops following the connection', async () => {
		const fake = create_reactive_rpc();
		let reads = 0;
		const rpc: RoomRpc = {
			...fake.rpc,
			get connection() {
				reads++;
				return fake.rpc.connection;
			}
		};
		const client = new RoomClient(rpc);
		await settle();
		assert.isAbove(reads, 0, 'the client read the connection on its own');
		await client.dispose();
		const after = reads;
		fake.set_reactive_connection({});
		await settle();
		assert.strictEqual(reads, after);
	});

	test('a close and a reopen are seen without a sync_connection call', async () => {
		const fake = create_reactive_rpc();
		const client = new RoomClient(fake.rpc);
		const room = client.room(ROOM);
		const joined = room.join();
		await settle();
		const me = member();
		fake.take('room_join').resolve(join_output(ROOM, me.member_id, 1, [me]));
		await joined;

		fake.set_reactive_connection(null);
		await settle();
		assert.isNull(room.seat);
		assert.strictEqual(room.seat_status, 'rejoining');
		assert.strictEqual(fake.calls.length, 0);

		fake.set_reactive_connection({});
		await settle();
		assert.strictEqual(fake.take('room_join').input.rejoin_of, me.member_id);
		void client.dispose(); // the rejoin stays unanswered
	});

	test('a close and a reopen in one batch are still a new connection', async () => {
		const fake = create_reactive_rpc();
		const client = new RoomClient(fake.rpc);
		const room = client.room(ROOM);
		const joined = room.join();
		await settle();
		const me = member();
		fake.take('room_join').resolve(join_output(ROOM, me.member_id, 1, [me]));
		await joined;

		fake.set_reactive_connection(null);
		fake.set_reactive_connection({});
		await settle();
		assert.strictEqual(fake.take('room_join').input.rejoin_of, me.member_id);
		void client.dispose(); // the rejoin stays unanswered
	});
});
