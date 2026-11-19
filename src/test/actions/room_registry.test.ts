/**
 * Tests for `RoomRegistry` — seats, messages, state, watches, the two-phase
 * join, exclusivity and the rejoin tombstone, eviction, and disconnect —
 * over a real `ConnectionRegistry` with fake sockets. The twin of the Rust
 * `fuz_realtime` room registry's unit tests.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { ConnectionRegistry } from '#lib/actions/connection_registry.ts';
import { DEFAULT_ROOM_MAX_STATE_BYTES } from '#lib/actions/room_action_specs.ts';
import {
	MAX_POISONED_SCOPES,
	ROOM_REJOIN_TOMBSTONE_TTL_MS,
	ROOM_REJOIN_TOMBSTONES_PER_ACTOR,
	RoomRegistry,
	type RoomEvictTarget,
	type RoomJoined,
	type RoomRegistryOptions,
	type RoomResult,
	type RoomSeatAdmit
} from '#lib/actions/room_registry.ts';
import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';
import { create_fake_ws, type FakeWs } from '#lib/testing/ws_round_trip.ts';
import { create_test_identity } from './connection_identity_helpers.ts';

interface Client {
	readonly id: Uuid;
	readonly actor: Uuid;
	readonly fake: FakeWs;
	readonly controller: AbortController;
	/** How many of `fake.sends` the test has read. */
	read: number;
}

/** Let the write pumps and the disconnect listeners run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const unwrap = <T>(result: RoomResult<T>): T => {
	if (!result.ok) assert.fail(`refused: ${result.error}`);
	return result.value;
};

const refusal = <T>(result: RoomResult<T>): string => {
	if (result.ok) assert.fail('expected a refusal');
	return result.error;
};

interface Frame {
	method: string;
	params: Record<string, unknown>;
}

class Harness {
	readonly connections: ConnectionRegistry;
	readonly rooms: RoomRegistry;
	clock = 0;

	constructor(options: RoomRegistryOptions = {}, outbound_queue_bytes?: number) {
		this.connections = new ConnectionRegistry({ log: null, outbound_queue_bytes });
		this.rooms = new RoomRegistry(this.connections, { now: () => this.clock, ...options });
	}

	connect(actor: Uuid = create_uuid(), stalled = false): Client {
		const fake = create_fake_ws({ stalled });
		const controller = new AbortController();
		const id = this.connections.add_connection(
			fake.ws,
			create_test_identity({ account_id: create_uuid() }),
			controller
		);
		return { id, actor, fake, controller, read: 0 };
	}

	join(
		client: Client,
		room_id: string,
		admit: RoomSeatAdmit = {},
		rejoin_of: Uuid | null = null
	): RoomResult<RoomJoined> {
		const pending = this.rooms.reserve_seat({
			connection_id: client.id,
			actor_id: client.actor,
			room_id,
			rejoin_of
		});
		if (!pending.ok) return pending;
		return this.rooms.admit_seat(pending.value, admit);
	}

	watch(client: Client, room_id: string, scope: string | null = null) {
		const pending = this.rooms.reserve_watch(client.id, client.actor, room_id);
		if (!pending.ok) return pending;
		return this.rooms.admit_watch(pending.value, scope);
	}

	/** Close the client's socket as its session does, and let the release run. */
	async disconnect(client: Client): Promise<void> {
		client.controller.abort();
		this.connections.remove_connection(client.id);
		await settle();
	}
}

/** The frames `client` was sent since the last read. */
const frames = async (client: Client): Promise<Array<Frame>> => {
	await settle();
	const fresh = client.fake.sends.slice(client.read).map((text) => JSON.parse(text) as Frame);
	client.read = client.fake.sends.length;
	return fresh;
};

describe('RoomRegistry seats and events', () => {
	test('a join answers the room and tells the others', async () => {
		const h = new Harness();
		const a = h.connect();
		const b = h.connect();
		const joined_a = unwrap(h.join(a, 'line', { state: 'muted' }));
		assert.deepStrictEqual(joined_a, {
			room_id: 'line',
			member_id: joined_a.member_id,
			seq: 1,
			members: [{ member_id: joined_a.member_id, actor_id: a.actor, state: 'muted' }],
			topology: 'mesh'
		});
		const joined_b = unwrap(h.join(b, 'line'));
		assert.strictEqual(joined_b.seq, 2);
		assert.strictEqual(joined_b.members.length, 2);
		assert.deepStrictEqual(await frames(a), [
			{
				jsonrpc: '2.0',
				method: 'room_member_joined',
				params: {
					room_id: 'line',
					seq: 2,
					member: { member_id: joined_b.member_id, actor_id: b.actor, state: null }
				}
			}
		] as Array<unknown>);
		// an event skips the seat that caused it
		assert.deepStrictEqual(await frames(b), []);
	});

	test('a leave tells the others and an empty room is deleted', async () => {
		const h = new Harness();
		const a = h.connect();
		const b = h.connect();
		const { member_id } = unwrap(h.join(a, 'line'));
		unwrap(h.join(b, 'line'));
		await frames(a);
		assert.isTrue(h.rooms.leave(a.id, a.actor, 'line'));
		assert.deepStrictEqual((await frames(b)).at(-1)?.params, {
			room_id: 'line',
			seq: 3,
			member_id,
			reason: 'left'
		});
		assert.isFalse(h.rooms.leave(a.id, a.actor, 'line'), 'idempotent');
		assert.isTrue(h.rooms.leave(b.id, b.actor, 'line'));
		assert.isNull(h.rooms.occupancy('line'));
		// a room created again starts its seq again
		assert.strictEqual(unwrap(h.join(a, 'line')).seq, 1);
	});

	test('a send reaches its addressee, or the room minus the sender', async () => {
		const h = new Harness();
		const a = h.connect();
		const b = h.connect();
		const c = h.connect();
		const w = h.connect();
		const ma = unwrap(h.join(a, 'line')).member_id;
		const mb = unwrap(h.join(b, 'line')).member_id;
		unwrap(h.join(c, 'line'));
		unwrap(h.watch(w, 'line'));
		await Promise.all([a, b, c, w].map(frames));

		assert.strictEqual(unwrap(h.rooms.send(a.id, a.actor, 'line', mb, 'offer')), 4);
		assert.deepStrictEqual(
			(await frames(b)).map((f) => f.params),
			[{ room_id: 'line', seq: 4, from: ma, to: mb, payload: 'offer' }]
		);
		assert.deepStrictEqual(await frames(c), []);
		assert.strictEqual(unwrap(h.rooms.send(a.id, a.actor, 'line', null, 'hi')), 5);
		assert.strictEqual((await frames(b)).length, 1);
		assert.strictEqual((await frames(c)).length, 1);
		assert.deepStrictEqual(await frames(a), [], 'never to the sender');
		assert.deepStrictEqual(await frames(w), [], 'watchers get no messages');

		assert.strictEqual(refusal(h.rooms.send(a.id, a.actor, 'line', ma, 'x')), 'member_not_found');
		assert.strictEqual(
			refusal(h.rooms.send(a.id, a.actor, 'line', create_uuid(), 'x')),
			'member_not_found'
		);
		assert.strictEqual(refusal(h.rooms.send(w.id, w.actor, 'line', null, 'x')), 'not_joined');
		assert.strictEqual(
			refusal(h.rooms.send(a.id, a.actor, 'line', null, 'x'.repeat(64 * 1024 + 1))),
			'payload_too_large'
		);
	});

	test('state reaches the others and the watchers, and is bounded in UTF-8 bytes', async () => {
		const h = new Harness();
		const a = h.connect();
		const b = h.connect();
		const w = h.connect();
		const { member_id } = unwrap(h.join(a, 'line'));
		unwrap(h.join(b, 'line'));
		unwrap(h.watch(w, 'line'));
		await Promise.all([a, b, w].map(frames));
		assert.strictEqual(unwrap(h.rooms.set_state(a.id, a.actor, 'line', 'live')), 3);
		const expected = { room_id: 'line', seq: 3, member_id, state: 'live' };
		assert.deepStrictEqual(
			(await frames(b)).map((f) => f.params),
			[expected]
		);
		assert.deepStrictEqual(
			(await frames(w)).map((f) => f.params),
			[expected]
		);
		assert.deepStrictEqual(await frames(a), []);
		assert.strictEqual(h.rooms.occupancy('line')?.members[0]?.state, 'live');

		const at_bound = 'é'.repeat(DEFAULT_ROOM_MAX_STATE_BYTES / 2);
		unwrap(h.rooms.set_state(a.id, a.actor, 'line', at_bound));
		assert.strictEqual(
			refusal(h.rooms.set_state(a.id, a.actor, 'line', `${at_bound}x`)),
			'state_too_large'
		);
		assert.strictEqual(refusal(h.rooms.set_state(w.id, w.actor, 'line', 'x')), 'not_joined');
		// at a join too
		assert.strictEqual(refusal(h.join(w, 'line', { state: `${at_bound}x` })), 'state_too_large');
	});

	test('every event in a room takes the next seq', async () => {
		const h = new Harness();
		const a = h.connect();
		const b = h.connect();
		unwrap(h.join(a, 'line'));
		const mb = unwrap(h.join(b, 'line')).member_id;
		h.rooms.send(a.id, a.actor, 'line', mb, 'p');
		h.rooms.set_state(b.id, b.actor, 'line', 's');
		h.rooms.leave(b.id, b.actor, 'line');
		assert.strictEqual(h.rooms.occupancy('line')?.seq, 5);
		assert.deepStrictEqual(
			(await frames(a)).map((f) => f.params.seq),
			[2, 4, 5],
			'the addressed message (3) went to its addressee only'
		);
	});
});

describe('RoomRegistry watches', () => {
	test('a watch sees the members without joining, and is bounded', async () => {
		const h = new Harness({ max_watches_per_connection: 2 });
		const w = h.connect();
		const a = h.connect();
		assert.deepStrictEqual(unwrap(h.watch(w, 'line')), { room_id: 'line', seq: 0, members: [] });
		const { member_id } = unwrap(h.join(a, 'line'));
		assert.deepStrictEqual(
			(await frames(w)).map((f) => f.method),
			['room_member_joined']
		);
		assert.deepStrictEqual(unwrap(h.watch(w, 'line')).members[0]?.member_id, member_id);
		unwrap(h.watch(w, 'two'));
		assert.strictEqual(refusal(h.watch(w, 'three')), 'watch_limit');
		assert.isTrue(h.rooms.unwatch(w.id, 'two'));
		assert.isFalse(h.rooms.unwatch(w.id, 'two'));
		unwrap(h.watch(w, 'three'));
	});

	test('a watch is held for the actor that last asked', () => {
		const h = new Harness();
		const w = h.connect();
		const first = create_uuid();
		const second = create_uuid();
		const watch_as = (actor: Uuid) => {
			const pending = unwrap(h.rooms.reserve_watch(w.id, actor, 'line'));
			return unwrap(h.rooms.admit_watch(pending, null));
		};
		watch_as(first);
		watch_as(second);
		assert.strictEqual(h.rooms.evict({ kind: 'actor', actor_id: first }, 'evicted').watches, 0);
		assert.strictEqual(h.rooms.evict({ kind: 'actor', actor_id: second }, 'evicted').watches, 1);
	});
});

describe('RoomRegistry caps', () => {
	test('a full room refuses, and a verdict lowers the cap but never raises it', () => {
		const h = new Harness({ max_members_per_room: 3 });
		const [a, b, c, d] = [h.connect(), h.connect(), h.connect(), h.connect()];
		unwrap(h.join(a, 'pair', { max_members: 2 }));
		unwrap(h.join(b, 'pair', { max_members: 2 }));
		assert.strictEqual(refusal(h.join(c, 'pair', { max_members: 2 })), 'full');
		unwrap(h.join(a, 'big', { max_members: 10 }));
		unwrap(h.join(b, 'big', { max_members: 10 }));
		unwrap(h.join(c, 'big', { max_members: 10 }));
		assert.strictEqual(refusal(h.join(d, 'big', { max_members: 10 })), 'full');
	});

	test('a refused join displaces nothing, and a move within a full room frees its own seat', async () => {
		const h = new Harness({ exclusive: true, max_members_per_room: 2 });
		const actor = create_uuid();
		const s1 = h.connect(actor);
		const other = h.connect();
		const third = h.connect();
		unwrap(h.join(s1, 'elsewhere'));
		unwrap(h.join(other, 'full'));
		unwrap(h.join(third, 'full'));
		await frames(s1);
		const s2 = h.connect(actor);
		assert.strictEqual(refusal(h.join(s2, 'full')), 'full');
		assert.deepStrictEqual(await frames(s1), [], "the actor's seat stayed");
		assert.strictEqual(h.rooms.occupancy('elsewhere')?.members.length, 1);
		// the actor seated in the full room moves within it
		const s3 = h.connect(actor);
		h.rooms.leave(s1.id, actor, 'elsewhere');
		h.rooms.leave(third.id, third.actor, 'full');
		unwrap(h.join(s3, 'full'));
		// its seat on another socket moves within the room
		unwrap(h.join(s2, 'full'));
		assert.strictEqual(h.rooms.occupancy('full')?.members.length, 2);
	});

	test("a seat that ended frees nothing at the actor's next join", () => {
		// the actor's seat index forgets a removed seat, so a later join of a full
		// room counts no seat of its own to move
		const h = new Harness({ exclusive: true });
		const actor = create_uuid();
		const s1 = h.connect(actor);
		unwrap(h.join(s1, 'pair', { max_members: 2 }));
		assert.isTrue(h.rooms.leave(s1.id, actor, 'pair'));
		unwrap(h.join(h.connect(), 'pair', { max_members: 2 }));
		unwrap(h.join(h.connect(), 'pair', { max_members: 2 }));
		assert.strictEqual(refusal(h.join(s1, 'pair', { max_members: 2 })), 'full');
		assert.strictEqual(h.rooms.occupancy('pair')?.members.length, 2);
	});

	test("a verdict's cap that isn't a non-negative integer throws, consuming the join", () => {
		const h = new Harness();
		const a = h.connect();
		for (const max_members of [Number.NaN, 1.5, -1]) {
			const pending = unwrap(
				h.rooms.reserve_seat({ connection_id: a.id, actor_id: a.actor, room_id: 'line' })
			);
			assert.throws(
				() => h.rooms.admit_seat(pending, { max_members }),
				/RoomRegistry: max_members must be an integer of at least 0/,
				undefined,
				String(max_members)
			);
			assert.strictEqual(h.rooms.evict({ kind: 'actor', actor_id: a.actor }, 'evicted').pending, 0);
		}
		assert.isNull(h.rooms.occupancy('line'));
		// zero is a cap, the room full at once
		assert.strictEqual(refusal(h.join(a, 'line', { max_members: 0 })), 'full');
	});
});

describe('RoomRegistry exclusivity and the rejoin guard', () => {
	test("an exclusive join moves the actor's seat, the newest admitted winning", async () => {
		const h = new Harness({ exclusive: true });
		const actor = create_uuid();
		const s1 = h.connect(actor);
		const s2 = h.connect(actor);
		const w = h.connect();
		unwrap(h.watch(w, 'one'));
		// two joins in flight settle by which admits last
		const p1 = unwrap(
			h.rooms.reserve_seat({ connection_id: s1.id, actor_id: actor, room_id: 'one' })
		);
		const p2 = unwrap(
			h.rooms.reserve_seat({ connection_id: s2.id, actor_id: actor, room_id: 'two' })
		);
		const m2 = unwrap(h.rooms.admit_seat(p2)).member_id;
		const m1 = unwrap(h.rooms.admit_seat(p1)).member_id;
		assert.deepStrictEqual(
			(await frames(s2)).map((f) => f.params),
			[{ room_id: 'two', member_id: m2, reason: 'moved', moved_to: 'one' }]
		);
		assert.isNull(h.rooms.occupancy('two'));
		assert.strictEqual(h.rooms.occupancy('one')?.members[0]?.member_id, m1);
		assert.deepStrictEqual(
			(await frames(w)).map((f) => f.method),
			['room_member_joined']
		);
	});

	test('a non-exclusive registry seats an actor on each socket', () => {
		const h = new Harness();
		const actor = create_uuid();
		unwrap(h.join(h.connect(actor), 'one'));
		unwrap(h.join(h.connect(actor), 'two'));
		assert.strictEqual(h.rooms.occupancy('one')?.members.length, 1);
		assert.strictEqual(h.rooms.occupancy('two')?.members.length, 1);
	});

	test("joining again moves the connection's own seat; seats are per actor on one connection", async () => {
		const h = new Harness();
		const a = h.connect();
		const other_actor = create_uuid();
		const m1 = unwrap(h.join(a, 'line')).member_id;
		const m2 = unwrap(h.join(a, 'line')).member_id;
		assert.notStrictEqual(m1, m2);
		assert.deepStrictEqual(
			(await frames(a)).map((f) => f.params),
			[{ room_id: 'line', member_id: m1, reason: 'moved', moved_to: 'line' }]
		);
		// another actor of the account on the same socket holds its own seat
		const pending = unwrap(
			h.rooms.reserve_seat({ connection_id: a.id, actor_id: other_actor, room_id: 'line' })
		);
		const m3 = unwrap(h.rooms.admit_seat(pending)).member_id;
		assert.strictEqual(h.rooms.occupancy('line')?.members.length, 2);
		// its events reach the socket the other actor holds a seat on (the move
		// emptied the room, so it started again: m2 joined at 1, m3 at 2)
		h.rooms.set_state(a.id, a.actor, 'line', 's');
		assert.deepStrictEqual((await frames(a)).at(-1)?.params, {
			room_id: 'line',
			seq: 3,
			member_id: m2,
			state: 's'
		});
		assert.isTrue(h.rooms.leave(a.id, other_actor, 'line'));
		assert.deepStrictEqual(
			h.rooms.occupancy('line')?.members.map((m) => m.member_id),
			[m2],
			`${m3} left alone`
		);
	});

	test('a seat lost to a disconnect is rejoined; one moved since is refused', async () => {
		const h = new Harness({ exclusive: true });
		const actor = create_uuid();
		const s1 = h.connect(actor);
		const m1 = unwrap(h.join(s1, 'line')).member_id;
		await h.disconnect(s1);
		const s2 = h.connect(actor);
		const rejoined = unwrap(h.join(s2, 'line', {}, m1));
		assert.notStrictEqual(rejoined.member_id, m1);

		// moved away: the rejoin is refused at the reserve
		const s3 = h.connect(actor);
		unwrap(h.join(s3, 'other'));
		assert.strictEqual(refusal(h.join(s2, 'line', {}, rejoined.member_id)), 'seat_moved');

		// released by its disconnect, then the actor seated by another join: moved
		const m4 = unwrap(h.join(s3, 'line')).member_id;
		await h.disconnect(s3);
		const s4 = h.connect(actor);
		unwrap(h.join(s4, 'third'));
		const s5 = h.connect(actor);
		assert.strictEqual(refusal(h.join(s5, 'line', {}, m4)), 'seat_moved');
	});

	test('a rejoin in flight when the actor moved on is refused at the admit', () => {
		const h = new Harness({ exclusive: true });
		const actor = create_uuid();
		const s1 = h.connect(actor);
		const m1 = unwrap(h.join(s1, 'line')).member_id;
		const s2 = h.connect(actor);
		const pending = unwrap(
			h.rooms.reserve_seat({
				connection_id: s2.id,
				actor_id: actor,
				room_id: 'line',
				rejoin_of: m1
			})
		);
		unwrap(h.join(h.connect(actor), 'other'));
		assert.strictEqual(refusal(h.rooms.admit_seat(pending)), 'seat_moved');
	});

	test('tombstones are short and few', () => {
		const h = new Harness({ exclusive: true });
		const actor = create_uuid();
		const s = h.connect(actor);
		const first = unwrap(h.join(s, 'line')).member_id;
		const moved: Array<Uuid> = [first];
		for (let i = 0; i <= ROOM_REJOIN_TOMBSTONES_PER_ACTOR; i++) {
			moved.push(unwrap(h.join(s, `room${i}`)).member_id);
		}
		// the oldest went past the per-actor bound: a rejoin of it is seated
		unwrap(h.join(h.connect(actor), 'line', {}, first));
		// the newer ones are refused until they expire
		const s2 = h.connect(actor);
		assert.strictEqual(refusal(h.join(s2, 'line', {}, moved[2])), 'seat_moved');
		h.clock += ROOM_REJOIN_TOMBSTONE_TTL_MS;
		unwrap(h.join(s2, 'line', {}, moved[2]));
	});
});

describe('RoomRegistry two-phase join and eviction', () => {
	test('an eviction reaches a join in flight: by actor and room outright, by scope only its scope', () => {
		const h = new Harness();
		const a = h.connect();
		const reserve = (client: Client) =>
			unwrap(
				h.rooms.reserve_seat({ connection_id: client.id, actor_id: client.actor, room_id: 'line' })
			);
		const targets: Array<RoomEvictTarget> = [
			{ kind: 'actor', actor_id: a.actor },
			{ kind: 'room', room_id: 'line' },
			{ kind: 'scope', scope: 'g1' },
			{ kind: 'actor_in_scope', actor_id: a.actor, scope: 'g1' }
		];
		for (const target of targets) {
			const pending = reserve(a);
			assert.deepStrictEqual(
				h.rooms.evict(target, 'evicted'),
				{ seats: 0, watches: 0, pending: 1 },
				target.kind
			);
			assert.strictEqual(
				refusal(h.rooms.admit_seat(pending, { scope: 'g1' })),
				'evicted',
				target.kind
			);
			assert.isNull(h.rooms.occupancy('line'), target.kind);
		}

		// a scope eviction, or an actor's within a scope, marks the join rather
		// than refusing it: a join admitted under another scope is seated
		for (const target of targets.slice(2)) {
			const pending = reserve(a);
			h.rooms.evict(target, 'evicted');
			unwrap(h.rooms.admit_seat(pending, { scope: 'g2' }));
			h.rooms.leave(a.id, a.actor, 'line');
		}
		// an eviction of another actor leaves the join alone, outright or in its scope
		const b = h.connect();
		for (const target of [targets[0]!, targets[3]!]) {
			const pending = reserve(b);
			assert.strictEqual(h.rooms.evict(target, 'evicted').pending, 0, target.kind);
			unwrap(h.rooms.admit_seat(pending, { scope: 'g1' }));
			h.rooms.leave(b.id, b.actor, 'line');
		}
	});

	test('a scope eviction reaches a watch in flight, under that scope only', () => {
		const h = new Harness();
		const w = h.connect();
		const pending = unwrap(h.rooms.reserve_watch(w.id, w.actor, 'line'));
		assert.deepStrictEqual(h.rooms.evict({ kind: 'scope', scope: 'g1' }, 'evicted'), {
			seats: 0,
			watches: 0,
			pending: 1
		});
		assert.strictEqual(refusal(h.rooms.admit_watch(pending, 'g1')), 'evicted');
		assert.isNull(h.rooms.occupancy('line'));
		const other = unwrap(h.rooms.reserve_watch(w.id, w.actor, 'line'));
		h.rooms.evict({ kind: 'scope', scope: 'g1' }, 'evicted');
		unwrap(h.rooms.admit_watch(other, 'g2'));
	});

	test('past MAX_POISONED_SCOPES scope evictions, a join in flight is refused outright', () => {
		const h = new Harness();
		const a = h.connect();
		const pending = unwrap(
			h.rooms.reserve_seat({ connection_id: a.id, actor_id: a.actor, room_id: 'line' })
		);
		for (let i = 0; i <= MAX_POISONED_SCOPES; i++) {
			h.rooms.evict({ kind: 'scope', scope: `s${i}` }, 'evicted');
		}
		assert.strictEqual(refusal(h.rooms.admit_seat(pending, { scope: 'unrelated' })), 'evicted');
	});

	test('an eviction covers seats and watches, by scope, actor in scope, and room', async () => {
		const h = new Harness();
		const m = h.connect();
		const n = h.connect();
		const w = h.connect();
		unwrap(h.watch(w, 'line', 'g1'));
		const mm = unwrap(h.join(m, 'line', { scope: 'g1' })).member_id;
		const mn = unwrap(h.join(n, 'line', { scope: 'g1' })).member_id;
		await Promise.all([m, n, w].map(frames));

		assert.deepStrictEqual(
			h.rooms.evict({ kind: 'actor_in_scope', actor_id: m.actor, scope: 'g1' }, 'evicted'),
			{ seats: 1, watches: 0, pending: 0 }
		);
		assert.deepStrictEqual(
			(await frames(m)).map((f) => f.params),
			[{ room_id: 'line', member_id: mm, reason: 'evicted', moved_to: null }]
		);
		for (const c of [n, w]) {
			assert.deepStrictEqual(
				(await frames(c)).map((f) => f.params),
				[{ room_id: 'line', seq: 3, member_id: mm, reason: 'evicted' }]
			);
		}
		assert.deepStrictEqual(h.rooms.evict({ kind: 'room', room_id: 'line' }, 'room_closed'), {
			seats: 1,
			watches: 1,
			pending: 0
		});
		assert.deepStrictEqual(
			(await frames(n)).map((f) => f.params),
			[{ room_id: 'line', member_id: mn, reason: 'room_closed', moved_to: null }]
		);
		assert.deepStrictEqual(
			(await frames(w)).map((f) => f.params),
			[{ room_id: 'line', reason: 'room_closed' }]
		);
		assert.isNull(h.rooms.occupancy('line'));
		assert.isFalse(h.rooms.unwatch(w.id, 'line'));
	});

	test("a leave supersedes the connection's join in flight, the acting actor's only", () => {
		const h = new Harness();
		const a = h.connect();
		const pending = unwrap(
			h.rooms.reserve_seat({ connection_id: a.id, actor_id: a.actor, room_id: 'line' })
		);
		// another actor's leave on the connection leaves the join alone
		assert.isFalse(h.rooms.leave(a.id, create_uuid(), 'line'));
		assert.isTrue(h.rooms.leave(a.id, a.actor, 'line'));
		assert.strictEqual(refusal(h.rooms.admit_seat(pending)), 'join_superseded');
	});

	test('a withdrawn join leaves nothing, and admits nothing after', () => {
		const h = new Harness();
		const a = h.connect();
		const pending = unwrap(
			h.rooms.reserve_seat({ connection_id: a.id, actor_id: a.actor, room_id: 'line' })
		);
		pending.withdraw();
		pending.withdraw();
		assert.strictEqual(refusal(h.rooms.admit_seat(pending)), 'evicted');
		assert.deepStrictEqual(h.rooms.evict({ kind: 'actor', actor_id: a.actor }, 'evicted'), {
			seats: 0,
			watches: 0,
			pending: 0
		});
		// an admitted seat's withdraw is a no-op
		const admitted = unwrap(
			h.rooms.reserve_seat({ connection_id: a.id, actor_id: a.actor, room_id: 'line' })
		);
		unwrap(h.rooms.admit_seat(admitted));
		admitted.withdraw();
		assert.strictEqual(h.rooms.occupancy('line')?.members.length, 1);
	});

	test('a closed socket is refused at either phase', async () => {
		const h = new Harness();
		const a = h.connect();
		const pending = unwrap(
			h.rooms.reserve_seat({ connection_id: a.id, actor_id: a.actor, room_id: 'line' })
		);
		const watch = unwrap(h.rooms.reserve_watch(a.id, a.actor, 'line'));
		// the close aborts the signal before the release runs: the admit reads it
		a.controller.abort();
		assert.strictEqual(refusal(h.rooms.admit_seat(pending)), 'connection_closed');
		assert.strictEqual(refusal(h.rooms.admit_watch(watch)), 'connection_closed');
		assert.strictEqual(refusal(h.join(a, 'line')), 'connection_closed');
		await settle();
		assert.strictEqual(refusal(h.join(a, 'line')), 'connection_closed');
		// an unknown or still-pending connection names no socket
		const pending_id = h.connections.register_pending(
			create_fake_ws().ws,
			create_test_identity({ account_id: create_uuid() }),
			new AbortController()
		);
		assert.strictEqual(
			refusal(h.rooms.reserve_seat({ connection_id: pending_id, actor_id: a.actor, room_id: 'x' })),
			'connection_closed'
		);
		assert.strictEqual(
			refusal(h.rooms.reserve_watch(create_uuid(), a.actor, 'x')),
			'connection_closed'
		);
	});

	test('a pending seat from another registry is refused and released there', () => {
		const h = new Harness();
		const other = new RoomRegistry(h.connections);
		const a = h.connect();
		const pending = unwrap(
			h.rooms.reserve_seat({ connection_id: a.id, actor_id: a.actor, room_id: 'line' })
		);
		assert.strictEqual(refusal(other.admit_seat(pending)), 'evicted');
		assert.strictEqual(refusal(h.rooms.admit_seat(pending)), 'evicted');
	});
});

describe('RoomRegistry disconnect', () => {
	test("a disconnect releases every seat, every actor's, and every watch", async () => {
		const h = new Harness({ exclusive: true });
		const stays = h.connect();
		const goes = h.connect();
		const second_actor = create_uuid();
		unwrap(h.join(stays, 'line'));
		const m1 = unwrap(h.join(goes, 'line')).member_id;
		const second = unwrap(
			h.rooms.admit_seat(
				unwrap(
					h.rooms.reserve_seat({ connection_id: goes.id, actor_id: second_actor, room_id: 'line' })
				)
			)
		).member_id;
		unwrap(h.watch(goes, 'watched'));
		const in_flight = unwrap(
			h.rooms.reserve_seat({ connection_id: goes.id, actor_id: goes.actor, room_id: 'x' })
		);
		await frames(stays);
		await h.disconnect(goes);
		assert.sameMembers(
			(await frames(stays)).map(
				(f) => `${f.params.member_id as string} ${f.params.reason as string}`
			),
			[`${m1} disconnected`, `${second} disconnected`]
		);
		assert.isNull(h.rooms.occupancy('watched'));
		assert.strictEqual(refusal(h.rooms.admit_seat(in_flight)), 'connection_closed');
		assert.strictEqual(h.rooms.connection_count(), 1);
	});

	test('one listener per connection across many joins', async () => {
		const h = new Harness();
		const a = h.connect();
		for (let i = 0; i < 20; i++) {
			unwrap(h.join(a, 'line'));
			h.rooms.leave(a.id, a.actor, 'line');
			unwrap(h.watch(a, 'w'));
			h.rooms.unwatch(a.id, 'w');
		}
		assert.strictEqual(h.rooms.connection_count(), 1);
		await h.disconnect(a);
		assert.strictEqual(h.rooms.connection_count(), 0);
	});

	test('a close inside the admit fan-out leaves no ghost seat', async () => {
		/** Closes one connection when its own `room_seat_lost` is sent, as an overflow closes one mid-fan-out. */
		class ClosingConnections extends ConnectionRegistry {
			trap: Client | null = null;
			override send_to(id: Uuid, frame: string): boolean {
				const trap = this.trap;
				if (trap && id === trap.id && frame.includes('room_seat_lost')) {
					this.trap = null;
					trap.controller.abort();
					this.remove_connection(id);
					return false;
				}
				return super.send_to(id, frame);
			}
		}
		const connections = new ClosingConnections({ log: null });
		const rooms = new RoomRegistry(connections, { exclusive: true });
		const controller = new AbortController();
		const fake = create_fake_ws();
		const client: Client = {
			id: connections.add_connection(
				fake.ws,
				create_test_identity({ account_id: create_uuid() }),
				controller
			),
			actor: create_uuid(),
			fake,
			controller,
			read: 0
		};
		const join = () =>
			rooms.admit_seat(
				unwrap(
					rooms.reserve_seat({ connection_id: client.id, actor_id: client.actor, room_id: 'line' })
				)
			);
		unwrap(join());
		connections.trap = client;
		// the join moves the connection's own seat: the seat_lost to itself closes
		// the socket mid-admit, and the release must wait for the admit to finish
		join();
		await settle();
		assert.isNull(rooms.occupancy('line'), 'the seat on the closed socket was released');
		assert.strictEqual(rooms.connection_count(), 0);
	});

	test('a slow member is closed for the overflow and released', async () => {
		// a small outbound budget, and a client that stopped reading
		const h = new Harness({}, 512);
		const sender = h.connect();
		const slow = h.connect(create_uuid(), true);
		unwrap(h.join(sender, 'line'));
		const slow_seat = unwrap(h.join(slow, 'line')).member_id;
		await frames(sender);
		let sent = 0;
		while (!slow.controller.signal.aborted) {
			unwrap(h.rooms.send(sender.id, sender.actor, 'line', null, 'x'.repeat(100)));
			sent++;
			assert.isBelow(sent, 100, 'the budget overflows');
		}
		assert.isFalse(h.connections.is_registered(slow.id));
		await settle();
		assert.strictEqual(h.rooms.occupancy('line')?.members.length, 1);
		assert.deepStrictEqual(
			(await frames(sender)).map((f) => f.params),
			[{ room_id: 'line', seq: 3 + sent, member_id: slow_seat, reason: 'disconnected' }]
		);
	});

	test('clear drops everything, silently, and refuses what is in flight', async () => {
		const h = new Harness({ exclusive: true });
		const a = h.connect();
		unwrap(h.join(a, 'line'));
		unwrap(h.join(a, 'other'));
		unwrap(h.watch(a, 'line'));
		const pending = unwrap(
			h.rooms.reserve_seat({ connection_id: a.id, actor_id: a.actor, room_id: 'line' })
		);
		await frames(a);
		h.rooms.clear();
		assert.deepStrictEqual(await frames(a), [], 'silent');
		assert.isNull(h.rooms.occupancy('line'));
		assert.isNull(h.rooms.occupancy('other'));
		assert.strictEqual(refusal(h.rooms.admit_seat(pending)), 'evicted');
		// the connection keeps its listener and joins again
		unwrap(h.join(a, 'line'));
		assert.strictEqual(h.rooms.connection_count(), 1);
	});
});

describe('RoomRegistry options', () => {
	test('a bound out of range throws', () => {
		const connections = new ConnectionRegistry({ log: null });
		for (const options of [
			{ max_members_per_room: 0 },
			{ max_members_per_room: 1.5 },
			{ max_payload_bytes: -1 },
			{ max_state_bytes: Number.NaN },
			{ max_watches_per_connection: -1 }
		]) {
			assert.throws(() => new RoomRegistry(connections, options), /RoomRegistry/);
		}
		assert.strictEqual(new RoomRegistry(connections).options.exclusive, false);
	});
});
