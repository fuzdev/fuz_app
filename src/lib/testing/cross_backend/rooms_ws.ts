import '../assert_dev_env.ts';

/**
 * Cross-process **rooms** suite — the WebSocket-only room verbs
 * (`create_room_actions`) and the notifications their registry fans out, held
 * to one wire on both spines.
 *
 * Runs against a backend mounting the room verbs on `ws_path` over an
 * exclusive registry with the test room authorizer (`test_room_authorize`, the
 * twin of the Rust stub's `TestRoomAuthorize`: the room id's prefix picks the
 * rule) and the room limiter at its defaults — what `capabilities.rooms`
 * declares. Each case names fresh rooms, so no case reads another's; the
 * per-test `_testing_reset` drops every room besides.
 *
 * Pinned: join, leave, send, state, and watch round trips, with each event's
 * shape and its room's `seq` in order; an event never reaches the seat that
 * caused it; the refusals' codes and reasons (`room_not_found` for a denial
 * and a missing room alike, the invalid room id as the input schema's
 * reasonless refusal, `room_not_joined`, `room_member_not_found`, the payload
 * and state bounds, `room_full`, `room_watch_limit`, and `method_not_found`
 * over HTTP); exclusivity (one seat per actor, the newest admitted winning,
 * the displaced seat told `room_seat_lost` with `moved_to`) and the rejoin
 * tombstone (`room_seat_moved`); eviction through `_testing_room_evict`, which
 * ends seats and watches alike; a closed socket's seat leaving as
 * `disconnected`; the per-connection limiter's `rate_limited`, charged by
 * escaped bytes, with a watch and a leave still answered past the byte budget. Error messages
 * are not compared — codes and `data.reason` are the contract. The room verbs'
 * action-manifest entries (`transport: 'ws'`) are the manifest parity gate's.
 *
 * Gated on `capabilities.ws` and `capabilities.rooms`. A backend declaring
 * `rooms` declares `_testing_room_evict` too, which the eviction case drives
 * and `describe_spine_cross_suites` requires. Cross-process only.
 *
 * @module
 */

import { assert, describe } from 'vitest';

import {
	DEFAULT_ROOM_MAX_PAYLOAD_BYTES,
	DEFAULT_ROOM_MAX_STATE_BYTES,
	DEFAULT_ROOM_MAX_WATCHES_PER_CONNECTION,
	ERROR_ROOM_FULL,
	ERROR_ROOM_MEMBER_NOT_FOUND,
	ERROR_ROOM_NOT_FOUND,
	ERROR_ROOM_NOT_JOINED,
	ERROR_ROOM_PAYLOAD_TOO_LARGE,
	ERROR_ROOM_SEAT_MOVED,
	ERROR_ROOM_STATE_TOO_LARGE,
	ERROR_ROOM_WATCH_LIMIT,
	all_room_action_specs,
	type RoomJoinOutput,
	type RoomOccupancy
} from '../../actions/room_action_specs.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import { rpc_call, rpc_call_non_browser } from '../rpc_helpers.ts';
import {
	is_notification_with,
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type JsonrpcNotificationFrame,
	type WsClient
} from '../transports/ws_client.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import { open_session_ws, type WsEndpointTarget, type WsSessionAccount } from './ws_endpoint.ts';

/** Bound on every wait a broken case could otherwise turn into a hang. */
const WAIT_MS = 5000;

/** Configuration for `describe_rooms_ws_cross_tests`. */
export interface RoomsWsCrossTestOptions extends WsEndpointTarget {
	/** Per-test fixture producer (`default_cross_process_setup(handle)`). */
	readonly setup_test: SetupTest;
	/** Backend capability flags; every case gates on `ws` and `rooms`. */
	readonly capabilities: BackendCapabilities;
	/** JSON-RPC endpoint path. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
}

/** A JSON-RPC error object, as a refusal carries it. */
interface RoomRefusal {
	readonly code: number;
	readonly message: string;
	readonly data?: { readonly reason?: string; readonly retry_after?: unknown };
}

/** A room member, as the wire carries it. */
interface WireMember {
	member_id: string;
	actor_id: string;
	state: string | null;
}

/**
 * Register the rooms suite (module doc).
 *
 * @param options - the backend, its capabilities, and the fixture producer
 */
export const describe_rooms_ws_cross_tests = (options: RoomsWsCrossTestOptions): void => {
	const { setup_test, capabilities, rpc_path = SPINE_RPC_PATH } = options;
	const enabled = capabilities.ws && capabilities.rooms;

	let next_id = 0;
	let next_room = 0;
	/** A fresh room id under `prefix` (`open:`, `scoped:<scope>:`, …), unique to the run. */
	const room = (prefix: string): string =>
		`${prefix}${++next_room}-${Math.random().toString(36).slice(2, 10)}`;

	const open = (account: WsSessionAccount): Promise<WsClient> =>
		open_session_ws(options, account, { admitted: true, default_timeout_ms: WAIT_MS });

	/** A request's result, failing on an error. */
	const call = <R = unknown>(ws: WsClient, method: string, params: unknown): Promise<R> =>
		ws.request<R>(`room_${++next_id}`, method, params, WAIT_MS);

	/** A request's error, failing on a result. */
	const refused = async (ws: WsClient, method: string, params: unknown): Promise<RoomRefusal> => {
		const id = `room_${++next_id}`;
		await ws.send({ jsonrpc: '2.0', id, method, params });
		const frame = await ws.wait_for<Partial<JsonrpcErrorResponseFrame>>(
			is_response_for(id),
			WAIT_MS
		);
		if (!frame.error) assert.fail(`${method}: expected a refusal, got ${JSON.stringify(frame)}`);
		return frame.error as RoomRefusal;
	};

	/** Assert a refusal's code and `data.reason` (`undefined` for none). */
	const assert_refusal = (
		error: RoomRefusal,
		code: number,
		reason: string | undefined,
		label: string
	): void => {
		assert.strictEqual(error.code, code, `${label}: code (${JSON.stringify(error)})`);
		assert.strictEqual(error.data?.reason, reason, `${label}: data.reason`);
	};

	/** The params of the first `method` notification matching `match`. */
	const heard = async <P>(
		ws: WsClient,
		method: string,
		match: (params: P) => boolean = () => true
	): Promise<unknown> =>
		(await ws.wait_for(is_notification_with<P>(method, match), WAIT_MS)).params;

	/** Every `method` notification received so far for `room_id`. */
	const received = (ws: WsClient, method: string, room_id: string): Array<unknown> =>
		ws.messages
			.filter(
				(m): m is JsonrpcNotificationFrame<{ room_id?: string }> =>
					(m as { method?: unknown }).method === method
			)
			.filter((m) => m.params.room_id === room_id)
			.map((m) => m.params);

	const join = (ws: WsClient, params: Record<string, unknown>): Promise<RoomJoinOutput> =>
		call<RoomJoinOutput>(ws, 'room_join', params);

	/** Daemon-token RPC, for the `_testing_*` seams. */
	const backdoor = async <R>(
		fixture: TestFixture,
		method: string,
		params?: unknown
	): Promise<R> => {
		const result = await rpc_call_non_browser({
			app: fixture.fresh_transport({ origin: null }),
			path: rpc_path,
			method,
			params,
			headers: fixture.create_daemon_token_headers()
		});
		if (!result.ok) assert.fail(`${method} failed: ${JSON.stringify(result)}`);
		return result.result as R;
	};

	/** Close every client, whatever a case left open. */
	const close_all = async (clients: ReadonlyArray<WsClient>): Promise<void> => {
		await Promise.all(clients.map((client) => client.close()));
	};

	describe('rooms over the socket (cross-process)', () => {
		test_if(enabled, 'members join, relay, set state, and leave, in seq order', async () => {
			const fixture = await setup_test();
			const alice = await fixture.create_account();
			const bob = await fixture.create_account();
			const a = await open(alice);
			const b = await open(bob);
			try {
				const room_id = room('open:');
				const joined_a = await join(a, { room_id, state: 'muted' });
				const member_a = joined_a.member_id;
				assert.deepStrictEqual(joined_a, {
					room_id,
					member_id: member_a,
					seq: 1,
					members: [{ member_id: member_a, actor_id: alice.actor.id, state: 'muted' }],
					topology: 'mesh',
					extra: null
				});
				// the room's events reach the joiner ahead of its answer, so none
				// waits unseen: its own join was never sent to it
				assert.deepStrictEqual(received(a, 'room_member_joined', room_id), []);

				const joined_b = await join(b, { room_id });
				const member_b = joined_b.member_id;
				assert.strictEqual(joined_b.seq, 2);
				assert.deepStrictEqual(joined_b.members, [
					{ member_id: member_a, actor_id: alice.actor.id, state: 'muted' },
					{ member_id: member_b, actor_id: bob.actor.id, state: null }
				] satisfies Array<WireMember>);
				assert.deepStrictEqual(await heard(a, 'room_member_joined'), {
					room_id,
					seq: 2,
					member: { member_id: member_b, actor_id: bob.actor.id, state: null }
				});

				// to one member, then to the room minus the sender
				assert.strictEqual(
					await call(b, 'room_send', { room_id, to: member_a, payload: 'offer' }),
					null
				);
				assert.deepStrictEqual(
					await heard<{ seq: number }>(a, 'room_message', (p) => p.seq === 3),
					{ room_id, seq: 3, from: member_b, to: member_a, payload: 'offer' }
				);
				assert.strictEqual(await call(b, 'room_send', { room_id, to: null, payload: 'hi' }), null);
				assert.deepStrictEqual(
					await heard<{ seq: number }>(a, 'room_message', (p) => p.seq === 4),
					{ room_id, seq: 4, from: member_b, to: null, payload: 'hi' }
				);
				// the sender heard neither of its own messages
				assert.deepStrictEqual(received(b, 'room_message', room_id), []);

				assert.deepStrictEqual(await call(a, 'room_state_set', { room_id, state: 'live' }), {
					seq: 5
				});
				assert.deepStrictEqual(await heard(b, 'room_member_state'), {
					room_id,
					seq: 5,
					member_id: member_a,
					state: 'live'
				});
				assert.deepStrictEqual(received(a, 'room_member_state', room_id), []);

				assert.deepStrictEqual(await call(a, 'room_leave', { room_id }), { left: true });
				assert.deepStrictEqual(await heard(b, 'room_member_left'), {
					room_id,
					seq: 6,
					member_id: member_a,
					reason: 'left'
				});
				assert.deepStrictEqual(await call(a, 'room_leave', { room_id }), { left: false });
			} finally {
				await close_all([a, b]);
			}
		});

		test_if(enabled, 'a watch sees the members without a seat', async () => {
			const fixture = await setup_test();
			const watcher_account = await fixture.create_account();
			const member_account = await fixture.create_account();
			const watcher = await open(watcher_account);
			const member = await open(member_account);
			try {
				const room_id = room('watch:');
				// the `watch:` rule admits a watch and denies a join
				assert.deepStrictEqual(await call<RoomOccupancy>(watcher, 'room_watch', { room_id }), {
					room_id,
					seq: 0,
					members: []
				});
				assert_refusal(
					await refused(member, 'room_join', { room_id }),
					JSONRPC_ERROR_CODES.not_found,
					ERROR_ROOM_NOT_FOUND,
					'join of a watch-only room'
				);

				const open_room = room('open:');
				await call(watcher, 'room_watch', { room_id: open_room });
				const joined = await join(member, { room_id: open_room, state: 's0' });
				assert.deepStrictEqual(await heard(watcher, 'room_member_joined'), {
					room_id: open_room,
					seq: 1,
					member: { member_id: joined.member_id, actor_id: member_account.actor.id, state: 's0' }
				});
				await call(member, 'room_state_set', { room_id: open_room, state: 's1' });
				assert.deepStrictEqual(await heard(watcher, 'room_member_state'), {
					room_id: open_room,
					seq: 2,
					member_id: joined.member_id,
					state: 's1'
				});
				// watching again answers the occupancy again
				assert.deepStrictEqual(
					await call<RoomOccupancy>(watcher, 'room_watch', { room_id: open_room }),
					{
						room_id: open_room,
						seq: 2,
						members: [
							{ member_id: joined.member_id, actor_id: member_account.actor.id, state: 's1' }
						]
					}
				);
				// a watcher gets no messages
				await call(member, 'room_send', { room_id: open_room, to: null, payload: 'p' });
				assert.deepStrictEqual(await call(watcher, 'room_unwatch', { room_id: open_room }), {
					unwatched: true
				});
				assert.deepStrictEqual(received(watcher, 'room_message', open_room), []);
				assert.deepStrictEqual(await call(watcher, 'room_unwatch', { room_id: open_room }), {
					unwatched: false
				});
			} finally {
				await close_all([watcher, member]);
			}
		});

		test_if(enabled, 'refusals answer their codes and reasons', async () => {
			const fixture = await setup_test();
			const account = await fixture.create_account();
			const ws = await open(account);
			try {
				// denied and missing read the same
				for (const method of ['room_join', 'room_watch']) {
					assert_refusal(
						await refused(ws, method, { room_id: 'closed:x' }),
						JSONRPC_ERROR_CODES.not_found,
						ERROR_ROOM_NOT_FOUND,
						`${method} of a denied room`
					);
					assert_refusal(
						await refused(ws, method, { room_id: room('scoped::') }),
						JSONRPC_ERROR_CODES.not_found,
						ERROR_ROOM_NOT_FOUND,
						`${method} of a room with an empty scope`
					);
				}
				// a malformed room id is the input schema's reasonless refusal
				for (const room_id of ['has space', '', 'x'.repeat(129), 'café']) {
					assert_refusal(
						await refused(ws, 'room_join', { room_id }),
						JSONRPC_ERROR_CODES.invalid_params,
						undefined,
						`room id ${JSON.stringify(room_id)}`
					);
				}
				// unknown keys, and a `to` that is required
				assert_refusal(
					await refused(ws, 'room_join', { room_id: room('open:'), extra: 1 }),
					JSONRPC_ERROR_CODES.invalid_params,
					undefined,
					'an unknown key'
				);
				assert_refusal(
					await refused(ws, 'room_send', { room_id: room('open:'), payload: 'x' }),
					JSONRPC_ERROR_CODES.invalid_params,
					undefined,
					'a send without `to`'
				);

				const room_id = room('open:');
				assert_refusal(
					await refused(ws, 'room_send', { room_id, to: null, payload: 'x' }),
					JSONRPC_ERROR_CODES.conflict,
					ERROR_ROOM_NOT_JOINED,
					'a send before joining'
				);
				assert_refusal(
					await refused(ws, 'room_state_set', { room_id, state: 'x' }),
					JSONRPC_ERROR_CODES.conflict,
					ERROR_ROOM_NOT_JOINED,
					'a state set before joining'
				);
				// the bounds are UTF-8 bytes: one more than the bound, in two-byte characters
				assert_refusal(
					await refused(ws, 'room_join', {
						room_id,
						state: 'é'.repeat(DEFAULT_ROOM_MAX_STATE_BYTES / 2) + 'x'
					}),
					JSONRPC_ERROR_CODES.invalid_params,
					ERROR_ROOM_STATE_TOO_LARGE,
					'a join state over the bound'
				);
				const { member_id } = await join(ws, {
					room_id,
					state: 'é'.repeat(DEFAULT_ROOM_MAX_STATE_BYTES / 2)
				});
				assert_refusal(
					await refused(ws, 'room_state_set', {
						room_id,
						state: 'x'.repeat(DEFAULT_ROOM_MAX_STATE_BYTES + 1)
					}),
					JSONRPC_ERROR_CODES.invalid_params,
					ERROR_ROOM_STATE_TOO_LARGE,
					'a state over the bound'
				);
				assert_refusal(
					await refused(ws, 'room_send', {
						room_id,
						to: null,
						payload: 'x'.repeat(DEFAULT_ROOM_MAX_PAYLOAD_BYTES + 1)
					}),
					JSONRPC_ERROR_CODES.invalid_params,
					ERROR_ROOM_PAYLOAD_TOO_LARGE,
					'a payload over the bound'
				);
				assert_refusal(
					await refused(ws, 'room_send', {
						room_id,
						to: '0b4f5b0e-1c8a-4d63-9a51-1f0c2a3b4c5d',
						payload: 'x'
					}),
					JSONRPC_ERROR_CODES.not_found,
					ERROR_ROOM_MEMBER_NOT_FOUND,
					'a send to no member'
				);
				// nor may a member address itself
				assert_refusal(
					await refused(ws, 'room_send', { room_id, to: member_id, payload: 'x' }),
					JSONRPC_ERROR_CODES.not_found,
					ERROR_ROOM_MEMBER_NOT_FOUND,
					'a send to the sender'
				);
			} finally {
				await ws.close();
			}
		});

		test_if(
			enabled,
			'a room past its cap is full, and the admin rule reads the grant',
			async () => {
				const fixture = await setup_test();
				const accounts = [
					await fixture.create_account(),
					await fixture.create_account(),
					await fixture.create_account()
				];
				const clients: Array<WsClient> = [];
				try {
					for (const account of accounts) clients.push(await open(account));
					const [a, b, c] = clients as [WsClient, WsClient, WsClient];
					const pair = room('pair:');
					await join(a, { room_id: pair });
					await join(b, { room_id: pair });
					assert_refusal(
						await refused(c, 'room_join', { room_id: pair }),
						JSONRPC_ERROR_CODES.conflict,
						ERROR_ROOM_FULL,
						'a third member of a pair'
					);
					// a refused join displaced nothing
					assert.deepStrictEqual(received(a, 'room_member_left', pair), []);
					// a seat freed is a seat taken
					await call(b, 'room_leave', { room_id: pair });
					await join(c, { room_id: pair });

					// a member without the global admin role is denied, the keeper admitted
					const admin_room = room('admin:');
					assert_refusal(
						await refused(a, 'room_join', { room_id: admin_room }),
						JSONRPC_ERROR_CODES.not_found,
						ERROR_ROOM_NOT_FOUND,
						'a non-admin join of an admin room'
					);
					const keeper = await open(fixture);
					clients.push(keeper);
					const joined = await join(keeper, { room_id: admin_room });
					assert.strictEqual(joined.members[0]?.actor_id, fixture.actor.id);
					// and a fresh admin too, its grant read live
					const admin = await open(await fixture.create_account({ roles: [ROLE_ADMIN] }));
					clients.push(admin);
					await call(admin, 'room_watch', { room_id: admin_room });
				} finally {
					await close_all(clients);
				}
			}
		);

		test_if(enabled, 'a connection watches at most its maximum of rooms', async () => {
			const fixture = await setup_test();
			const ws = await open(await fixture.create_account());
			try {
				const base = room('open:');
				for (let i = 0; i < DEFAULT_ROOM_MAX_WATCHES_PER_CONNECTION; i++) {
					await call(ws, 'room_watch', { room_id: `${base}-${i}` });
				}
				assert_refusal(
					await refused(ws, 'room_watch', { room_id: `${base}-past` }),
					JSONRPC_ERROR_CODES.conflict,
					ERROR_ROOM_WATCH_LIMIT,
					'a watch past the maximum'
				);
				// re-watching a watched room is no new watch
				await call(ws, 'room_watch', { room_id: `${base}-0` });
				// an unwatch frees a slot
				await call(ws, 'room_unwatch', { room_id: `${base}-0` });
				await call(ws, 'room_watch', { room_id: `${base}-past` });
			} finally {
				await ws.close();
			}
		});

		test_if(enabled, 'over HTTP the room verbs answer method_not_found', async () => {
			const fixture = await setup_test();
			for (const spec of all_room_action_specs) {
				const result = await rpc_call({
					app: fixture.transport,
					path: rpc_path,
					method: spec.method,
					params: { room_id: room('open:') },
					headers: fixture.create_session_headers()
				});
				assert.ok(!result.ok, `${spec.method} over HTTP succeeded`);
				if (!result.ok) {
					assert.strictEqual(
						result.error.code,
						JSONRPC_ERROR_CODES.method_not_found,
						`${spec.method} over HTTP`
					);
				}
			}
		});

		test_if(enabled, 'one seat per actor: the newest admitted join moves the other', async () => {
			const fixture = await setup_test();
			const account = await fixture.create_account();
			const watcher_account = await fixture.create_account();
			const s1 = await open(account);
			const s2 = await open(account);
			const watcher = await open(watcher_account);
			try {
				const first = room('open:');
				const second = room('open:');
				await call(watcher, 'room_watch', { room_id: first });
				const m1 = (await join(s1, { room_id: first })).member_id;
				const m2 = (await join(s2, { room_id: second })).member_id;
				assert.deepStrictEqual(await heard(s1, 'room_seat_lost'), {
					room_id: first,
					member_id: m1,
					reason: 'moved',
					moved_to: second
				});
				assert.deepStrictEqual(await heard<{ reason: string }>(watcher, 'room_member_left'), {
					room_id: first,
					seq: 2,
					member_id: m1,
					reason: 'moved'
				});
				// the moved seat is gone from its room
				assert.deepStrictEqual(
					await call<RoomOccupancy>(watcher, 'room_watch', { room_id: first }),
					{ room_id: first, seq: 2, members: [] }
				);

				// a rejoin naming the moved seat would take the newer seat back: refused
				assert_refusal(
					await refused(s1, 'room_join', { room_id: first, rejoin_of: m1 }),
					JSONRPC_ERROR_CODES.conflict,
					ERROR_ROOM_SEAT_MOVED,
					'a rejoin of a moved seat'
				);
				// a fresh join moves it again
				const m3 = (await join(s1, { room_id: first })).member_id;
				assert.deepStrictEqual(await heard(s2, 'room_seat_lost'), {
					room_id: second,
					member_id: m2,
					reason: 'moved',
					moved_to: first
				});

				// joining again on one connection moves its own seat, to a fresh id
				const m4 = (await join(s1, { room_id: first })).member_id;
				assert.notStrictEqual(m4, m3);
				assert.deepStrictEqual(
					await heard<{ member_id: string }>(s1, 'room_seat_lost', (p) => p.member_id === m3),
					{ room_id: first, member_id: m3, reason: 'moved', moved_to: first }
				);

				// a seat released by its disconnect is rejoined, not refused
				await s1.close();
				await heard<{ member_id: string }>(watcher, 'room_member_left', (p) => p.member_id === m4);
				const s3 = await open(account);
				try {
					const rejoined = await join(s3, { room_id: first, rejoin_of: m4 });
					assert.notStrictEqual(rejoined.member_id, m4);
				} finally {
					await s3.close();
				}
			} finally {
				await close_all([s1, s2, watcher]);
			}
		});

		test_if(enabled, "a closed socket's seats leave as disconnected", async () => {
			const fixture = await setup_test();
			const stays = await open(await fixture.create_account());
			const goes = await open(await fixture.create_account());
			try {
				const room_id = room('open:');
				await join(stays, { room_id });
				const { member_id } = await join(goes, { room_id });
				await heard(stays, 'room_member_joined');
				await goes.close();
				assert.deepStrictEqual(await heard(stays, 'room_member_left'), {
					room_id,
					seq: 3,
					member_id,
					reason: 'disconnected'
				});
			} finally {
				await close_all([stays, goes]);
			}
		});

		test_if(enabled, 'an eviction ends seats and watches alike', async () => {
			const fixture = await setup_test();
			const evictee_account = await fixture.create_account();
			const stayer_account = await fixture.create_account();
			const evictee = await open(evictee_account);
			const stayer = await open(stayer_account);
			const watcher = await open(await fixture.create_account());
			try {
				// a scope target ends the scope's seats and watches
				const scoped = room('scoped:g1:');
				await call(watcher, 'room_watch', { room_id: scoped });
				const { member_id } = await join(evictee, { room_id: scoped });
				await heard(watcher, 'room_member_joined');
				assert.deepStrictEqual(
					await backdoor(fixture, '_testing_room_evict', {
						target: { kind: 'scope', scope: 'g1' },
						reason: 'evicted'
					}),
					{ seats: 1, watches: 1, pending: 0 }
				);
				assert.deepStrictEqual(await heard(evictee, 'room_seat_lost'), {
					room_id: scoped,
					member_id,
					reason: 'evicted',
					moved_to: null
				});
				assert.deepStrictEqual(await heard(watcher, 'room_watch_ended'), {
					room_id: scoped,
					reason: 'evicted'
				});
				assert.deepStrictEqual(await call(watcher, 'room_unwatch', { room_id: scoped }), {
					unwatched: false
				});

				// an actor within a scope: the others hear it leave as evicted
				const shared = room('scoped:g2:');
				await call(watcher, 'room_watch', { room_id: shared });
				const evicted_member = (await join(evictee, { room_id: shared })).member_id;
				const stayer_member = (await join(stayer, { room_id: shared })).member_id;
				assert.deepStrictEqual(
					await backdoor(fixture, '_testing_room_evict', {
						target: { kind: 'actor_in_scope', actor_id: evictee_account.actor.id, scope: 'g2' },
						reason: 'evicted'
					}),
					{ seats: 1, watches: 0, pending: 0 }
				);
				for (const ws of [stayer, watcher]) {
					assert.deepStrictEqual(
						await heard<{ room_id: string }>(ws, 'room_member_left', (p) => p.room_id === shared),
						{ room_id: shared, seq: 3, member_id: evicted_member, reason: 'evicted' }
					);
				}
				// the evicted seat sends nothing more
				assert_refusal(
					await refused(evictee, 'room_send', { room_id: shared, to: null, payload: 'x' }),
					JSONRPC_ERROR_CODES.conflict,
					ERROR_ROOM_NOT_JOINED,
					'a send from an evicted seat'
				);

				// a room target closes the room
				assert.deepStrictEqual(
					await backdoor(fixture, '_testing_room_evict', {
						target: { kind: 'room', room_id: shared },
						reason: 'room_closed'
					}),
					{ seats: 1, watches: 1, pending: 0 }
				);
				assert.deepStrictEqual(
					await heard<{ room_id: string }>(stayer, 'room_seat_lost', (p) => p.room_id === shared),
					{ room_id: shared, member_id: stayer_member, reason: 'room_closed', moved_to: null }
				);
				assert.deepStrictEqual(
					await heard<{ room_id: string }>(
						watcher,
						'room_watch_ended',
						(p) => p.room_id === shared
					),
					{ room_id: shared, reason: 'room_closed' }
				);

				// an actor target reaches every room; a target naming nothing removes nothing
				const third = room('open:');
				await join(stayer, { room_id: third });
				assert.deepStrictEqual(
					await backdoor(fixture, '_testing_room_evict', {
						target: { kind: 'actor', actor_id: stayer_account.actor.id },
						reason: 'evicted'
					}),
					{ seats: 1, watches: 0, pending: 0 }
				);
				assert.deepStrictEqual(
					await backdoor(fixture, '_testing_room_evict', {
						target: { kind: 'actor', actor_id: stayer_account.actor.id },
						reason: 'evicted'
					}),
					{ seats: 0, watches: 0, pending: 0 }
				);
			} finally {
				await close_all([evictee, stayer, watcher]);
			}
		});

		test_if(
			enabled,
			'the room limiter charges escaped bytes per connection; a watch and a leave still answer past it',
			async () => {
				const fixture = await setup_test();
				const account = await fixture.create_account();
				const ws = await open(account);
				try {
					const room_id = room('open:');
					await join(ws, { room_id });
					// a max-size payload whose every byte escapes to six: a few fill the
					// default byte budget, far below its request count
					const payload = '\u0001'.repeat(DEFAULT_ROOM_MAX_PAYLOAD_BYTES);
					let sent = 0;
					let limited: RoomRefusal | null = null;
					while (sent < 10) {
						const id = `room_${++next_id}`;
						await ws.send({
							jsonrpc: '2.0',
							id,
							method: 'room_send',
							params: { room_id, to: null, payload }
						});
						const frame = await ws.wait_for<Partial<JsonrpcErrorResponseFrame>>(
							is_response_for(id),
							WAIT_MS
						);
						if (frame.error) {
							limited = frame.error as RoomRefusal;
							break;
						}
						sent++;
					}
					assert.ok(limited, 'the byte budget never refused');
					assert.ok(sent >= 2, `refused after only ${sent} sends`);
					assert_refusal(limited, JSONRPC_ERROR_CODES.rate_limited, undefined, 'past the budget');
					const retry_after = limited.data?.retry_after;
					assert.ok(
						typeof retry_after === 'number' && Number.isInteger(retry_after) && retry_after >= 1,
						`retry_after: ${JSON.stringify(retry_after)}`
					);
					// what the limiter doesn't charge still runs
					await call(ws, 'room_watch', { room_id: room('open:') });
					assert.deepStrictEqual(await call(ws, 'room_leave', { room_id }), { left: true });
					// and another connection of the same account has its own budget
					const other = await open(account);
					try {
						const other_room = room('open:');
						await join(other, { room_id: other_room });
						assert.strictEqual(
							await call(other, 'room_send', { room_id: other_room, to: null, payload }),
							null
						);
					} finally {
						await other.close();
					}
				} finally {
					await ws.close();
				}
			}
		);
	});
};
