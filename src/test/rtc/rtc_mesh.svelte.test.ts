/**
 * Tests for `RtcMesh` — the peer map over a room's members, over fake rooms
 * that relay each other's sends and scripted fake connections: connecting,
 * members joining and leaving, seats ending and taken again, track fan-out,
 * the per-peer send chain, the topology guard, peers that can't be made,
 * messages addressed to another actor's seat, and ICE servers.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { create_uuid } from '#lib/primitive_schemas.ts';
import type { MemberId, RoomMember, RoomTopology } from '#lib/actions/room_action_specs.ts';
import {
	RoomClient,
	type RoomListener,
	type RoomRpcResult,
	type RoomSeat,
	type RoomUnseatedReason
} from '#lib/actions/room_client.svelte.ts';
import { RtcMesh, type RtcMeshRoom } from '#lib/rtc/rtc_mesh.svelte.ts';
import { RtcPeer } from '#lib/rtc/rtc_peer.svelte.ts';
import { decode_rtc_signal, encode_rtc_signal, type RtcSignal } from '#lib/rtc/rtc_signal.ts';

import { create_fake_room_rpc, join_output, member } from '../actions/room_client_fakes.ts';
import { settle } from '../fake_timers.ts';
import { create_fake_rtc_deps, create_fake_track } from './rtc_fakes.ts';

const ROOM_ID = 'line_1';

interface Outgoing {
	to: MemberId;
	payload: string;
	resolve: (result: RoomRpcResult<null>) => void;
}

/** A room as one member sees it, driven by the test. */
class FakeRoom implements RtcMeshRoom {
	seat: RoomSeat | null = null;
	members: Array<RoomMember> = [];
	readonly outbox: Array<Outgoing> = [];
	readonly #listeners: Set<RoomListener> = new Set();
	#seq = 0;

	add_listener(listener: RoomListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	send(to: MemberId, payload: string): Promise<RoomRpcResult<null>> {
		return new Promise((resolve) => this.outbox.push({ to, payload, resolve }));
	}

	get listener_count(): number {
		return this.#listeners.size;
	}

	take_seat(
		member_id: MemberId,
		members: Array<RoomMember>,
		topology: RoomTopology = 'mesh',
		extra: unknown = null
	): RoomSeat {
		const seat: RoomSeat = { room_id: ROOM_ID, member_id, topology, extra };
		this.members = members;
		this.seat = seat;
		for (const l of this.#listeners) l.seated?.(seat);
		return seat;
	}

	end_seat(reason: RoomUnseatedReason): void {
		const seat = this.seat!;
		this.seat = null;
		this.members = [];
		for (const l of this.#listeners) l.unseated?.(seat, reason);
	}

	member_joined(member: RoomMember): void {
		this.members = [...this.members, member];
		for (const l of this.#listeners) l.member_joined?.(member);
	}

	member_left(member_id: MemberId): void {
		this.members = this.members.filter((m) => m.member_id !== member_id);
		for (const l of this.#listeners) l.member_left?.(member_id, 'left');
	}

	message(
		from: MemberId,
		payload: string,
		to: MemberId | null = this.seat?.member_id ?? null
	): void {
		for (const l of this.#listeners) {
			l.message?.({ room_id: ROOM_ID, seq: ++this.#seq, from, to, payload });
		}
	}
}

/** Rooms for several members, relaying each send to the room seated as its addressee. */
const create_net = () => {
	const { deps, connections, timers } = create_fake_rtc_deps();
	const rooms: Array<FakeRoom> = [];
	const add = (): FakeRoom => {
		const room = new FakeRoom();
		rooms.push(room);
		return room;
	};
	/** Deliver every send, answering each, until no room has more. */
	const relay = async (): Promise<void> => {
		for (;;) {
			await settle();
			let moved = false;
			for (const room of rooms) {
				const from = room.seat?.member_id;
				while (room.outbox.length) {
					const out = room.outbox.shift()!;
					moved = true;
					out.resolve({ ok: true, value: null });
					if (from) rooms.find((r) => r.seat?.member_id === out.to)?.message(from, out.payload);
				}
			}
			if (!moved) return;
		}
	};
	return { deps, connections, timers, add, relay };
};

/** Two seated members with a mesh each. */
const create_call = () => {
	const net = create_net();
	const a = member();
	const b = member();
	const room_a = net.add();
	const room_b = net.add();
	const mesh_a = new RtcMesh(net.deps, { room: room_a });
	const mesh_b = new RtcMesh(net.deps, { room: room_b });
	room_a.take_seat(a.member_id, [a, b]);
	room_b.take_seat(b.member_id, [a, b]);
	return { ...net, a, b, room_a, room_b, mesh_a, mesh_b };
};

/**
 * A mesh seated with `count` other members, all with lower ids, so it is the
 * impolite end to each and offers to each; nothing relays its sends.
 */
const create_impolite_seat = (count: number) => {
	const net = create_net();
	const sorted = Array.from({ length: count + 1 }, () => create_uuid()).sort();
	const members = sorted.map((id) => member(id));
	const self = members[count]!;
	const others = members.slice(0, count);
	const room = net.add();
	const mesh = new RtcMesh(net.deps, { room });
	room.take_seat(self.member_id, members);
	return { ...net, room, mesh, self, others };
};

describe('RtcMesh connecting', () => {
	test('two members connect through their rooms', async () => {
		const { a, b, mesh_a, mesh_b, relay } = create_call();
		assert.strictEqual(mesh_a.local_member_id, a.member_id);
		await relay();
		const peer_ab = mesh_a.peers.get(b.member_id);
		const peer_ba = mesh_b.peers.get(a.member_id);
		assert.ok(peer_ab);
		assert.ok(peer_ba);
		assert.strictEqual(mesh_a.peers.size, 1);
		assert.strictEqual(peer_ab.connection_state, 'connected');
		assert.strictEqual(peer_ba.connection_state, 'connected');
		assert.notStrictEqual(peer_ab.polite, peer_ba.polite);
		assert.ok(peer_ab.remote_tracks.mic);
		assert.ok(peer_ba.remote_tracks.mic);
	});

	test('a mesh built on a room already seated connects at once', async () => {
		const net = create_net();
		const a = member();
		const b = member();
		const room_a = net.add();
		const room_b = net.add();
		room_a.take_seat(a.member_id, [a, b]);
		room_b.take_seat(b.member_id, [a, b]);
		const mesh_a = new RtcMesh(net.deps, { room: room_a });
		const mesh_b = new RtcMesh(net.deps, { room: room_b });
		await net.relay();
		assert.strictEqual(mesh_a.peers.get(b.member_id)?.connection_state, 'connected');
		assert.strictEqual(mesh_b.peers.get(a.member_id)?.connection_state, 'connected');
	});

	test('a member joining gets a peer; one leaving has it closed', async () => {
		const { a, room_a, room_b, mesh_a, add, deps, relay, connections } = create_call();
		await relay();
		const c = member();
		const room_c = add();
		const mesh_c = new RtcMesh(deps, { room: room_c });
		room_c.take_seat(c.member_id, [...room_a.members, c]);
		room_a.member_joined(c);
		room_b.member_joined(c);
		await relay();
		assert.strictEqual(mesh_a.peers.size, 2);
		assert.strictEqual(mesh_c.peers.size, 2);
		assert.strictEqual(mesh_c.peers.get(a.member_id)?.connection_state, 'connected');

		const peer_ac = mesh_a.peers.get(c.member_id)!;
		const pc_count = connections.length;
		room_a.member_left(c.member_id);
		assert.isTrue(peer_ac.closed);
		assert.isFalse(mesh_a.peers.has(c.member_id));
		assert.strictEqual(connections.filter((pc) => pc.closed).length, 1);
		assert.strictEqual(connections.length, pc_count);
	});

	test('the caller’s own member is never a peer', () => {
		const { a, room_a, mesh_a } = create_call();
		room_a.member_joined(a);
		assert.isFalse(mesh_a.peers.has(a.member_id));
	});
});

describe('RtcMesh seats', () => {
	test('a seat ending closes every peer; a new seat connects afresh, the tracks carried over', async () => {
		const { a, b, room_a, room_b, mesh_a, mesh_b, relay } = create_call();
		const mic = create_fake_track('audio');
		await mesh_a.set_track('mic', mic);
		await relay();
		const old_peer = mesh_a.peers.get(b.member_id)!;

		// a's socket blips: both sides lose the seat pairing
		room_a.end_seat('disconnected');
		room_b.member_left(a.member_id);
		assert.isTrue(old_peer.closed);
		assert.strictEqual(mesh_a.peers.size, 0);
		assert.isNull(mesh_a.local_member_id);
		assert.strictEqual(mesh_b.peers.size, 0);

		// a rejoins with a new member id
		const a2 = member();
		room_a.take_seat(a2.member_id, [b, a2]);
		room_b.member_joined(a2);
		await relay();
		const peer = mesh_a.peers.get(b.member_id)!;
		assert.notStrictEqual(peer, old_peer);
		assert.strictEqual(peer.connection_state, 'connected');
		assert.strictEqual(mesh_b.peers.get(a2.member_id)?.connection_state, 'connected');
		assert.isFalse(mesh_b.peers.has(a.member_id));
		assert.strictEqual(mesh_b.peers.get(a2.member_id)?.remote_tracks.mic?.kind, 'audio');
	});

	test('a seat in another topology connects nothing and says why', () => {
		const net = create_net();
		const a = member();
		const room = net.add();
		const mesh = new RtcMesh(net.deps, { room });
		room.take_seat(a.member_id, [a, member()], 'sfu' as RoomTopology);
		assert.include(mesh.error, "unsupported room topology 'sfu'");
		assert.strictEqual(mesh.peers.size, 0);
		assert.strictEqual(net.connections.length, 0);
	});

	test('close closes the peers and stops following the room', async () => {
		const { b, room_a, mesh_a, relay } = create_call();
		await relay();
		const peer = mesh_a.peers.get(b.member_id)!;
		mesh_a.close();
		assert.isTrue(peer.closed);
		assert.strictEqual(room_a.listener_count, 0);
		room_a.member_joined(member());
		assert.strictEqual(mesh_a.peers.size, 0);
	});
});

describe('RtcMesh tracks', () => {
	test('set_track reaches every peer without renegotiating, and each new peer', async () => {
		const { a, room_a, mesh_a, add, deps, relay, connections } = create_call();
		await relay();
		const offers = connections.reduce((n, pc) => n + pc.offers, 0);
		const mic = create_fake_track('audio');
		await mesh_a.set_track('mic', mic);
		const pc_ab = connections[0]!;
		assert.strictEqual(pc_ab.getTransceivers()[0]!.sender.track, mic);
		await relay();
		assert.strictEqual(
			connections.reduce((n, pc) => n + pc.offers, 0),
			offers
		);

		const c = member();
		const room_c = add();
		const mesh_c = new RtcMesh(deps, { room: room_c });
		room_c.take_seat(c.member_id, [...room_a.members, c]);
		room_a.member_joined(c);
		await relay();
		const peer_ac = mesh_a.peers.get(c.member_id)!;
		assert.strictEqual(peer_ac.connection_state, 'connected');
		assert.strictEqual(mesh_c.peers.size, 2);
		const pc_ac = connections.find(
			(pc) => pc !== pc_ab && pc.getTransceivers()[0]?.sender.track === mic
		);
		assert.ok(pc_ac, 'the new peer sends the local track');
		assert.strictEqual(mesh_a.local_member_id, a.member_id);

		await mesh_a.set_track('mic', null);
		assert.isNull(pc_ab.getTransceivers()[0]!.sender.track);
		assert.isNull(pc_ac.getTransceivers()[0]!.sender.track);
	});

	test('an unknown slot throws', async () => {
		const { mesh_a } = create_call();
		try {
			await mesh_a.set_track('screen', null);
		} catch (error) {
			assert(error instanceof Error);
			assert.include(error.message, "no slot named 'screen'");
			return;
		}
		assert.fail('expected a throw');
	});
});

describe('RtcMesh sends', () => {
	test('one peer’s signals go one at a time, in order', async () => {
		const { room, connections } = create_impolite_seat(1);
		await settle(); // the impolite end offers
		assert.strictEqual(room.outbox.length, 1);
		const [pc] = connections;
		pc!.emit_candidate('candidate:1');
		pc!.emit_candidate('candidate:2');
		await settle();
		assert.strictEqual(room.outbox.length, 1, 'the candidates wait behind the unanswered offer');

		const sent: Array<string> = [];
		while (room.outbox.length) {
			const out = room.outbox.shift()!;
			sent.push(out.payload);
			out.resolve({ ok: true, value: null });
			await settle();
			assert.isAtMost(room.outbox.length, 1);
		}
		const kinds = sent.map((payload) => {
			const decoded = decode_rtc_signal(payload);
			assert.ok(decoded.ok);
			return 'description' in decoded.value ? 'description' : decoded.value.candidate.candidate;
		});
		assert.deepEqual(kinds, ['description', 'candidate:1', 'candidate:2']);
	});

	test('different peers don’t wait on each other', async () => {
		const { room, others } = create_impolite_seat(2);
		await settle();
		assert.sameMembers(
			room.outbox.map((o) => o.to),
			others.map((m) => m.member_id)
		);
	});

	test('a closed peer’s waiting sends are dropped', async () => {
		const { room, others, connections } = create_impolite_seat(1);
		await settle();
		connections[0]!.emit_candidate();
		await settle();
		assert.strictEqual(room.outbox.length, 1, 'the offer; the candidate waits');
		room.member_left(others[0]!.member_id);
		room.outbox.shift()!.resolve({ ok: true, value: null });
		await settle();
		assert.strictEqual(room.outbox.length, 0);
	});
});

describe('RtcMesh messages', () => {
	test('payloads that aren’t signals, and signals from unknown members, are ignored', async () => {
		const { b, room_a, mesh_a, relay, connections } = create_call();
		await relay();
		const answers = connections.reduce((n, pc) => n + pc.answers, 0);
		room_a.message(b.member_id, 'hello, room');
		room_a.message(b.member_id, '{"rtc":2,"description":{}}');
		room_a.message(create_uuid(), encode_rtc_signal({ description: { type: 'offer', sdp: '{}' } }));
		await settle();
		assert.isNull(mesh_a.peers.get(b.member_id)!.last_error);
		assert.strictEqual(
			connections.reduce((n, pc) => n + pc.answers, 0),
			answers
		);
	});
});

describe('RtcMesh on one connection with several actors', () => {
	test('a message addressed to another actor’s seat is not this mesh’s', async () => {
		const net = create_net();
		// x and y are two actors on one connection; r, the highest id, offers to each
		const [x, y, r] = [create_uuid(), create_uuid(), create_uuid()]
			.sort()
			.map((id) => member(id)) as [RoomMember, RoomMember, RoomMember];
		const room_x = net.add();
		const room_y = net.add();
		const mesh_x = new RtcMesh(net.deps, { room: room_x });
		const mesh_y = new RtcMesh(net.deps, { room: room_y });
		room_x.take_seat(x.member_id, [x, y, r]);
		room_y.take_seat(y.member_id, [x, y, r]);
		const far = create_fake_rtc_deps();
		const far_signals: Array<RtcSignal> = [];
		const far_peer = new RtcPeer(far.deps, {
			remote_member_id: y.member_id,
			polite: false,
			send: (signal) => far_signals.push(signal)
		});
		await settle();
		const offer = encode_rtc_signal(far_signals.shift()!);
		// the connection hears r's offer to y once, and both actors' rooms see it
		room_x.message(r.member_id, offer, y.member_id);
		room_y.message(r.member_id, offer, y.member_id);
		await settle();
		assert.strictEqual(mesh_y.peers.get(r.member_id)!.connection_state, 'connected');
		assert.strictEqual(mesh_x.peers.get(r.member_id)!.connection_state, 'new');
		assert.isNull(mesh_x.peers.get(r.member_id)!.last_error);
		far_peer.close();
	});
});

describe('RtcMesh peers that can’t be made', () => {
	test('a peer construction that throws sets error, and the mesh carries on', async () => {
		const net = create_net();
		const [a, b, c] = [member(), member(), member()];
		const room = net.add();
		let refuse = true;
		const create_peer_connection = net.deps.create_peer_connection;
		const mesh = new RtcMesh(
			{
				...net.deps,
				create_peer_connection: (configuration) => {
					if (refuse) throw new SyntaxError('malformed ICE server URL');
					return create_peer_connection(configuration);
				}
			},
			{ room }
		);
		room.take_seat(a.member_id, [a, b]);
		assert.strictEqual(mesh.peers.size, 0);
		assert.include(mesh.error, b.member_id);
		assert.include(mesh.error, 'malformed ICE server URL');
		assert.strictEqual(mesh.local_member_id, a.member_id);

		refuse = false;
		room.member_joined(c);
		assert.ok(mesh.peers.get(c.member_id));
		await settle();
	});

	test('an ICE servers function that throws sets error and connects nothing', () => {
		const net = create_net();
		const a = member();
		const room = net.add();
		const mesh = new RtcMesh(net.deps, {
			room,
			ice_servers: () => {
				throw new Error('no extra');
			}
		});
		room.take_seat(a.member_id, [a, member()]);
		assert.include(mesh.error, 'no extra');
		assert.strictEqual(mesh.peers.size, 0);
		assert.strictEqual(net.connections.length, 0);
	});

	test('a throwing construction over RoomState leaves the join answered and the room live', async () => {
		const fake = create_fake_room_rpc();
		const client = new RoomClient(fake.rpc);
		client.sync_connection();
		const room = client.room(ROOM_ID);
		const mesh = new RtcMesh(
			{
				...create_fake_rtc_deps().deps,
				create_peer_connection: () => {
					throw new SyntaxError('malformed ICE server URL');
				}
			},
			{ room }
		);
		const heard: Array<string> = [];
		room.add_listener({ seated: () => heard.push('seated') });
		const joined = room.join();
		await settle();
		const [me, other] = [member(), member()];
		fake.take('room_join').resolve(join_output(ROOM_ID, me.member_id, 1, [other, me]));
		assert.ok((await joined).ok);
		assert.ok(mesh.error);
		assert.deepEqual(heard, ['seated']);
		const late = member();
		client.receive('room_member_joined', { room_id: ROOM_ID, seq: 2, member: late });
		assert.isTrue(room.members.some((m) => m.member_id === late.member_id));
	});
});

describe('RtcMesh ICE servers', () => {
	test('a list applies to every peer', () => {
		const net = create_net();
		const a = member();
		const room = net.add();
		const ice_servers = [{ urls: 'stun:stun.fuz.dev' }];
		const mesh = new RtcMesh(net.deps, { room, ice_servers });
		room.take_seat(a.member_id, [a, member()]);
		assert.strictEqual(mesh.peers.size, 1);
		assert.deepEqual(net.connections[0]!.configuration.iceServers, ice_servers);
	});

	test('a function reads them from the seat, per seat', () => {
		const net = create_net();
		const a = member();
		const room = net.add();
		const mesh = new RtcMesh(net.deps, {
			room,
			ice_servers: (seat) => (seat.extra as { ice_servers: Array<RTCIceServer> }).ice_servers
		});
		const turn = { urls: 'turn:turn.fuz.dev', username: 'u', credential: 'c' };
		room.take_seat(a.member_id, [a, member()], 'mesh', { ice_servers: [turn] });
		assert.strictEqual(mesh.peers.size, 1);
		assert.deepEqual(net.connections[0]!.configuration.iceServers, [turn]);
	});
});

describe('RtcMesh over RoomState', () => {
	test('an offer that arrives before the join answer reaches the peer the answer makes', async () => {
		const fake = create_fake_room_rpc();
		const client = new RoomClient(fake.rpc);
		client.sync_connection();
		const room = client.room(ROOM_ID);
		const { deps, connections } = create_fake_rtc_deps();
		const mesh = new RtcMesh(deps, { room });

		const [low, high] = [create_uuid(), create_uuid()].sort() as [MemberId, MemberId];
		// the far end is impolite (the higher id), so it offers first
		const far = create_fake_rtc_deps();
		const far_signals: Array<RtcSignal> = [];
		const far_peer = new RtcPeer(far.deps, {
			remote_member_id: low,
			polite: false,
			send: (s) => far_signals.push(s)
		});
		await settle();
		const offer = far_signals.shift()!;

		const joined = room.join();
		await settle();
		client.receive('room_message', {
			room_id: ROOM_ID,
			seq: 6,
			from: high,
			to: low,
			payload: encode_rtc_signal(offer)
		});
		fake.take('room_join').resolve(join_output(ROOM_ID, low, 5, [member(high), member(low)]));
		await joined;
		await settle();

		assert.ok(mesh.peers.get(high));
		const [pc] = connections;
		assert.strictEqual(pc!.answers, 1);
		const send = fake.take('room_send');
		assert.strictEqual(send.input.to, high);
		const answer = decode_rtc_signal(send.input.payload as string);
		assert.ok(answer.ok && 'description' in answer.value);
		await far_peer.on_signal(answer.value);
		assert.strictEqual(far.connections[0]!.connectionState, 'connected');
	});
});
