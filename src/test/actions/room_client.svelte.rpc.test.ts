/**
 * Tests for `create_room_rpc` — the room verbs over a socket's `request`:
 * unqueued requests, answers parsed (keys a newer server added dropped),
 * thrown JSON-RPC errors kept, and the connection identity.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { create_uuid } from '#lib/primitive_schemas.ts';
import { JSONRPC_ERROR_CODES, ThrownJsonrpcError } from '#lib/http/jsonrpc_errors.ts';
import { ERROR_ROOM_FULL } from '#lib/actions/room_action_specs.ts';
import { create_room_rpc, type RoomRpcSocket } from '#lib/actions/room_client.svelte.ts';

const create_socket = (respond: (method: string, params: unknown) => unknown) => {
	const requests: Array<{ method: string; params: unknown; options: unknown }> = [];
	const socket: RoomRpcSocket & { connected: boolean; ws: object | null } = {
		connected: true,
		ws: {},
		request: async (method, params, options) => {
			requests.push({ method, params, options });
			return respond(method, params);
		}
	};
	return { socket, requests };
};

describe('create_room_rpc', () => {
	test('a verb is one unqueued request, its answer parsed', async () => {
		const member_id = create_uuid();
		const { socket, requests } = create_socket(() => ({
			room_id: 'r',
			member_id,
			seq: 1,
			members: [],
			topology: 'mesh',
			extra: null
		}));
		const rpc = create_room_rpc(socket);
		const result = await rpc.room_join({ room_id: 'r' });
		assert.ok(result.ok);
		assert.strictEqual(result.value.member_id, member_id);
		assert.deepEqual(requests, [
			{ method: 'room_join', params: { room_id: 'r' }, options: { queue: false } }
		]);
	});

	test('an answer carrying a key the spec doesn’t name parses, the key dropped', async () => {
		const member_id = create_uuid();
		const { socket } = create_socket(() => ({
			room_id: 'r',
			member_id,
			seq: 1,
			members: [{ member_id, actor_id: create_uuid(), state: null, joined_at: 'later' }],
			topology: 'mesh',
			extra: null,
			region: 'newer server'
		}));
		const result = await create_room_rpc(socket).room_join({ room_id: 'r' });
		assert.ok(result.ok);
		assert.notProperty(result.value, 'region');
		assert.notProperty(result.value.members[0], 'joined_at');
	});

	test('a thrown JSON-RPC error keeps its code and data', async () => {
		const { socket } = create_socket(() => {
			throw new ThrownJsonrpcError(JSONRPC_ERROR_CODES.conflict, 'full', {
				reason: ERROR_ROOM_FULL
			});
		});
		const result = await create_room_rpc(socket).room_join({ room_id: 'r' });
		assert.ok(!result.ok);
		assert.strictEqual(result.error.code, JSONRPC_ERROR_CODES.conflict);
		assert.deepEqual(result.error.data, { reason: ERROR_ROOM_FULL });
	});

	test('any other throw is an internal_error', async () => {
		const { socket } = create_socket(() => {
			throw new Error('boom');
		});
		const result = await create_room_rpc(socket).room_leave({ room_id: 'r' });
		assert.ok(!result.ok);
		assert.strictEqual(result.error.code, JSONRPC_ERROR_CODES.internal_error);
	});

	test('an answer off its schema is an internal_error', async () => {
		const { socket } = create_socket(() => ({ left: 'yes' }));
		const result = await create_room_rpc(socket).room_leave({ room_id: 'r' });
		assert.ok(!result.ok);
		assert.strictEqual(result.error.code, JSONRPC_ERROR_CODES.internal_error);
		assert.include(result.error.message, 'room_leave');
	});

	test('the connection is the open socket, else null', () => {
		const { socket } = create_socket(() => null);
		const rpc = create_room_rpc(socket);
		const ws = socket.ws;
		assert.strictEqual(rpc.connection, ws);
		socket.connected = false;
		assert.isNull(rpc.connection);
		socket.connected = true;
		socket.ws = {};
		assert.notStrictEqual(rpc.connection, ws);
	});
});
