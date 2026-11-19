/**
 * Tests for `RtcPeer` — perfect negotiation between two peers cross-wired over
 * scripted fake connections: the first connection, crossing offers (one
 * crossing a local description still being set), queued candidates and
 * those of an ignored offer, track swaps without renegotiation, ICE
 * restarts, and close with work in flight.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { create_uuid } from '#lib/primitive_schemas.ts';
import type { MemberId } from '#lib/actions/room_action_specs.ts';
import {
	RTC_ICE_DISCONNECTED_RESTART_MS,
	RtcPeer,
	rtc_peer_is_polite,
	type RtcSlot
} from '#lib/rtc/rtc_peer.svelte.ts';
import type { RtcSignal } from '#lib/rtc/rtc_signal.ts';

import {
	create_fake_rtc_deps,
	create_fake_track,
	settle,
	type FakePeerConnection
} from './rtc_fakes.ts';

/** Two members, ordered so `low` is the polite one. */
const ids = (): { low: MemberId; high: MemberId } => {
	const a = create_uuid();
	const b = create_uuid();
	return a < b ? { low: a, high: b } : { low: b, high: a };
};

/**
 * An impolite `a` and a polite `b` whose signals wait in queues until
 * `deliver` hands them across, JSON round-tripped as a room payload would be.
 */
const create_pair = (options?: { slots?: ReadonlyArray<RtcSlot> }) => {
	const { deps, connections, timers } = create_fake_rtc_deps();
	const { low, high } = ids();
	const a_to_b: Array<RtcSignal> = [];
	const b_to_a: Array<RtcSignal> = [];
	const clone = (s: RtcSignal): RtcSignal => JSON.parse(JSON.stringify(s));
	const a = new RtcPeer(deps, {
		remote_member_id: low,
		polite: rtc_peer_is_polite(high, low),
		slots: options?.slots,
		send: (s) => a_to_b.push(clone(s))
	});
	const b = new RtcPeer(deps, {
		remote_member_id: high,
		polite: rtc_peer_is_polite(low, high),
		slots: options?.slots,
		send: (s) => b_to_a.push(clone(s))
	});
	const pc_a = connections[0]!;
	const pc_b = connections[1]!;
	/** Hand signals across, both ways, until neither end has more to say. */
	const deliver = async (): Promise<void> => {
		for (;;) {
			await settle();
			if (a_to_b.length === 0 && b_to_a.length === 0) return;
			while (a_to_b.length) await b.on_signal(a_to_b.shift()!);
			while (b_to_a.length) await a.on_signal(b_to_a.shift()!);
		}
	};
	return { a, b, pc_a, pc_b, a_to_b, b_to_a, deliver, timers, connections };
};

const assert_connected = (pc_a: FakePeerConnection, pc_b: FakePeerConnection): void => {
	assert.strictEqual(pc_a.signalingState, 'stable');
	assert.strictEqual(pc_b.signalingState, 'stable');
	assert.strictEqual(pc_a.connectionState, 'connected');
	assert.strictEqual(pc_b.connectionState, 'connected');
	assert.strictEqual(pc_a.remote_ufrag, pc_b.ufrag);
	assert.strictEqual(pc_b.remote_ufrag, pc_a.ufrag);
};

describe('rtc_peer_is_polite', () => {
	test('the lower member id is polite, so the two ends always disagree', () => {
		const { low, high } = ids();
		assert.isTrue(rtc_peer_is_polite(low, high));
		assert.isFalse(rtc_peer_is_polite(high, low));
	});
});

describe('RtcPeer connecting', () => {
	test('two cross-wired peers connect: the impolite end offers, the polite end answers', async () => {
		const { a, b, pc_a, pc_b, deliver } = create_pair();
		assert.isFalse(a.polite);
		assert.isTrue(b.polite);
		await deliver();
		assert_connected(pc_a, pc_b);
		assert.strictEqual(pc_a.offers, 1);
		assert.strictEqual(pc_b.answers, 1);
		assert.strictEqual(pc_b.offers, 0);
		assert.strictEqual(a.connection_state, 'connected');
		assert.strictEqual(b.connection_state, 'connected');
		assert.strictEqual(a.signaling_state, 'stable');
		assert.isNull(a.last_error);
		assert.isNull(b.last_error);
	});

	test('the impolite end creates the slots; the polite end adopts them from the offer', async () => {
		const { pc_a, pc_b, deliver } = create_pair();
		assert.strictEqual(pc_a.getTransceivers().length, 1);
		assert.strictEqual(pc_b.getTransceivers().length, 0);
		await deliver();
		const [ta] = pc_a.getTransceivers();
		const [tb, extra] = pc_b.getTransceivers();
		assert.ok(ta);
		assert.ok(tb);
		assert.isUndefined(extra);
		assert.strictEqual(ta.mid, tb.mid);
		assert.strictEqual(tb.direction, 'sendrecv');
	});

	test('each end exposes the far end’s track per slot', async () => {
		const { a, b, pc_a, pc_b, deliver } = create_pair();
		assert.isNull(a.remote_tracks.mic);
		await deliver();
		assert.strictEqual(a.remote_tracks.mic, pc_a.getTransceivers()[0]!.receiver.track);
		assert.strictEqual(b.remote_tracks.mic, pc_b.getTransceivers()[0]!.receiver.track);
	});

	test('several slots line up by position on both ends', async () => {
		const slots: Array<RtcSlot> = [
			{ name: 'mic', kind: 'audio' },
			{ name: 'camera', kind: 'video' }
		];
		const { a, b, pc_a, pc_b, deliver } = create_pair({ slots });
		await deliver();
		assert.strictEqual(pc_b.getTransceivers().length, 2);
		assert.strictEqual(a.remote_tracks.camera?.kind, 'video');
		assert.strictEqual(b.remote_tracks.camera?.kind, 'video');
		assert.strictEqual(b.remote_tracks.mic?.kind, 'audio');
		assert.strictEqual(pc_a.offers, 1);
	});
});

describe('RtcPeer construction', () => {
	test('a peer that fails to make its slots throws, closing the connection it made', () => {
		const { deps, connections } = create_fake_rtc_deps();
		const failing = {
			...deps,
			create_peer_connection: (configuration: RTCConfiguration) => {
				const pc = deps.create_peer_connection(configuration);
				pc.addTransceiver = () => {
					throw new TypeError('no such kind');
				};
				return pc;
			}
		};
		assert.throws(
			() =>
				new RtcPeer(failing, {
					remote_member_id: create_uuid(),
					polite: false,
					send: () => undefined
				}),
			'no such kind'
		);
		assert.isTrue(connections[0]!.closed);
	});
});

describe('RtcPeer crossing offers', () => {
	const orders: Array<[label: string, polite_first: boolean]> = [
		['the polite end hears the crossing offer first', true],
		['the impolite end hears the crossing offer first', false]
	];

	test.each(orders)(
		'%s: the polite end rolls back, the impolite ignores',
		async (_l, polite_first) => {
			const { a, b, pc_a, pc_b, a_to_b, b_to_a, deliver } = create_pair();
			await deliver();
			const ufrags = [pc_a.ufrag, pc_b.ufrag];

			// both ends restart at once: two offers in flight
			a.restart_ice();
			b.restart_ice();
			await settle();
			assert.strictEqual(pc_a.signalingState, 'have-local-offer');
			assert.strictEqual(pc_b.signalingState, 'have-local-offer');
			const offer_to_b = a_to_b.shift()!;
			const offer_to_a = b_to_a.shift()!;
			assert.ok('description' in offer_to_b && offer_to_b.description.type === 'offer');
			assert.ok('description' in offer_to_a && offer_to_a.description.type === 'offer');

			if (polite_first) {
				await b.on_signal(offer_to_b);
				await a.on_signal(offer_to_a);
			} else {
				await a.on_signal(offer_to_a);
				await b.on_signal(offer_to_b);
			}
			await deliver();

			assert.strictEqual(pc_b.rollbacks, 1);
			assert.strictEqual(pc_a.rollbacks, 0);
			assert_connected(pc_a, pc_b);
			assert.notInclude(ufrags, pc_a.ufrag);
			assert.notInclude(ufrags, pc_b.ufrag);
			assert.isNull(a.last_error);
			assert.isNull(b.last_error);
		}
	);

	test('the impolite end ignores an offer that crosses its local description being set', async () => {
		const { a, b, pc_a, pc_b, b_to_a, deliver } = create_pair();
		await deliver();
		const release = pc_a.hold_next('setLocalDescription');
		a.restart_ice();
		await settle();
		assert.strictEqual(pc_a.signalingState, 'stable', 'its offer is still being set');
		b.restart_ice();
		await settle();
		const offer = b_to_a.shift()!;
		assert.ok('description' in offer && offer.description.type === 'offer');
		const handled = a.on_signal(offer);
		await settle();
		release();
		await handled;
		await deliver();
		assert.strictEqual(pc_a.rollbacks, 0, 'never applied the crossing offer');
		assert.strictEqual(pc_b.rollbacks, 1);
		assert_connected(pc_a, pc_b);
		assert.isNull(a.last_error);
		assert.isNull(b.last_error);
	});

	test('the polite end rolls back for an offer that crosses its local description being set', async () => {
		const { a, b, pc_a, pc_b, a_to_b, deliver } = create_pair();
		await deliver();
		const release = pc_b.hold_next('setLocalDescription');
		b.restart_ice();
		await settle();
		assert.strictEqual(pc_b.signalingState, 'stable', 'its offer is still being set');
		a.restart_ice();
		await settle();
		const offer = a_to_b.shift()!;
		assert.ok('description' in offer && offer.description.type === 'offer');
		const handled = b.on_signal(offer);
		await settle();
		release();
		await handled;
		await deliver();
		assert.strictEqual(pc_b.rollbacks, 1);
		assert.strictEqual(pc_a.rollbacks, 0);
		assert_connected(pc_a, pc_b);
		assert.isNull(a.last_error);
		assert.isNull(b.last_error);
	});
});

describe('RtcPeer candidates', () => {
	test('a candidate before the remote description is queued, then added', async () => {
		const { b, pc_a, pc_b, a_to_b } = create_pair();
		await settle(); // a offers
		const offer = a_to_b.shift()!;
		const init = pc_a.emit_candidate();
		const candidate = a_to_b.shift()!;
		assert.ok('candidate' in candidate);

		await b.on_signal(candidate); // ahead of its offer
		assert.strictEqual(pc_b.added_candidates.length, 0);
		assert.isNull(b.last_error);

		await b.on_signal(offer);
		assert.deepEqual(pc_b.added_candidates, [init]);
		assert.isNull(b.last_error);
	});

	test('a candidate after the remote description is added at once', async () => {
		const { a, pc_a, pc_b, b_to_a, deliver } = create_pair();
		await deliver();
		const init = pc_b.emit_candidate();
		await a.on_signal(b_to_a.shift()!);
		assert.deepEqual(pc_a.added_candidates, [init]);
	});

	test('a candidate for an offer the impolite end ignored fails silently', async () => {
		const { a, b, pc_a, pc_b, b_to_a, deliver } = create_pair();
		await deliver();
		a.restart_ice();
		b.restart_ice();
		await settle();
		const offer = b_to_a.shift()!;
		const init = pc_b.emit_candidate(); // gathered for the restart offer, its new ufrag
		const candidate = b_to_a.shift()!;
		await a.on_signal(offer); // ignored
		await a.on_signal(candidate);
		assert.notDeepInclude(pc_a.added_candidates, init);
		assert.isNull(a.last_error);
		await deliver();
		assert_connected(pc_a, pc_b);
		assert.isNull(a.last_error);
	});

	test('a candidate queued while an offer was ignored fails silently once flushed', async () => {
		const { deps, connections } = create_fake_rtc_deps();
		const sent: Array<RtcSignal> = [];
		const a = new RtcPeer(deps, {
			remote_member_id: create_uuid(),
			polite: false,
			send: (signal) => sent.push(signal)
		});
		const pc_a = connections[0]!;
		await settle();
		const own_offer = sent.shift()!;
		assert.ok('description' in own_offer && own_offer.description.type === 'offer');
		const media = (JSON.parse(own_offer.description.sdp) as { media: Array<unknown> }).media;
		const sdp = (ufrag: string) => JSON.stringify({ ufrag, media });

		// the far end's own offer crosses this end's, before any remote description
		await a.on_signal({ description: { type: 'offer', sdp: sdp('far_u0') } });
		await a.on_signal({
			candidate: {
				candidate: 'candidate:far',
				sdpMid: '0',
				sdpMLineIndex: 0,
				usernameFragment: 'far_u0'
			}
		});
		assert.isNull(pc_a.remoteDescription);
		// the far end rolls back and answers with new credentials: the queued candidate can't be added
		await a.on_signal({ description: { type: 'answer', sdp: sdp('far_u1') } });
		assert.strictEqual(pc_a.signalingState, 'stable');
		assert.deepEqual(pc_a.added_candidates, []);
		assert.isNull(a.last_error);
	});

	test('a queued candidate that fails to add with no offer ignored is recorded', async () => {
		const { b, pc_a, pc_b, a_to_b } = create_pair();
		await settle();
		const offer = a_to_b.shift()!;
		pc_a.emit_candidate('candidate:stale');
		const candidate = a_to_b.shift()!;
		assert.ok('candidate' in candidate);
		await b.on_signal({ candidate: { ...candidate.candidate, usernameFragment: 'unknown' } });
		await b.on_signal(offer);
		assert.deepEqual(pc_b.added_candidates, []);
		assert.include(b.last_error, 'candidate');
	});

	test('the end of candidates is not sent', async () => {
		const { pc_a, a_to_b, deliver } = create_pair();
		await deliver();
		pc_a.emit_end_of_candidates();
		assert.strictEqual(a_to_b.length, 0);
	});
});

describe('RtcPeer tracks', () => {
	test('turning a slot on and off is replaceTrack, with no renegotiation', async () => {
		const { a, pc_a, pc_b, a_to_b, b_to_a, deliver } = create_pair();
		await deliver();
		const offers = pc_a.offers + pc_b.offers;
		const needed = pc_a.negotiations_needed + pc_b.negotiations_needed;
		const sender = pc_a.getTransceivers()[0]!.sender;
		const mic = create_fake_track('audio');

		await a.set_track('mic', mic);
		assert.strictEqual(sender.track, mic);
		await a.set_track('mic', null);
		assert.isNull(sender.track);
		await settle();

		assert.deepEqual(sender.replaced, [mic, null]);
		assert.strictEqual(pc_a.offers + pc_b.offers, offers);
		assert.strictEqual(pc_a.negotiations_needed + pc_b.negotiations_needed, needed);
		assert.strictEqual(a_to_b.length + b_to_a.length, 0);
	});

	test('the polite end keeps a track set before the offer and sends it once the slot arrives', async () => {
		const { b, pc_b, deliver } = create_pair();
		const mic = create_fake_track('audio');
		await b.set_track('mic', mic);
		await deliver();
		await settle();
		assert.strictEqual(pc_b.getTransceivers()[0]!.sender.track, mic);
	});

	test('an unknown slot throws', async () => {
		const { a } = create_pair();
		try {
			await a.set_track('camera', null);
		} catch (error) {
			assert(error instanceof Error);
			assert.include(error.message, "no slot named 'camera'");
			return;
		}
		assert.fail('expected a throw');
	});
});

describe('RtcPeer ICE restart', () => {
	test('ICE failure restarts with new credentials', async () => {
		const { a, pc_a, pc_b, a_to_b, deliver } = create_pair();
		await deliver();
		const ufrag = pc_a.ufrag;
		pc_a.set_ice_connection_state('failed');
		assert.strictEqual(a.ice_connection_state, 'failed');
		await settle();
		const offer = a_to_b[0];
		assert.ok(offer && 'description' in offer && offer.description.type === 'offer');
		await deliver();
		assert_connected(pc_a, pc_b);
		assert.notStrictEqual(pc_a.ufrag, ufrag);
		assert.strictEqual(pc_a.restarts, 1);
	});

	test('a disconnect that lasts restarts ICE once the timer fires', async () => {
		const { pc_a, a_to_b, deliver, timers } = create_pair();
		await deliver();
		pc_a.set_ice_connection_state('disconnected');
		assert.deepEqual(timers.pending(), [RTC_ICE_DISCONNECTED_RESTART_MS]);
		await settle();
		assert.strictEqual(a_to_b.length, 0);
		timers.fire_all();
		await settle();
		assert.strictEqual(a_to_b.length, 1);
	});

	test('a disconnect that recovers clears the timer', async () => {
		const { pc_a, a_to_b, deliver, timers } = create_pair();
		await deliver();
		pc_a.set_ice_connection_state('disconnected');
		pc_a.set_ice_connection_state('connected');
		assert.deepEqual(timers.pending(), []);
		await settle();
		assert.strictEqual(a_to_b.length, 0);
	});
});

describe('RtcPeer close', () => {
	test('close closes the connection, clears the remote tracks, and ignores later signals', async () => {
		const { a, b, pc_a, b_to_a, deliver } = create_pair();
		await deliver();
		a.close();
		assert.isTrue(a.closed);
		assert.isTrue(pc_a.closed);
		assert.isNull(a.remote_tracks.mic);
		assert.strictEqual(a.connection_state, 'closed');

		b.restart_ice();
		await settle();
		await a.on_signal(b_to_a.shift()!);
		assert.isNull(a.last_error);
		a.close(); // idempotent
	});

	test('a late signal reaches nothing on the closed connection', async () => {
		const { a, b, pc_a, pc_b, a_to_b, deliver } = create_pair();
		await deliver();
		b.close();
		a.restart_ice();
		await settle();
		pc_a.emit_candidate();
		// the polite end would apply an offer, and add a candidate, were it open
		for (const signal of a_to_b.splice(0)) await b.on_signal(signal);
		assert.strictEqual(pc_b.calls_after_close, 0);
		assert.isNull(b.last_error);
	});

	test('a close while queued candidates are being added adds no more', async () => {
		const { b, pc_a, pc_b, a_to_b } = create_pair();
		await settle();
		const offer = a_to_b.shift()!;
		pc_a.emit_candidate('candidate:one');
		pc_a.emit_candidate('candidate:two');
		const candidates = a_to_b.splice(0);
		for (const candidate of candidates) await b.on_signal(candidate);
		const release = pc_b.hold_next('addIceCandidate', 'after');
		const handled = b.on_signal(offer);
		await settle();
		assert.strictEqual(pc_b.added_candidates.length, 1, 'the first is held');
		b.close();
		release();
		await handled;
		assert.strictEqual(pc_b.added_candidates.length, 1);
		assert.strictEqual(pc_b.calls_after_close, 0);
		assert.isNull(b.last_error);
	});

	test('a close while an offer is being applied stops before answering', async () => {
		const { a, b, pc_a, pc_b, a_to_b, b_to_a } = create_pair();
		await settle();
		const offer = a_to_b.shift()!;
		const release = pc_b.hold_next('setRemoteDescription', 'after');
		const handled = b.on_signal(offer);
		await settle();
		b.close();
		release();
		await handled;
		assert.strictEqual(b_to_a.length, 0, 'no answer');
		assert.strictEqual(pc_b.calls_after_close, 0);
		assert.isNull(b.last_error);
		assert.isNull(a.last_error);
		assert.strictEqual(pc_a.signalingState, 'have-local-offer');
	});

	test('a close while the answer is being set sends no answer', async () => {
		const { b, pc_b, a_to_b, b_to_a } = create_pair();
		await settle();
		const offer = a_to_b.shift()!;
		const release = pc_b.hold_next('setLocalDescription', 'after');
		const handled = b.on_signal(offer);
		await settle();
		b.close();
		release();
		await handled;
		assert.strictEqual(b_to_a.length, 0);
		assert.strictEqual(pc_b.calls_after_close, 0);
		assert.isNull(b.last_error);
	});

	test('a close while an offer is being made sends no offer', async () => {
		const { deps, connections } = create_fake_rtc_deps();
		const sent: Array<RtcSignal> = [];
		const pc_hold = (): (() => void) => connections[0]!.hold_next('setLocalDescription', 'after');
		const a = new RtcPeer(deps, {
			remote_member_id: create_uuid(),
			polite: false,
			send: (signal) => sent.push(signal)
		});
		const release = pc_hold();
		await settle();
		a.close();
		release();
		await settle();
		assert.deepEqual(sent, []);
		assert.isNull(a.last_error);
	});

	test('work that fails against the connection closed under it is not recorded', async () => {
		const { b, pc_b, a_to_b } = create_pair();
		await settle();
		const offer = a_to_b.shift()!;
		const release = pc_b.hold_next('setRemoteDescription', 'before');
		const handled = b.on_signal(offer);
		await settle();
		b.close();
		release();
		await handled; // the held work now refuses: the connection is closed
		assert.isNull(b.last_error);
	});
});
