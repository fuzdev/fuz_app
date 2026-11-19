/**
 * The WebRTC signal envelope: what `RtcPeer` sends its far end, carried by
 * `RtcMesh` as a room payload (`room_send`'s `payload`, a string the server
 * relays without reading).
 *
 * A signal is one of two things, the two that perfect negotiation exchanges:
 * a session description (an offer or an answer) or a trickled ICE candidate.
 * On the wire it is the JSON text of one object whose `rtc` key is the
 * envelope's version, `RTC_SIGNAL_VERSION`, beside exactly one of
 * `description` or `candidate`:
 *
 * ```json
 * {"rtc":1,"description":{"type":"offer","sdp":"v=0\r\n…"}}
 * {"rtc":1,"candidate":{"candidate":"candidate:…","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"…"}}
 * ```
 *
 * `candidate` is `RTCIceCandidate.toJSON()`. The end of candidates is never
 * sent: trickle works without it. The `rtc` key also tells a signal apart from
 * the room's other payloads (a room's text, say): `decode_rtc_signal` answers
 * `not_rtc_signal` for any payload without it, so a room's other listeners can
 * read their own. A newer envelope bumps the version, and an older client
 * refuses it as `unsupported_version` rather than misreading it.
 *
 * @module
 */

import type { Result } from '@fuzdev/fuz_util/result.ts';
import {
	literal,
	nullable,
	number,
	object,
	one_of,
	optional,
	parse,
	pipe,
	safe_integer,
	min_value,
	string,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

/** The envelope's version, its `rtc` key. */
export const RTC_SIGNAL_VERSION = 1;

/** A session description as a signal carries it: an offer or an answer. */
export const RtcSessionDescription = object({
	type: one_of(['offer', 'answer']),
	sdp: string
});
export type RtcSessionDescription = Infer<typeof RtcSessionDescription>;

/** A trickled ICE candidate as a signal carries it: `RTCIceCandidate.toJSON()`. */
export const RtcIceCandidate = object({
	candidate: string,
	sdpMid: optional(nullable(string)),
	sdpMLineIndex: optional(nullable(pipe(number, safe_integer, min_value(0)))),
	usernameFragment: optional(nullable(string))
});
export type RtcIceCandidate = Infer<typeof RtcIceCandidate>;

/** One signal between two peers: a session description, or an ICE candidate. */
export type RtcSignal = { description: RtcSessionDescription } | { candidate: RtcIceCandidate };

const RtcSignalDescriptionEnvelope = object({
	rtc: literal(RTC_SIGNAL_VERSION),
	description: RtcSessionDescription
});

const RtcSignalCandidateEnvelope = object({
	rtc: literal(RTC_SIGNAL_VERSION),
	candidate: RtcIceCandidate
});

/**
 * Why a payload is no signal: `not_rtc_signal` (no `rtc` key, or not JSON — a
 * payload for some other reader), `unsupported_version` (another envelope
 * version), `invalid` (an `rtc` envelope that doesn't parse).
 */
export type RtcSignalDecodeError = 'not_rtc_signal' | 'unsupported_version' | 'invalid';

/**
 * Encode a signal as a room payload.
 *
 * @param signal - the signal
 * @returns its envelope's JSON text
 */
export const encode_rtc_signal = (signal: RtcSignal): string =>
	JSON.stringify(
		'description' in signal
			? { rtc: RTC_SIGNAL_VERSION, description: signal.description }
			: { rtc: RTC_SIGNAL_VERSION, candidate: signal.candidate }
	);

/**
 * Decode a room payload as a signal.
 *
 * @param payload - a `room_message` payload
 * @returns the signal, or why the payload is none
 */
export const decode_rtc_signal = (
	payload: string
): Result<{ value: RtcSignal }, { reason: RtcSignalDecodeError }> => {
	let json: unknown;
	try {
		json = JSON.parse(payload);
	} catch {
		return { ok: false, reason: 'not_rtc_signal' };
	}
	if (json === null || typeof json !== 'object' || Array.isArray(json) || !('rtc' in json)) {
		return { ok: false, reason: 'not_rtc_signal' };
	}
	if (json.rtc !== RTC_SIGNAL_VERSION) return { ok: false, reason: 'unsupported_version' };
	if ('description' in json) {
		const parsed = parse(RtcSignalDescriptionEnvelope, json);
		if (!parsed.ok) return { ok: false, reason: 'invalid' };
		return { ok: true, value: { description: parsed.value.description } };
	}
	const parsed = parse(RtcSignalCandidateEnvelope, json);
	if (!parsed.ok) return { ok: false, reason: 'invalid' };
	return { ok: true, value: { candidate: parsed.value.candidate } };
};
