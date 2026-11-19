/**
 * The test room authorizer's rules, row for row the Rust stub's
 * `the_test_room_authorizer_reads_the_room_id` table, so both spines admit
 * the same rooms in the `rooms_ws` cross suite.
 *
 * @module
 */

import { assert, test } from 'vitest';

import type { RoomVerdict } from '#lib/actions/room_actions.ts';
import {
	test_room_rule_reads_admin,
	test_room_verdict
} from '#lib/testing/cross_backend/test_room_authorize.ts';

const allow = (scope: string | null, max_members: number | null): RoomVerdict => ({
	allow: true,
	scope,
	max_members
});
const deny: RoomVerdict = { allow: false };

test('the test room authorizer reads the room id', () => {
	// the live read's answer, for the `admin:` rule
	const [member, admin] = [false, true];
	const rows: Array<[boolean, string, 'join' | 'watch', RoomVerdict]> = [
		[member, 'open:a', 'join', allow(null, null)],
		[member, 'open:', 'watch', allow(null, null)],
		[member, 'scoped:g1:a', 'join', allow('g1', null)],
		[member, 'scoped:g1:', 'watch', allow('g1', null)],
		[member, 'scoped::a', 'join', deny],
		[member, 'scoped:g1', 'join', deny],
		[member, 'pair:a', 'join', allow(null, 2)],
		[member, 'watch:a', 'watch', allow(null, null)],
		[member, 'watch:a', 'join', deny],
		[member, 'admin:a', 'join', deny],
		[admin, 'admin:a', 'join', allow(null, null)],
		[admin, 'admin:a', 'watch', allow(null, null)],
		[member, 'other:a', 'join', deny],
		[admin, 'open', 'join', deny]
	];
	for (const [holds_admin, room_id, access, expected] of rows) {
		assert.deepStrictEqual(
			test_room_verdict(room_id, access, holds_admin),
			expected,
			`${room_id} ${access}`
		);
	}
	assert.isTrue(test_room_rule_reads_admin('admin:a'));
	assert.isTrue(test_room_rule_reads_admin('admin:'));
	for (const room_id of ['admin', 'open:a', 'administrator:a', 'x:admin:a']) {
		assert.isFalse(test_room_rule_reads_admin(room_id), room_id);
	}
});
