/**
 * A fake `RoomRpc` for the room client tests: each verb call waits until the
 * test answers it, and the connection is an object the test swaps.
 *
 * @module
 */

import { assert } from 'vitest';

import { create_uuid } from '#lib/primitive_schemas.ts';
import type { JsonrpcErrorObject } from '#lib/http/jsonrpc.ts';
import { jsonrpc_error_messages } from '#lib/http/jsonrpc_errors.ts';
import type {
	MemberId,
	RoomJoinOutput,
	RoomMember,
	RoomOccupancy
} from '#lib/actions/room_action_specs.ts';
import type { RoomRpc, RoomRpcResult } from '#lib/actions/room_client.svelte.ts';

export interface FakeCall {
	method: keyof Omit<RoomRpc, 'connection'>;
	input: Record<string, unknown>;
	resolve: (result: RoomRpcResult<unknown>) => void;
}

export interface FakeRoomRpc {
	rpc: RoomRpc;
	/** Calls not yet answered, oldest first. */
	readonly calls: Array<FakeCall>;
	/** Take the oldest call, asserting its method. */
	take: (method: FakeCall['method']) => FakeCall;
	/** A fresh connection (a socket that opened), or `null` (closed). */
	set_connection: (connection: object | null) => void;
}

export const create_fake_room_rpc = (): FakeRoomRpc => {
	const calls: Array<FakeCall> = [];
	let connection: object | null = {};
	const call =
		(method: FakeCall['method']) =>
		(input: unknown): Promise<RoomRpcResult<any>> =>
			new Promise((resolve) => {
				calls.push({ method, input: input as Record<string, unknown>, resolve });
			});
	const rpc: RoomRpc = {
		room_join: call('room_join'),
		room_leave: call('room_leave'),
		room_send: call('room_send'),
		room_state_set: call('room_state_set'),
		room_watch: call('room_watch'),
		room_unwatch: call('room_unwatch'),
		get connection() {
			return connection;
		}
	};
	return {
		rpc,
		calls,
		take: (method) => {
			const next = calls.shift();
			assert.ok(next, `expected a ${method} call, got none`);
			assert.strictEqual(next.method, method);
			return next;
		},
		set_connection: (c) => {
			connection = c;
		}
	};
};

export const member = (member_id: MemberId = create_uuid()): RoomMember => ({
	member_id,
	actor_id: create_uuid(),
	state: null
});

export const join_output = (
	room_id: string,
	member_id: MemberId,
	seq: number,
	members: Array<RoomMember>
): RoomRpcResult<RoomJoinOutput> => ({
	ok: true,
	value: { room_id, member_id, seq, members, topology: 'mesh', extra: null }
});

export const occupancy = (
	room_id: string,
	seq: number,
	members: Array<RoomMember>
): RoomRpcResult<RoomOccupancy> => ({ ok: true, value: { room_id, seq, members } });

export const refusal = (reason: string): { ok: false; error: JsonrpcErrorObject } => ({
	ok: false,
	error: jsonrpc_error_messages.conflict(reason, { reason })
});
