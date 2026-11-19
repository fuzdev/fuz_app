/**
 * One WebRTC connection to one remote member: `RtcPeer`, over an injected
 * `RTCPeerConnection`, exchanging signals through a `send` function and an
 * `on_signal` entry rather than any transport, so two peers cross-wire in a
 * test and a room carries them in the app (`rtc/rtc_mesh.svelte.ts`).
 *
 * ## Perfect negotiation
 *
 * Either end may need to renegotiate at any time (an ICE restart, say), so the
 * two follow the perfect negotiation pattern: each sends an offer whenever its
 * connection says negotiation is needed, and when two offers cross, the
 * **polite** end rolls its own back and answers the other's, while the
 * **impolite** end ignores the offer it receives. Which end is polite is a
 * pure function of the two member ids (`rtc_peer_is_polite`), so both agree
 * without a word: the lower id is polite.
 *
 * Candidates that arrive before the remote description is set are queued and
 * added once it is — a candidate is meaningless without one, and the
 * connection refuses it. Candidates that arrive while the impolite end is
 * ignoring an offer may belong to it and fail to add, queued or not; that
 * failure is expected and dropped.
 *
 * Inbound signals are handled one at a time, in the order they arrive. A
 * caller that delivers them over a channel that can reorder (concurrently
 * dispatched requests) serializes its sends per peer, as `RtcMesh` does.
 * Since no signal is handled while another's remote answer is being applied,
 * the standard pattern's "setting a remote answer" flag would never read true
 * here, and there is none.
 *
 * Once `close` is called, nothing more reaches the connection, and a failure
 * of work in flight at the close is expected and not recorded.
 *
 * ## Fixed transceiver slots
 *
 * The media a peer carries is a fixed list of slots (`RtcSlot`), each one
 * `sendrecv` transceiver of one kind: `RTC_VOICE_SLOTS` is the microphone's
 * audio; camera, screen, and screen audio are further slots of the same shape,
 * added to the list when they land. Every slot exists from the start, so
 * turning a source on or off is `set_track` — a `replaceTrack` on the slot's
 * sender, with no renegotiation — and a slot with no track sends nothing.
 *
 * The impolite end creates the transceivers, in slot order, and its first
 * offer carries them; the polite end adopts the transceivers that offer
 * creates on its side, by position, sets them `sendrecv`, and answers. Both
 * ends creating their own would give each side two transceivers per slot,
 * since a transceiver made by `addTransceiver` is never matched to a remote
 * offer's media section. So both ends must use the same slot list.
 *
 * Two ends whose lists differ degrade rather than fail: a slot the offer has
 * no media section for stays empty (no transceiver, its track kept unsent), a
 * media section past the polite end's slots stays `recvonly` and unnamed, and
 * a section whose kind differs from its slot's is logged and skipped, that
 * slot staying empty. The slot list is protocol: changing its shape (the
 * slots, their order, or their kinds) bumps `RTC_SIGNAL_VERSION`
 * (`rtc/rtc_signal.ts`), so mismatched ends refuse each other's signals
 * instead of degrading.
 *
 * Remote media is `remote_tracks`, by slot name: the receiver's track for each
 * slot once the far end's description reaches it (muted while the far end
 * sends nothing on it).
 *
 * ## ICE restart
 *
 * When ICE fails, the peer restarts it (`restartIce`, which renegotiates with
 * new credentials through the same pattern). A connection that stays
 * `disconnected` past `ice_disconnected_restart_ms` is restarted too, since a
 * disconnect is often a network change that ICE alone won't recover from.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import type { MemberId } from '../actions/room_action_specs.ts';
import type { RtcIceCandidate, RtcSignal } from './rtc_signal.ts';

/** One media slot of a peer connection: a name, and the kind of track it carries. */
export interface RtcSlot {
	name: string;
	kind: 'audio' | 'video';
}

/**
 * The slots of a voice call: the microphone's audio. A call with video adds
 * slots after it (camera, screen, screen audio), in an order both ends share.
 */
export const RTC_VOICE_SLOTS: ReadonlyArray<RtcSlot> = [{ name: 'mic', kind: 'audio' }];

/**
 * Default `RtcPeerOptions.ice_disconnected_restart_ms`: long enough for a
 * brief network blip to recover on its own.
 */
export const RTC_ICE_DISCONNECTED_RESTART_MS = 5_000;

/**
 * Whether the local end is the polite one of a pair: the lower member id is
 * polite. Both ends compute it alike, so they always disagree on who yields.
 *
 * @param local_member_id - this end's member id
 * @param remote_member_id - the far end's
 * @returns whether this end yields when offers cross
 */
export const rtc_peer_is_polite = (
	local_member_id: MemberId,
	remote_member_id: MemberId
): boolean => local_member_id < remote_member_id;

/** The side effects a peer runs on. */
export interface RtcPeerDeps {
	/** `new RTCPeerConnection(configuration)`. */
	create_peer_connection: (configuration: RTCConfiguration) => RTCPeerConnection;
	/** `setTimeout`. */
	set_timeout: (callback: () => void, ms: number) => unknown;
	/** `clearTimeout`, given what `set_timeout` returned. */
	clear_timeout: (handle: unknown) => void;
	/** Where negotiation diagnostics go; `null` or omitted, nowhere. */
	log?: Logger | null;
}

/** `RtcPeerDeps` over the browser's own globals, each read when it's called. */
export const create_rtc_peer_deps = (log?: Logger | null): RtcPeerDeps => ({
	create_peer_connection: (configuration) => new RTCPeerConnection(configuration),
	set_timeout: (callback, ms) => setTimeout(callback, ms),
	clear_timeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	log
});

/** Options for `RtcPeer`. */
export interface RtcPeerOptions {
	/** The far end's member id. */
	remote_member_id: MemberId;
	/** Whether this end yields when offers cross — `rtc_peer_is_polite`. */
	polite: boolean;
	/** The media slots, the same list on both ends. */
	slots?: ReadonlyArray<RtcSlot>;
	/** The ICE servers (STUN, TURN); none, host candidates only. */
	ice_servers?: ReadonlyArray<RTCIceServer>;
	/**
	 * Deliver a signal to the far end's `on_signal`, in the order given. Called
	 * synchronously; it must not throw.
	 */
	send: (signal: RtcSignal) => void;
	/**
	 * How long ICE may stay `disconnected` before the peer restarts it; `null`
	 * restarts only on `failed`.
	 *
	 * @default RTC_ICE_DISCONNECTED_RESTART_MS
	 */
	ice_disconnected_restart_ms?: number | null;
}

/** One connection to one remote member. See the module doc. */
export class RtcPeer {
	readonly remote_member_id: MemberId;
	readonly polite: boolean;
	readonly slots: ReadonlyArray<RtcSlot>;

	/** The connection's `connectionState`. */
	connection_state: RTCPeerConnectionState = $state.raw('new');
	/** The connection's `iceConnectionState`. */
	ice_connection_state: RTCIceConnectionState = $state.raw('new');
	/** The connection's `signalingState`. */
	signaling_state: RTCSignalingState = $state.raw('stable');
	/** The far end's track for each slot, by slot name, `null` until its description reaches it. */
	remote_tracks: Readonly<Record<string, MediaStreamTrack | null>> = $state.raw({});
	/** Whether `close` was called. */
	closed: boolean = $state.raw(false);
	/** The last negotiation failure, for diagnostics. */
	last_error: string | null = $state.raw(null);

	readonly #deps: RtcPeerDeps;
	readonly #pc: RTCPeerConnection;
	readonly #send: (signal: RtcSignal) => void;
	readonly #listeners: AbortController = new AbortController();
	readonly #ice_disconnected_restart_ms: number | null;

	/** Each slot's transceiver, `null` on the polite end until the first offer brings it. */
	readonly #transceivers: Array<RTCRtpTransceiver | null>;
	/** Each slot's local track, applied to its transceiver whenever there is one. */
	readonly #local_tracks: Array<MediaStreamTrack | null>;

	#making_offer = false;
	#ignore_offer = false;
	/** Candidates waiting for a remote description, each with whether an offer was being ignored as it arrived. */
	#pending_candidates: Array<{ candidate: RtcIceCandidate; ignoring: boolean }> = [];
	#inbound: Promise<void> = Promise.resolve();
	#disconnected_timer: unknown = null;

	constructor(deps: RtcPeerDeps, options: RtcPeerOptions) {
		this.#deps = deps;
		this.remote_member_id = options.remote_member_id;
		this.polite = options.polite;
		this.slots = options.slots ?? RTC_VOICE_SLOTS;
		this.#send = options.send;
		this.#ice_disconnected_restart_ms =
			options.ice_disconnected_restart_ms === undefined
				? RTC_ICE_DISCONNECTED_RESTART_MS
				: options.ice_disconnected_restart_ms;
		this.#transceivers = this.slots.map(() => null);
		this.#local_tracks = this.slots.map(() => null);
		this.remote_tracks = Object.fromEntries(this.slots.map((s) => [s.name, null]));

		const pc = deps.create_peer_connection({ iceServers: [...(options.ice_servers ?? [])] });
		this.#pc = pc;
		const signal = this.#listeners.signal;
		pc.addEventListener('negotiationneeded', () => void this.#negotiate(), { signal });
		pc.addEventListener('icecandidate', (e) => this.#on_ice_candidate(e), { signal });
		pc.addEventListener('track', (e) => this.#on_track(e), { signal });
		pc.addEventListener(
			'connectionstatechange',
			() => (this.connection_state = pc.connectionState),
			{ signal }
		);
		pc.addEventListener('signalingstatechange', () => (this.signaling_state = pc.signalingState), {
			signal
		});
		pc.addEventListener('iceconnectionstatechange', () => this.#on_ice_state(), { signal });

		// the impolite end creates the slots; its first offer carries them
		if (!this.polite) {
			try {
				this.slots.forEach((slot, i) => {
					this.#transceivers[i] = pc.addTransceiver(slot.kind, { direction: 'sendrecv' });
				});
			} catch (error) {
				// a peer that can't be made leaves no connection open behind it
				this.#listeners.abort();
				pc.close();
				throw error;
			}
		}
	}

	/**
	 * Take a signal from the far end. Signals are handled one at a time, in
	 * call order; a failure is logged and kept in `last_error`, never thrown.
	 *
	 * @returns resolves once this signal is handled
	 */
	on_signal(signal: RtcSignal): Promise<void> {
		const handled = this.#inbound.then(() => this.#handle(signal));
		this.#inbound = handled;
		return handled;
	}

	/**
	 * Send `track` in `slot` (`null` sends nothing) — a `replaceTrack`, never a
	 * renegotiation. On the polite end before the first offer, the track is
	 * kept and sent once the slot's transceiver arrives.
	 *
	 * @param slot - the slot's name
	 * @param track - the track, of the slot's kind, or `null`
	 * @throws Error when no slot has that name
	 */
	async set_track(slot: string, track: MediaStreamTrack | null): Promise<void> {
		const index = this.slots.findIndex((s) => s.name === slot);
		if (index === -1) throw new Error(`RtcPeer: no slot named '${slot}'`);
		this.#local_tracks[index] = track;
		const transceiver = this.#transceivers[index];
		if (!transceiver || this.closed) return;
		await transceiver.sender.replaceTrack(track);
	}

	/** Restart ICE: a renegotiation with new credentials. */
	restart_ice(): void {
		if (this.closed) return;
		this.#clear_disconnected_timer();
		this.#deps.log?.debug('[rtc_peer] ICE restart:', this.remote_member_id);
		this.#pc.restartIce();
	}

	/**
	 * Close the connection. Idempotent; local tracks are the caller's and stay
	 * live.
	 *
	 * @mutates this - sets `closed`, clears `remote_tracks`
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.#listeners.abort();
		this.#clear_disconnected_timer();
		this.#pending_candidates = [];
		this.#pc.close();
		this.connection_state = 'closed';
		this.signaling_state = 'closed';
		this.remote_tracks = Object.fromEntries(this.slots.map((s) => [s.name, null]));
	}

	async #negotiate(): Promise<void> {
		if (this.closed) return;
		try {
			this.#making_offer = true;
			await this.#pc.setLocalDescription();
			if (this.closed) return;
			this.#send_local_description();
		} catch (error) {
			this.#fail('offer', error);
		} finally {
			this.#making_offer = false;
		}
	}

	async #handle(signal: RtcSignal): Promise<void> {
		if (this.closed) return;
		const pc = this.#pc;
		try {
			if ('description' in signal) {
				const { description } = signal;
				const ready_for_offer = !this.#making_offer && pc.signalingState === 'stable';
				const collision = description.type === 'offer' && !ready_for_offer;
				this.#ignore_offer = !this.polite && collision;
				if (this.#ignore_offer) {
					this.#deps.log?.debug('[rtc_peer] ignored a crossing offer:', this.remote_member_id);
					return;
				}
				// on the polite end a crossing offer rolls its own back implicitly
				await pc.setRemoteDescription(description);
				if (this.closed) return;
				if (description.type === 'offer') {
					this.#adopt_transceivers();
					await pc.setLocalDescription();
					if (this.closed) return;
					this.#send_local_description();
				}
				await this.#flush_candidates();
			} else if (pc.remoteDescription === null) {
				this.#pending_candidates.push({
					candidate: signal.candidate,
					ignoring: this.#ignore_offer
				});
			} else {
				await this.#add_candidate(signal.candidate, this.#ignore_offer);
			}
		} catch (error) {
			this.#fail('signal', error);
		}
	}

	/** On the polite end, take the slots' transceivers from the offer just applied. */
	#adopt_transceivers(): void {
		const transceivers = this.#pc.getTransceivers();
		this.slots.forEach((slot, i) => {
			if (this.#transceivers[i]) return;
			const transceiver = transceivers[i];
			if (!transceiver) return;
			if (transceiver.receiver.track.kind !== slot.kind) {
				this.#deps.log?.warn(
					`[rtc_peer] the offer's media section ${i} is ${transceiver.receiver.track.kind}, slot '${slot.name}' is ${slot.kind}`
				);
				return;
			}
			transceiver.direction = 'sendrecv';
			this.#transceivers[i] = transceiver;
			const track = this.#local_tracks[i] ?? null;
			if (track) {
				transceiver.sender.replaceTrack(track).catch((error: unknown) => {
					this.#fail('replace_track', error);
				});
			}
		});
	}

	#send_local_description(): void {
		const description = this.#pc.localDescription;
		if (!description) return;
		const { type, sdp } = description;
		if (type !== 'offer' && type !== 'answer') return;
		this.#send({ description: { type, sdp } });
	}

	async #flush_candidates(): Promise<void> {
		const queued = this.#pending_candidates;
		this.#pending_candidates = [];
		for (const { candidate, ignoring } of queued) {
			if (this.closed) return;
			await this.#add_candidate(candidate, ignoring);
		}
	}

	/**
	 * @param ignoring - whether an offer was being ignored as the candidate
	 *   arrived; one for that offer can't be added, and needn't be
	 */
	async #add_candidate(candidate: RtcIceCandidate, ignoring: boolean): Promise<void> {
		try {
			await this.#pc.addIceCandidate(candidate);
		} catch (error) {
			if (!ignoring) this.#fail('candidate', error);
		}
	}

	#on_ice_candidate(event: RTCPeerConnectionIceEvent): void {
		if (this.closed || !event.candidate) return;
		const json = event.candidate.toJSON();
		if (typeof json.candidate !== 'string') return;
		this.#send({
			candidate: {
				candidate: json.candidate,
				sdpMid: json.sdpMid,
				sdpMLineIndex: json.sdpMLineIndex,
				usernameFragment: json.usernameFragment
			}
		});
	}

	#on_track(event: RTCTrackEvent): void {
		const index = this.#pc.getTransceivers().indexOf(event.transceiver);
		const slot = this.slots[index];
		if (!slot) return;
		this.remote_tracks = { ...this.remote_tracks, [slot.name]: event.track };
	}

	#on_ice_state(): void {
		const state = this.#pc.iceConnectionState;
		this.ice_connection_state = state;
		if (state === 'failed') {
			this.restart_ice();
		} else if (state === 'disconnected') {
			const ms = this.#ice_disconnected_restart_ms;
			if (ms !== null && this.#disconnected_timer === null) {
				this.#disconnected_timer = this.#deps.set_timeout(() => {
					this.#disconnected_timer = null;
					if (this.#pc.iceConnectionState === 'disconnected') this.restart_ice();
				}, ms);
			}
		} else {
			this.#clear_disconnected_timer();
		}
	}

	#clear_disconnected_timer(): void {
		if (this.#disconnected_timer === null) return;
		this.#deps.clear_timeout(this.#disconnected_timer);
		this.#disconnected_timer = null;
	}

	#fail(stage: string, error: unknown): void {
		// work in flight at the close fails against the closed connection, as expected
		if (this.closed) return;
		const message = to_error_message(error);
		this.last_error = `${stage}: ${message}`;
		this.#deps.log?.warn(`[rtc_peer] ${stage} failed:`, this.remote_member_id, message);
	}
}
