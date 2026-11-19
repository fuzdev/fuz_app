/**
 * A full-mesh call over one room: `RtcMesh` keeps an `RtcPeer` to every other
 * member of the room while the caller holds a seat in it, carrying the peers'
 * signals as room payloads (`rtc/rtc_signal.ts`) and fanning the local tracks
 * out to every peer.
 *
 * The room is any `RtcMeshRoom` — `RoomClient`'s `RoomState` is one. The mesh
 * follows its seat: when a seat is taken it connects to each member the join
 * answered, then to each member who joins after; a member who leaves has its
 * peer closed; when the seat ends (left, lost, or the socket closed) every
 * peer closes, and a seat taken again (a rejoin after a reconnect, with a new
 * member id) connects afresh. The local tracks outlive the seats: each new
 * peer starts with them.
 *
 * Only the `mesh` topology is connected: a seat whose join answers another
 * one sets `error` and connects nothing, since an SFU member needs a
 * different client. A peer that can't be made (`new RTCPeerConnection`
 * refusing a malformed ICE server, say) sets `error` too, and the mesh
 * carries on without it.
 *
 * A connection serving several actors hears each room message once, whoever
 * it is for, so a message addressed to another member is not this mesh's
 * and is dropped.
 *
 * ## Sends, one at a time per peer
 *
 * The server dispatches a socket's requests concurrently, so two `room_send`
 * requests can relay out of order — a candidate ahead of the offer it belongs
 * to. Each peer's signals therefore go through one chain: a send waits for the
 * previous one's answer. Peers don't wait on each other.
 *
 * ## ICE servers
 *
 * `ice_servers` is a list, or a function of the seat, so servers the join
 * answer carries in its `extra` (short-lived TURN credentials, minted per
 * join) can be read there.
 *
 * @module
 */

import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import type { MemberId, RoomMember, RoomMessageParams } from '../actions/room_action_specs.ts';
import type {
	RoomListener,
	RoomRpcResult,
	RoomSeat,
	RoomUnseatedReason
} from '../actions/room_client.svelte.ts';
import { decode_rtc_signal, encode_rtc_signal, type RtcSignal } from './rtc_signal.ts';
import {
	RTC_VOICE_SLOTS,
	RtcPeer,
	rtc_peer_is_polite,
	type RtcPeerDeps,
	type RtcSlot
} from './rtc_peer.svelte.ts';

/** What the mesh needs of a room — `RoomState` satisfies it. */
export interface RtcMeshRoom {
	/** The caller's seat, `null` while it holds none. */
	readonly seat: RoomSeat | null;
	/** The room's members, the caller's own seat included. */
	readonly members: ReadonlyArray<RoomMember>;
	/** Subscribe to the room's events; returns the remover. */
	add_listener: (listener: RoomListener) => () => void;
	/** Relay a payload to one member. */
	send: (to: MemberId, payload: string) => Promise<RoomRpcResult<null>>;
}

/** Options for `RtcMesh`. */
export interface RtcMeshOptions {
	room: RtcMeshRoom;
	/**
	 * The media slots every peer carries, the same list on every member's end.
	 *
	 * @default RTC_VOICE_SLOTS
	 */
	slots?: ReadonlyArray<RtcSlot>;
	/** The ICE servers, or a function of the seat that reads them (from its `extra`, say). */
	ice_servers?: ReadonlyArray<RTCIceServer> | ((seat: RoomSeat) => ReadonlyArray<RTCIceServer>);
	/** See `RtcPeerOptions.ice_disconnected_restart_ms`. */
	ice_disconnected_restart_ms?: number | null;
}

/** The peers of a full-mesh call over one room. See the module doc. */
export class RtcMesh {
	readonly slots: ReadonlyArray<RtcSlot>;

	/** A peer for each other member while seated, by member id. */
	readonly peers: SvelteMap<MemberId, RtcPeer> = new SvelteMap();
	/** The seat's member id while connected, else `null`. */
	local_member_id: MemberId | null = $state.raw(null);
	/**
	 * Why the mesh connects nothing (an unsupported topology), or the last peer
	 * that couldn't be made, else `null`; cleared by the next seat.
	 */
	error: string | null = $state.raw(null);
	/** Whether `close` was called. */
	closed: boolean = $state.raw(false);

	readonly #deps: RtcPeerDeps;
	readonly #room: RtcMeshRoom;
	readonly #options: RtcMeshOptions;
	readonly #remove_listener: () => void;
	readonly #local_tracks: Map<string, MediaStreamTrack | null> = new Map();
	readonly #send_chains: Map<MemberId, Promise<void>> = new Map();
	#ice_servers: ReadonlyArray<RTCIceServer> = [];

	constructor(deps: RtcPeerDeps, options: RtcMeshOptions) {
		this.#deps = deps;
		this.#room = options.room;
		this.#options = options;
		this.slots = options.slots ?? RTC_VOICE_SLOTS;
		this.#remove_listener = this.#room.add_listener({
			seated: (seat) => this.#start(seat),
			unseated: (seat, reason) => this.#stop(seat, reason),
			member_joined: (member) => this.#add_peer(member.member_id),
			member_left: (member_id) => this.#remove_peer(member_id),
			message: (message) => this.#receive(message)
		});
		// untracked, so an `$effect` that makes the mesh doesn't depend on the room's seat or members
		untrack(() => {
			const { seat } = this.#room;
			if (seat) this.#start(seat);
		});
	}

	/**
	 * Send `track` in `slot` to every peer, and to each peer made later; `null`
	 * sends nothing there. No renegotiation: each peer replaces its slot's track.
	 *
	 * @param slot - the slot's name
	 * @param track - the track, of the slot's kind, or `null`
	 * @throws Error when no slot has that name
	 */
	async set_track(slot: string, track: MediaStreamTrack | null): Promise<void> {
		if (!this.slots.some((s) => s.name === slot)) {
			throw new Error(`RtcMesh: no slot named '${slot}'`);
		}
		this.#local_tracks.set(slot, track);
		// untracked, peers and their own state both, so an `$effect` that sets a
		// track doesn't re-run when a peer comes or goes
		await untrack(() =>
			Promise.all([...this.peers.values()].map((peer) => this.#set_peer_track(peer, slot, track)))
		);
	}

	/**
	 * Close every peer and stop following the room. The local tracks are the
	 * caller's and stay live.
	 *
	 * @mutates this - sets `closed`, empties `peers`
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.#remove_listener();
		this.#close_peers();
		this.local_member_id = null;
	}

	#start(seat: RoomSeat): void {
		if (this.closed) return;
		this.#close_peers();
		this.local_member_id = null;
		if ((seat.topology as string) !== 'mesh') {
			this.error = `unsupported room topology '${seat.topology}': RtcMesh connects only 'mesh' rooms`;
			return;
		}
		this.error = null;
		const { ice_servers } = this.#options;
		try {
			this.#ice_servers =
				typeof ice_servers === 'function' ? ice_servers(seat) : (ice_servers ?? []);
		} catch (error) {
			this.#set_error(`the ICE servers couldn't be read: ${to_error_message(error)}`, error);
			return;
		}
		this.local_member_id = seat.member_id;
		for (const member of this.#room.members) this.#add_peer(member.member_id);
	}

	#stop(seat: RoomSeat, reason: RoomUnseatedReason): void {
		if (seat.member_id !== this.local_member_id) return;
		this.#deps.log?.debug('[rtc_mesh] seat ended:', reason);
		this.#close_peers();
		this.local_member_id = null;
	}

	#add_peer(member_id: MemberId): void {
		const local = this.local_member_id;
		if (this.closed || local === null || member_id === local || this.peers.has(member_id)) return;
		let peer: RtcPeer;
		try {
			peer = new RtcPeer(this.#deps, {
				remote_member_id: member_id,
				polite: rtc_peer_is_polite(local, member_id),
				slots: this.slots,
				ice_servers: this.#ice_servers,
				ice_disconnected_restart_ms: this.#options.ice_disconnected_restart_ms,
				send: (signal) => this.#send(peer, signal)
			});
		} catch (error) {
			this.#set_error(
				`a peer for ${member_id} couldn't be made: ${to_error_message(error)}`,
				error
			);
			return;
		}
		this.peers.set(member_id, peer);
		for (const [slot, track] of this.#local_tracks) {
			if (track) void this.#set_peer_track(peer, slot, track);
		}
	}

	/** Set one peer's track, logging a failed `replaceTrack` rather than throwing. */
	#set_peer_track(peer: RtcPeer, slot: string, track: MediaStreamTrack | null): Promise<void> {
		return peer.set_track(slot, track).catch((error: unknown) => {
			this.#deps.log?.warn('[rtc_mesh] replaceTrack failed:', peer.remote_member_id, error);
		});
	}

	#remove_peer(member_id: MemberId): void {
		const peer = this.peers.get(member_id);
		if (!peer) return;
		this.peers.delete(member_id);
		this.#send_chains.delete(member_id);
		peer.close();
	}

	#close_peers(): void {
		for (const peer of this.peers.values()) peer.close();
		this.peers.clear();
		this.#send_chains.clear();
	}

	/** Queue a signal behind the peer's previous send, dropped once the peer is gone. */
	#send(peer: RtcPeer, signal: RtcSignal): void {
		const member_id = peer.remote_member_id;
		const payload = encode_rtc_signal(signal);
		const previous = this.#send_chains.get(member_id) ?? Promise.resolve();
		const next = previous.then(async () => {
			if (this.peers.get(member_id) !== peer) return;
			const result = await this.#room.send(member_id, payload);
			if (!result.ok && this.peers.get(member_id) === peer) {
				this.#deps.log?.warn('[rtc_mesh] signal send refused:', member_id, result.error);
			}
		});
		this.#send_chains.set(
			member_id,
			next.catch((error: unknown) => {
				this.#deps.log?.error('[rtc_mesh] signal send failed:', member_id, error);
			})
		);
	}

	#set_error(message: string, error: unknown): void {
		this.error = message;
		this.#deps.log?.error('[rtc_mesh]', message, error);
	}

	#receive(message: RoomMessageParams): void {
		if (this.local_member_id === null) return;
		// another actor's seat on the same connection
		if (message.to !== null && message.to !== this.local_member_id) return;
		const decoded = decode_rtc_signal(message.payload);
		if (!decoded.ok) {
			if (decoded.reason !== 'not_rtc_signal') {
				this.#deps.log?.warn('[rtc_mesh] signal refused:', message.from, decoded.reason);
			}
			return;
		}
		const peer = this.peers.get(message.from);
		if (!peer) {
			this.#deps.log?.debug('[rtc_mesh] signal from a member with no peer:', message.from);
			return;
		}
		void peer.on_signal(decoded.value);
	}
}
