/**
 * Fakes for the WebRTC tests: a scripted `RTCPeerConnection` that models
 * signaling states well enough for perfect negotiation — offers, answers,
 * implicit rollback, crossing offers, the negotiation-needed flag, ICE
 * credentials and their restart, candidates refused before a remote
 * description — plus fake tracks, and `RtcPeerDeps` over them and fake
 * timers (`../fake_timers.ts`).
 *
 * A fake session description's `sdp` is JSON: the ICE username fragment and
 * the media sections (`mid`, kind, direction). Nothing connects for real: a
 * fake reports `connected` once a negotiation completes, and a test drives
 * ICE states and candidates by hand.
 *
 * As in a browser, the description and candidate operations run one at a
 * time on an operations chain, so one called while another is in flight
 * waits for it. A test holds one in flight with `hold_next`.
 *
 * @module
 */

import type { RtcPeerDeps } from '#lib/rtc/rtc_peer.svelte.ts';

import { create_fake_timers, type FakeTimers } from '../fake_timers.ts';

type Kind = 'audio' | 'video';

interface FakeMedia {
	mid: string;
	kind: Kind;
	direction: RTCRtpTransceiverDirection;
}

interface FakeSdp {
	ufrag: string;
	media: Array<FakeMedia>;
}

const encode_sdp = (sdp: FakeSdp): string => JSON.stringify(sdp);
const decode_sdp = (sdp: string): FakeSdp => JSON.parse(sdp) as FakeSdp;

const sends = (direction: RTCRtpTransceiverDirection): boolean =>
	direction === 'sendrecv' || direction === 'sendonly';

const tick = (): Promise<void> => Promise.resolve();

/** The chained operations a test can hold with `FakePeerConnection.hold_next`. */
export type FakeHeldOperation = 'setLocalDescription' | 'setRemoteDescription' | 'addIceCandidate';

let track_count = 0;

/** A fake track of `kind` — a plain object, for identity and kind checks. */
export const create_fake_track = (kind: Kind = 'audio'): MediaStreamTrack =>
	({ kind, id: `track_${++track_count}`, enabled: true, readyState: 'live' }) as MediaStreamTrack;

export class FakeSender {
	track: MediaStreamTrack | null = null;
	readonly replaced: Array<MediaStreamTrack | null> = [];
	readonly #kind: Kind;
	readonly #pc: FakePeerConnection;

	constructor(kind: Kind, pc: FakePeerConnection) {
		this.#kind = kind;
		this.#pc = pc;
	}

	async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
		await tick();
		if (this.#pc.closed) throw new DOMException('closed', 'InvalidStateError');
		if (track && track.kind !== this.#kind) throw new TypeError('track kind mismatch');
		this.track = track;
		this.replaced.push(track);
	}
}

export class FakeTransceiver {
	mid: string | null = null;
	direction: RTCRtpTransceiverDirection;
	readonly sender: FakeSender;
	readonly receiver: { track: MediaStreamTrack };
	/** Whether the remote description has reached this transceiver with media (its `track` event fired). */
	receiving = false;

	constructor(kind: Kind, direction: RTCRtpTransceiverDirection, pc: FakePeerConnection) {
		this.direction = direction;
		this.sender = new FakeSender(kind, pc);
		this.receiver = { track: create_fake_track(kind) };
	}
}

/** A scripted `RTCPeerConnection`; see the module doc. */
export class FakePeerConnection extends EventTarget {
	readonly configuration: RTCConfiguration;
	readonly label: string;

	signalingState: RTCSignalingState = 'stable';
	connectionState: RTCPeerConnectionState = 'new';
	iceConnectionState: RTCIceConnectionState = 'new';
	localDescription: RTCSessionDescriptionInit | null = null;
	remoteDescription: RTCSessionDescriptionInit | null = null;
	closed = false;

	/** This end's current ICE username fragment. */
	ufrag: string;
	/** The far end's, from the last remote description. */
	remote_ufrag: string | null = null;

	offers = 0;
	answers = 0;
	rollbacks = 0;
	negotiations_needed = 0;
	restarts = 0;
	/** Calls of the connection's methods made after `close`. */
	calls_after_close = 0;
	readonly added_candidates: Array<RTCIceCandidateInit> = [];

	readonly #transceivers: Array<FakeTransceiver> = [];
	#stable_local: RTCSessionDescriptionInit | null = null;
	#offer_ufrag: string | null = null;
	#restart_pending = false;
	#ufrag_count = 0;
	#mid_count = 0;
	#negotiation_queued = false;
	#operations: Promise<unknown> = Promise.resolve();
	readonly #holds: Map<FakeHeldOperation, { phase: 'before' | 'after'; gate: Promise<void> }> =
		new Map();

	constructor(configuration: RTCConfiguration, label: string) {
		super();
		this.configuration = configuration;
		this.label = label;
		this.ufrag = `${label}_u0`;
	}

	addTransceiver(kind: Kind, init?: RTCRtpTransceiverInit): FakeTransceiver {
		this.#note_call();
		this.#assert_open();
		const transceiver = new FakeTransceiver(kind, init?.direction ?? 'sendrecv', this);
		this.#transceivers.push(transceiver);
		this.#queue_negotiation();
		return transceiver;
	}

	getTransceivers(): Array<FakeTransceiver> {
		return [...this.#transceivers];
	}

	setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
		this.#note_call();
		return this.#chain('setLocalDescription', () => this.#set_local(description));
	}

	setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
		this.#note_call();
		return this.#chain('setRemoteDescription', () => this.#set_remote(description));
	}

	addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
		this.#note_call();
		return this.#chain('addIceCandidate', () => this.#add_candidate(candidate));
	}

	async #set_local(description?: RTCLocalSessionDescriptionInit): Promise<void> {
		await tick();
		this.#assert_open();
		if (description?.type === 'rollback') {
			if (this.signalingState !== 'have-local-offer') throw invalid_state('rollback');
			this.#rollback();
			return;
		}
		if (this.signalingState === 'stable' || this.signalingState === 'have-local-offer') {
			for (const t of this.#transceivers) if (t.mid === null) t.mid = String(this.#mid_count++);
			this.#offer_ufrag = this.#restart_pending ? this.#next_ufrag() : this.ufrag;
			this.localDescription = {
				type: 'offer',
				sdp: encode_sdp({ ufrag: this.#offer_ufrag, media: this.#local_media() })
			};
			this.offers++;
			this.#set_signaling('have-local-offer');
		} else if (this.signalingState === 'have-remote-offer') {
			const remote = decode_sdp(this.remoteDescription!.sdp!);
			// answering a restart restarts this end's credentials too
			if (this.#restart_pending || remote.ufrag !== this.remote_ufrag) {
				this.ufrag = this.#next_ufrag();
				this.#restart_pending = false;
			}
			this.remote_ufrag = remote.ufrag;
			const media = remote.media.map((m) => ({
				mid: m.mid,
				kind: m.kind,
				direction: this.#transceivers.find((t) => t.mid === m.mid)!.direction
			}));
			this.localDescription = { type: 'answer', sdp: encode_sdp({ ufrag: this.ufrag, media }) };
			this.answers++;
			this.#stable_local = this.localDescription;
			this.#set_signaling('stable');
			this.#negotiated();
		} else {
			throw invalid_state('setLocalDescription');
		}
	}

	async #set_remote(description: RTCSessionDescriptionInit): Promise<void> {
		await tick();
		this.#assert_open();
		const sdp = decode_sdp(description.sdp!);
		if (description.type === 'offer') {
			if (this.signalingState === 'have-local-offer') this.#rollback(); // implicit rollback
			else if (this.signalingState !== 'stable') throw invalid_state('offer');
			for (const m of sdp.media) {
				let t = this.#transceivers.find((x) => x.mid === m.mid);
				if (!t) {
					// a transceiver made by `addTransceiver` is never matched to a remote section
					t = new FakeTransceiver(m.kind, 'recvonly', this);
					t.mid = m.mid;
					this.#transceivers.push(t);
				}
				this.#receive_media(t, m);
			}
			this.remoteDescription = description;
			this.#set_signaling('have-remote-offer');
		} else if (description.type === 'answer') {
			if (this.signalingState !== 'have-local-offer') throw invalid_state('answer');
			for (const m of sdp.media) {
				const t = this.#transceivers.find((x) => x.mid === m.mid);
				if (t) this.#receive_media(t, m);
			}
			this.remoteDescription = description;
			this.remote_ufrag = sdp.ufrag;
			if (this.#offer_ufrag !== this.ufrag) {
				this.ufrag = this.#offer_ufrag!;
				this.restarts++;
			}
			this.#restart_pending = false;
			this.#stable_local = this.localDescription;
			this.#set_signaling('stable');
			this.#negotiated();
		} else {
			throw invalid_state(`remote ${description.type}`);
		}
	}

	async #add_candidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
		await tick();
		this.#assert_open();
		if (!this.remoteDescription) throw invalid_state('addIceCandidate before a remote description');
		const remote = decode_sdp(this.remoteDescription.sdp!);
		if (candidate?.usernameFragment && candidate.usernameFragment !== remote.ufrag) {
			throw new DOMException('unknown ufrag', 'OperationError');
		}
		if (candidate) this.added_candidates.push(candidate);
	}

	restartIce(): void {
		this.#note_call();
		this.#restart_pending = true;
		this.#queue_negotiation();
	}

	close(): void {
		this.closed = true;
		this.signalingState = 'closed';
		this.connectionState = 'closed';
		this.iceConnectionState = 'closed';
	}

	// -- test controls --------------------------------------------------------------

	/**
	 * Hold the next call of `operation` in flight until the returned release is
	 * called: `before` its work (the state unchanged meanwhile), or `after` it
	 * (the work done, the promise not yet settled). Later operations wait
	 * behind it on the chain.
	 */
	hold_next(operation: FakeHeldOperation, phase: 'before' | 'after' = 'before'): () => void {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		this.#holds.set(operation, { phase, gate });
		return release;
	}

	/** Gather a candidate: fires `icecandidate` with this end's current ufrag. */
	emit_candidate(candidate = `candidate:${this.label}`): RTCIceCandidateInit {
		const init: RTCIceCandidateInit = {
			candidate,
			sdpMid: '0',
			sdpMLineIndex: 0,
			usernameFragment: this.#offer_ufrag ?? this.ufrag
		};
		const event = new Event('icecandidate');
		Object.assign(event, { candidate: { ...init, toJSON: () => init } });
		this.dispatchEvent(event);
		return init;
	}

	/** Fire the end-of-candidates `icecandidate`, whose candidate is `null`. */
	emit_end_of_candidates(): void {
		const event = new Event('icecandidate');
		Object.assign(event, { candidate: null });
		this.dispatchEvent(event);
	}

	set_ice_connection_state(state: RTCIceConnectionState): void {
		this.iceConnectionState = state;
		this.dispatchEvent(new Event('iceconnectionstatechange'));
	}

	// -- internals -----------------------------------------------------------------

	/** Run `work` once every earlier operation has settled, held as `hold_next` set. */
	#chain(operation: FakeHeldOperation, work: () => Promise<void>): Promise<void> {
		const run = this.#operations.then(async () => {
			const hold = this.#holds.get(operation);
			if (!hold) return work();
			this.#holds.delete(operation);
			if (hold.phase === 'before') {
				await hold.gate;
				return work();
			}
			await work();
			await hold.gate;
		});
		this.#operations = run.catch(() => undefined);
		return run;
	}

	#note_call(): void {
		if (this.closed) this.calls_after_close++;
	}

	#receive_media(t: FakeTransceiver, m: FakeMedia): void {
		if (!sends(m.direction) || t.receiving) return;
		t.receiving = true;
		const event = new Event('track');
		Object.assign(event, {
			track: t.receiver.track,
			transceiver: t,
			receiver: t.receiver,
			streams: []
		});
		this.dispatchEvent(event);
	}

	#local_media(): Array<FakeMedia> {
		return this.#transceivers.map((t) => ({
			mid: t.mid!,
			kind: t.receiver.track.kind as Kind,
			direction: t.direction
		}));
	}

	#rollback(): void {
		this.rollbacks++;
		this.localDescription = this.#stable_local;
		this.#offer_ufrag = null;
		this.#set_signaling('stable');
		this.#queue_negotiation();
	}

	#negotiated(): void {
		if (this.connectionState !== 'connected') {
			this.connectionState = 'connected';
			this.dispatchEvent(new Event('connectionstatechange'));
		}
		if (this.iceConnectionState !== 'connected') this.set_ice_connection_state('connected');
		this.#queue_negotiation();
	}

	#needs_negotiation(): boolean {
		return this.#restart_pending || this.#transceivers.some((t) => t.mid === null);
	}

	#queue_negotiation(): void {
		if (this.#negotiation_queued) return;
		this.#negotiation_queued = true;
		queueMicrotask(() => {
			this.#negotiation_queued = false;
			if (this.closed || this.signalingState !== 'stable' || !this.#needs_negotiation()) return;
			this.negotiations_needed++;
			this.dispatchEvent(new Event('negotiationneeded'));
		});
	}

	#set_signaling(state: RTCSignalingState): void {
		if (this.signalingState === state) return;
		this.signalingState = state;
		this.dispatchEvent(new Event('signalingstatechange'));
	}

	#next_ufrag(): string {
		return `${this.label}_u${++this.#ufrag_count}`;
	}

	#assert_open(): void {
		if (this.closed) throw invalid_state('closed');
	}
}

const invalid_state = (what: string): DOMException =>
	new DOMException(`invalid state: ${what}`, 'InvalidStateError');

/** `RtcPeerDeps` over fakes, keeping every connection made, in order. */
export const create_fake_rtc_deps = (): {
	deps: RtcPeerDeps;
	connections: Array<FakePeerConnection>;
	timers: FakeTimers;
} => {
	const connections: Array<FakePeerConnection> = [];
	const timers = create_fake_timers();
	const deps: RtcPeerDeps = {
		create_peer_connection: (configuration) => {
			const pc = new FakePeerConnection(configuration, `pc${connections.length}`);
			connections.push(pc);
			return pc as unknown as RTCPeerConnection;
		},
		set_timeout: timers.set_timeout,
		clear_timeout: timers.clear_timeout,
		log: null
	};
	return { deps, connections, timers };
};
