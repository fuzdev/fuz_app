/**
 * Tests for the room verbs' wire (`actions/room_action_specs.ts`): the
 * escaped length the limiter charges, the room id grammar, the inputs'
 * strictness, and the specs' shape — each the twin of the Rust spine's
 * `fuz_actions::room` and `fuz_realtime::room_registry` rules.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { is } from '@fuzdev/fuz_schema/schema.ts';

import {
	JSON_ESCAPE_MAX_EXPANSION,
	ROOM_ID_MAX_LENGTH,
	RoomId,
	RoomJoinInput,
	RoomSendInput,
	RoomIdInput,
	all_room_action_specs,
	all_room_specs,
	json_escaped_len,
	room_notification_action_specs,
	room_notification_actions
} from '#lib/actions/room_action_specs.ts';
import { utf8_length } from '#lib/actions/transports.ts';
import { compile_action_registry } from '#lib/actions/compile_action_registry.ts';
import { rpc_action } from '#lib/actions/action_types.ts';

/** What `JSON.stringify` writes for `text` inside its quotes, in UTF-8 bytes. */
const written = (text: string): number => utf8_length(JSON.stringify(text)) - 2;

describe('json_escaped_len', () => {
	test('is what JSON.stringify writes, for every ASCII character', () => {
		for (let code = 0; code <= 0x7f; code++) {
			const text = String.fromCharCode(code);
			assert.strictEqual(json_escaped_len(text), written(text), `U+${code.toString(16)}`);
		}
	});

	test('is what JSON.stringify writes, for the Rust table and non-ASCII text', () => {
		for (const text of [
			'',
			'plain',
			'é',
			'€',
			'\u{1f600}',
			'  ',
			'﻿',
			'a"b\\c\nd\u0000e\u001f\u007f'
		]) {
			assert.strictEqual(json_escaped_len(text), written(text), JSON.stringify(text));
		}
	});

	test('the classes the Rust twin pins', () => {
		assert.strictEqual(json_escaped_len('"\\'), 4);
		assert.strictEqual(json_escaped_len('\b\f\n\r\t'), 10);
		assert.strictEqual(json_escaped_len('\u0000\u000b\u001f'), 18);
		assert.strictEqual(json_escaped_len('\u007fé\u{1f600}'), 1 + 2 + 4);
		assert.strictEqual(json_escaped_len('\u0001'.repeat(10)), 10 * JSON_ESCAPE_MAX_EXPANSION);
	});

	test('a lone surrogate counts six, as JSON.stringify writes it', () => {
		for (const text of ['\ud800', '\udfff', 'a\ud83db', '\ude00\ud83d']) {
			assert.strictEqual(json_escaped_len(text), written(text), JSON.stringify(text));
		}
		assert.strictEqual(json_escaped_len('\ud800'), JSON_ESCAPE_MAX_EXPANSION);
		// never more than the expansion bound times the UTF-8 length
		for (const text of ['\ud800', '\u0001', '"']) {
			assert.isAtMost(json_escaped_len(text), JSON_ESCAPE_MAX_EXPANSION * utf8_length(text));
		}
	});
});

describe('RoomId', () => {
	test('is 1 to ROOM_ID_MAX_LENGTH printable ASCII characters', () => {
		for (const id of ['r', 'open:a', '!~', 'x'.repeat(ROOM_ID_MAX_LENGTH), '"'.repeat(8)]) {
			assert.ok(is(RoomId, id), id);
		}
		for (const id of [
			'',
			'x'.repeat(ROOM_ID_MAX_LENGTH + 1),
			'has space',
			'tab\there',
			'café',
			'\u007f',
			'nul\u0000'
		]) {
			assert.notOk(is(RoomId, id), JSON.stringify(id));
		}
	});
});

describe('the room inputs are strict', () => {
	const member = '0b4f5b0e-1c8a-4d63-9a51-1f0c2a3b4c5d';

	test('room_send: `to` is required, a member id or null', () => {
		assert.ok(is(RoomSendInput, { room_id: 'r', to: null, payload: 'p' }));
		assert.ok(is(RoomSendInput, { room_id: 'r', to: member, payload: 'p' }));
		assert.notOk(is(RoomSendInput, { room_id: 'r', payload: 'p' }));
		assert.notOk(is(RoomSendInput, { room_id: 'r', to: 'nope', payload: 'p' }));
		assert.notOk(is(RoomSendInput, { room_id: 'r', to: null, payload: 1 }));
		assert.notOk(is(RoomSendInput, { room_id: 'r', to: null, payload: 'p', x: 1 }));
	});

	test('room_join: state and rejoin_of optional, not nullable', () => {
		assert.ok(is(RoomJoinInput, { room_id: 'r' }));
		assert.ok(is(RoomJoinInput, { room_id: 'r', state: 's', rejoin_of: member, acting: member }));
		assert.notOk(is(RoomJoinInput, { room_id: 'r', state: null }));
		assert.notOk(is(RoomJoinInput, { room_id: 'r', rejoin_of: 'nope' }));
		assert.notOk(is(RoomJoinInput, { room_id: 'has space' }));
	});

	test('room_leave / room_watch / room_unwatch take a room id and the acting selector', () => {
		assert.ok(is(RoomIdInput, { room_id: 'r', acting: member }));
		assert.notOk(is(RoomIdInput, {}));
	});
});

describe('the room specs', () => {
	test('are actor-required, without side effects, and join and watch on the account class', () => {
		assert.deepStrictEqual(
			all_room_action_specs.map((spec) => spec.method),
			['room_join', 'room_leave', 'room_send', 'room_state_set', 'room_watch', 'room_unwatch']
		);
		for (const spec of all_room_action_specs) {
			assert.deepStrictEqual(spec.auth, { account: 'required', actor: 'required' }, spec.method);
			assert.isFalse(spec.side_effects, spec.method);
			const expected = spec.method === 'room_join' || spec.method === 'room_watch';
			assert.strictEqual('rate_limit' in spec && spec.rate_limit === 'account', expected);
		}
	});

	test('compile as a registry, with the notifications registry-only', () => {
		const { action_map } = compile_action_registry(
			[
				...all_room_action_specs.map((spec) => rpc_action(spec, () => null)),
				...room_notification_actions
			],
			'WS action'
		);
		assert.strictEqual(action_map.size, all_room_action_specs.length);
		assert.deepStrictEqual(
			room_notification_action_specs.map((spec) => spec.method),
			[
				'room_member_joined',
				'room_member_left',
				'room_member_state',
				'room_message',
				'room_seat_lost',
				'room_watch_ended'
			]
		);
		assert.strictEqual(all_room_specs.length, 12);
	});
});
