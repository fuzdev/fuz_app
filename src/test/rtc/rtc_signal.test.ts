/**
 * Tests for the WebRTC signal envelope — encode and decode round trips, and
 * the payloads it refuses.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	RTC_SIGNAL_VERSION,
	decode_rtc_signal,
	encode_rtc_signal,
	type RtcSignal,
	type RtcSignalDecodeError
} from '#lib/rtc/rtc_signal.ts';

describe('encode_rtc_signal / decode_rtc_signal', () => {
	const signals: Array<[label: string, signal: RtcSignal]> = [
		['an offer', { description: { type: 'offer', sdp: 'v=0\r\n' } }],
		['an answer', { description: { type: 'answer', sdp: 'v=0\r\n' } }],
		[
			'a candidate',
			{
				candidate: {
					candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host',
					sdpMid: '0',
					sdpMLineIndex: 0,
					usernameFragment: 'abcd'
				}
			}
		],
		['a candidate with nulls', { candidate: { candidate: '', sdpMid: null, sdpMLineIndex: null } }]
	];

	test.each(signals)('%s round-trips', (_label, signal) => {
		const payload = encode_rtc_signal(signal);
		assert.strictEqual(JSON.parse(payload).rtc, RTC_SIGNAL_VERSION);
		const decoded = decode_rtc_signal(payload);
		assert.ok(decoded.ok);
		assert.deepEqual(decoded.value, signal);
	});

	test('the envelope is the version beside one field', () => {
		assert.strictEqual(
			encode_rtc_signal({ description: { type: 'offer', sdp: 's' } }),
			'{"rtc":1,"description":{"type":"offer","sdp":"s"}}'
		);
	});

	const refused: Array<[label: string, payload: string, reason: RtcSignalDecodeError]> = [
		['plain text', 'hello, room', 'not_rtc_signal'],
		['JSON without the key', '{"text":"hi"}', 'not_rtc_signal'],
		['a JSON array', '[1]', 'not_rtc_signal'],
		['JSON null', 'null', 'not_rtc_signal'],
		[
			'another version',
			'{"rtc":2,"description":{"type":"offer","sdp":"s"}}',
			'unsupported_version'
		],
		['a rollback', '{"rtc":1,"description":{"type":"rollback","sdp":""}}', 'invalid'],
		['neither field', '{"rtc":1}', 'invalid'],
		[
			'both fields',
			'{"rtc":1,"description":{"type":"offer","sdp":"s"},"candidate":{"candidate":""}}',
			'invalid'
		],
		['an unknown key', '{"rtc":1,"candidate":{"candidate":"","extra":1}}', 'invalid'],
		[
			'a negative line index',
			'{"rtc":1,"candidate":{"candidate":"","sdpMLineIndex":-1}}',
			'invalid'
		]
	];

	test.each(refused)('%s is refused', (_label, payload, reason) => {
		const decoded = decode_rtc_signal(payload);
		assert.ok(!decoded.ok);
		assert.strictEqual(decoded.reason, reason);
	});
});
