/**
 * Tests for the room verbs (`actions/room_actions.ts`): the per-connection
 * limiter, the limiter-against-registry check, each refusal's code and
 * reason, and the join's two phases around the authorizer — a socket closing
 * or a client cancelling mid-authorizer seats no one, as the Rust twin's
 * dropped request future seats no one.
 *
 * The handlers are driven directly, with a hand-built context: a real
 * `ConnectionRegistry` holding fake sockets, and an authorizer the case
 * holds open.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { ConnectionRegistry } from '#lib/actions/connection_registry.ts';
import {
	DEFAULT_ROOM_RATE_LIMIT,
	RoomRateLimiter,
	check_room_limits,
	create_room_actions,
	to_room_jsonrpc_error,
	type RoomActionsOptions,
	type RoomAuthorize,
	type RoomVerdict
} from '#lib/actions/room_actions.ts';
import {
	DEFAULT_ROOM_MAX_PAYLOAD_BYTES,
	JSON_ESCAPE_MAX_EXPANSION
} from '#lib/actions/room_action_specs.ts';
import {
	RoomRegistry,
	type RoomError,
	type RoomRegistryOptions
} from '#lib/actions/room_registry.ts';
import type { ActionContext } from '#lib/actions/action_types.ts';
import { JSONRPC_ERROR_CODES, ThrownJsonrpcError } from '#lib/http/jsonrpc_errors.ts';
import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';
import { create_fake_ws } from '#lib/testing/ws_round_trip.ts';
import { create_test_identity } from './connection_identity_helpers.ts';

describe('RoomRateLimiter', () => {
	const options = { max_requests: 3, max_bytes: 100, window_ms: 1000 };

	test('the request budget bursts, then refills over its window', () => {
		let now = 0;
		const limiter = new RoomRateLimiter(options, () => now);
		const id = create_uuid();
		for (let i = 0; i < 3; i++) assert.ok(limiter.charge(id, 0).ok);
		const refused = limiter.charge(id, 0);
		assert.deepStrictEqual(refused, { ok: false, retry_after: 1 });
		now += 1000 / 3;
		assert.ok(limiter.charge(id, 0).ok, 'one request refilled');
		assert.notOk(limiter.charge(id, 0).ok);
		// another connection has its own budget
		assert.ok(limiter.charge(create_uuid(), 0).ok);
	});

	test('the byte budget refuses without spending', () => {
		let now = 0;
		const limiter = new RoomRateLimiter(options, () => now);
		const id = create_uuid();
		assert.ok(limiter.charge(id, 60).ok);
		assert.notOk(limiter.charge(id, 60).ok, 'over the bytes left');
		// the refusal spent neither budget: two requests of 20 bytes still fit
		assert.ok(limiter.charge(id, 20).ok);
		assert.ok(limiter.charge(id, 20).ok);
		assert.notOk(limiter.charge(id, 0).ok, 'the request budget is spent');
		// a charge past the whole bucket waits a window
		now += 5000;
		assert.deepStrictEqual(limiter.charge(id, 101), { ok: false, retry_after: 1 });
		const slow = new RoomRateLimiter({ max_requests: 10, max_bytes: 100, window_ms: 10_000 });
		assert.ok(slow.charge(id, 100).ok);
		assert.deepStrictEqual(slow.charge(id, 50), { ok: false, retry_after: 5 });
	});

	test('full buckets are forgotten as the map grows', () => {
		let now = 0;
		const limiter = new RoomRateLimiter(options, () => now);
		for (let i = 0; i < 64; i++) limiter.charge(create_uuid(), 1);
		assert.strictEqual(limiter.tracked(), 64);
		now += 10_000;
		limiter.charge(create_uuid(), 1);
		assert.strictEqual(limiter.tracked(), 1, 'the refilled ones swept');
	});

	test('a budget out of range throws', () => {
		assert.throws(() => new RoomRateLimiter({ ...options, max_requests: -1 }));
		assert.throws(() => new RoomRateLimiter({ ...options, max_bytes: 1.5 }));
		assert.throws(() => new RoomRateLimiter({ ...options, window_ms: 0 }));
	});
});

describe('check_room_limits', () => {
	const registry = new RoomRegistry(new ConnectionRegistry({ log: null })).options;
	const worst = (bytes: number): number => bytes * JSON_ESCAPE_MAX_EXPANSION;

	test('refuses a limiter below the registry bounds', () => {
		assert.isNull(check_room_limits(registry, DEFAULT_ROOM_RATE_LIMIT), 'the defaults fit');
		const at = (max_bytes: number) => ({ ...DEFAULT_ROOM_RATE_LIMIT, max_bytes });
		assert.isNull(check_room_limits(registry, at(worst(registry.max_payload_bytes))));
		assert.deepStrictEqual(check_room_limits(registry, at(worst(registry.max_payload_bytes) - 1)), {
			kind: 'byte_budget_below_bound',
			bound: 'payload',
			charge: worst(DEFAULT_ROOM_MAX_PAYLOAD_BYTES),
			max_bytes: worst(DEFAULT_ROOM_MAX_PAYLOAD_BYTES) - 1
		});
		const big_state = { ...registry, max_payload_bytes: 10, max_state_bytes: 100 };
		assert.strictEqual(check_room_limits(big_state, at(599))?.kind, 'byte_budget_below_bound');
		assert.deepStrictEqual(
			check_room_limits(registry, { ...DEFAULT_ROOM_RATE_LIMIT, max_requests: 0 }),
			{ kind: 'no_request_budget' }
		);
	});

	test('create_room_actions runs the check', () => {
		assert.throws(
			() =>
				create_room_actions({
					registry: new RoomRegistry(new ConnectionRegistry({ log: null })),
					authorize: { authorize: () => ({ allow: false }) },
					limiter: new RoomRateLimiter({ ...DEFAULT_ROOM_RATE_LIMIT, max_bytes: 1024 })
				}),
			/max_bytes \(1024\)/
		);
	});
});

describe('to_room_jsonrpc_error', () => {
	test('each refusal names its code and reason', () => {
		const answer = (error: RoomError) => {
			const thrown = to_room_jsonrpc_error(error);
			return [thrown.code, (thrown.data as { reason?: string } | undefined)?.reason];
		};
		const { not_found, conflict, invalid_params, request_cancelled } = JSONRPC_ERROR_CODES;
		assert.deepStrictEqual(answer('evicted'), [not_found, 'room_not_found']);
		assert.deepStrictEqual(answer('connection_closed'), [request_cancelled, undefined]);
		assert.deepStrictEqual(answer('full'), [conflict, 'room_full']);
		assert.deepStrictEqual(answer('join_superseded'), [conflict, 'room_join_superseded']);
		assert.deepStrictEqual(answer('seat_moved'), [conflict, 'room_seat_moved']);
		assert.deepStrictEqual(answer('not_joined'), [conflict, 'room_not_joined']);
		assert.deepStrictEqual(answer('member_not_found'), [not_found, 'room_member_not_found']);
		assert.deepStrictEqual(answer('payload_too_large'), [invalid_params, 'room_payload_too_large']);
		assert.deepStrictEqual(answer('state_too_large'), [invalid_params, 'room_state_too_large']);
		assert.deepStrictEqual(answer('watch_limit'), [conflict, 'room_watch_limit']);
	});
});

/** An authorizer each call of which the case releases with a verdict. */
const create_held_authorize = () => {
	const held: Array<{ room_id: string; release: (verdict: RoomVerdict) => void }> = [];
	const authorize: RoomAuthorize = {
		authorize: (input) =>
			new Promise<RoomVerdict>((resolve) => held.push({ room_id: input.room_id, release: resolve }))
	};
	return { authorize, held };
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the room verbs around the authorizer', () => {
	const setup = (
		authorize: RoomAuthorize,
		registry_options: RoomRegistryOptions = {},
		options: RoomActionsOptions = { join_extra: ({ member_id }) => ({ member: member_id }) }
	) => {
		const connections = new ConnectionRegistry({ log: null });
		const registry = new RoomRegistry(connections, registry_options);
		const actions = create_room_actions({ registry, authorize, limiter: null }, options);
		const by_method = new Map(actions.map((action) => [action.spec.method, action]));
		const connect = () => {
			const controller = new AbortController();
			const id = connections.add_connection(
				create_fake_ws().ws,
				create_test_identity({ account_id: create_uuid() }),
				controller
			);
			return { id, controller };
		};
		/** Call `method` as `actor` on `connection_id`, with the request's own signal. */
		const run = (
			method: string,
			input: unknown,
			connection: { id: Uuid | undefined; signal: AbortSignal },
			actor: Uuid = create_uuid()
		): Promise<unknown> => {
			const ctx = {
				auth: {
					account: { id: create_uuid() },
					actor: { id: actor },
					role_grants: []
				},
				connection_id: connection.id,
				db: {},
				signal: connection.signal
			} as unknown as ActionContext;
			// a sync throw rejects, as the dispatcher reads it
			return new Promise((resolve) => resolve(by_method.get(method)!.handler(input, ctx)));
		};
		return { registry, connect, run };
	};

	const assert_thrown = async (promise: Promise<unknown>, code: number, reason?: string) => {
		try {
			await promise;
		} catch (error) {
			assert.instanceOf(error, ThrownJsonrpcError);
			assert.strictEqual(error.code, code);
			assert.strictEqual((error.data as { reason?: string } | undefined)?.reason, reason);
			return;
		}
		assert.fail('expected a refusal');
	};

	test('an allowed join answers the seat and the extra; a denied one is room_not_found', async () => {
		const { authorize, held } = create_held_authorize();
		const { registry, connect, run } = setup(authorize);
		const a = connect();
		const joined = run('room_join', { room_id: 'line' }, { id: a.id, signal: a.controller.signal });
		await settle();
		held.shift()!.release({ allow: true, scope: 'g1' });
		const output = (await joined) as { member_id: string; extra: unknown };
		assert.deepStrictEqual(output.extra, { member: output.member_id });
		assert.strictEqual(registry.occupancy('line')?.members.length, 1);

		const denied = run(
			'room_watch',
			{ room_id: 'closed' },
			{ id: a.id, signal: a.controller.signal }
		);
		await settle();
		held.shift()!.release({ allow: false });
		await assert_thrown(denied, JSONRPC_ERROR_CODES.not_found, 'room_not_found');
	});

	test('a socket closed mid-authorizer leaves no seat', async () => {
		const { authorize, held } = create_held_authorize();
		const { registry, connect, run } = setup(authorize);
		const a = connect();
		const joined = run('room_join', { room_id: 'line' }, { id: a.id, signal: a.controller.signal });
		await settle();
		a.controller.abort();
		await settle();
		held.shift()!.release({ allow: true });
		await assert_thrown(joined, JSONRPC_ERROR_CODES.request_cancelled);
		assert.isNull(registry.occupancy('line'));
	});

	test('a cancelled join is not seated, and its socket stays', async () => {
		const { authorize, held } = create_held_authorize();
		const { registry, connect, run } = setup(authorize);
		const a = connect();
		const request = new AbortController();
		const joined = run(
			'room_join',
			{ room_id: 'line' },
			{ id: a.id, signal: AbortSignal.any([a.controller.signal, request.signal]) }
		);
		await settle();
		request.abort();
		held.shift()!.release({ allow: true });
		await assert_thrown(joined, JSONRPC_ERROR_CODES.request_cancelled);
		assert.isNull(registry.occupancy('line'));
		// the join in flight is gone: an eviction reaches nothing
		assert.strictEqual(registry.evict({ kind: 'room', room_id: 'line' }, 'evicted').pending, 0);
	});

	test('a join_extra answering nothing puts extra: null on the wire', async () => {
		const { connect, run } = setup(
			{ authorize: () => ({ allow: true }) },
			{},
			{
				join_extra: () => undefined
			}
		);
		const a = connect();
		const output = (await run(
			'room_join',
			{ room_id: 'line' },
			{ id: a.id, signal: a.controller.signal }
		)) as Record<string, unknown>;
		assert.ok('extra' in output);
		assert.isNull(output.extra);
		// and without a hook
		const bare = setup({ authorize: () => ({ allow: true }) }, {}, {});
		const b = bare.connect();
		const bare_output = (await bare.run(
			'room_join',
			{ room_id: 'line' },
			{ id: b.id, signal: b.controller.signal }
		)) as Record<string, unknown>;
		assert.isNull(bare_output.extra);
	});

	test('a cancelled watch is not admitted', async () => {
		const { authorize, held } = create_held_authorize();
		const { registry, connect, run } = setup(authorize);
		const a = connect();
		const request = new AbortController();
		const watched = run(
			'room_watch',
			{ room_id: 'line' },
			{ id: a.id, signal: AbortSignal.any([a.controller.signal, request.signal]) }
		);
		await settle();
		request.abort();
		held.shift()!.release({ allow: true });
		await assert_thrown(watched, JSONRPC_ERROR_CODES.request_cancelled);
		assert.isNull(registry.occupancy('line'), 'no watch was recorded');
	});

	test('a rejoin of a moved seat answers room_seat_moved before the authorizer runs', async () => {
		// the authorizer would deny it: the reserve refuses first, so the client
		// learns its seat moved rather than that the room is gone
		let calls = 0;
		const { connect, run } = setup(
			{
				authorize: () => {
					calls++;
					return calls <= 2 ? { allow: true } : { allow: false };
				}
			},
			{ exclusive: true }
		);
		const actor = create_uuid();
		const first = connect();
		const second = connect();
		const { member_id } = (await run(
			'room_join',
			{ room_id: 'line' },
			{ id: first.id, signal: first.controller.signal },
			actor
		)) as { member_id: string };
		// the actor's join elsewhere moves the seat
		await run(
			'room_join',
			{ room_id: 'other' },
			{ id: second.id, signal: second.controller.signal },
			actor
		);
		await assert_thrown(
			run(
				'room_join',
				{ room_id: 'line', rejoin_of: member_id },
				{ id: first.id, signal: first.controller.signal },
				actor
			),
			JSONRPC_ERROR_CODES.conflict,
			'room_seat_moved'
		);
		assert.strictEqual(calls, 2, 'the authorizer never ran for the rejoin');
	});

	test('a throwing authorizer withdraws the join', async () => {
		const { registry, connect, run } = setup({
			authorize: () => {
				throw new Error('query failed');
			}
		});
		const a = connect();
		try {
			await run('room_join', { room_id: 'line' }, { id: a.id, signal: a.controller.signal });
			assert.fail('expected the throw');
		} catch (error) {
			assert.match(String(error), /query failed/);
		}
		assert.strictEqual(registry.evict({ kind: 'room', room_id: 'line' }, 'evicted').pending, 0);
	});

	test('a leave supersedes a join held in the authorizer', async () => {
		const { authorize, held } = create_held_authorize();
		const { registry, connect, run } = setup(authorize);
		const a = connect();
		const actor = create_uuid();
		const connection = { id: a.id, signal: a.controller.signal };
		const joined = run('room_join', { room_id: 'line' }, connection, actor);
		await settle();
		assert.deepStrictEqual(await run('room_leave', { room_id: 'line' }, connection, actor), {
			left: true
		});
		held.shift()!.release({ allow: true });
		await assert_thrown(joined, JSONRPC_ERROR_CODES.conflict, 'room_join_superseded');
		assert.isNull(registry.occupancy('line'));
	});

	test('an eviction landing mid-authorizer wins', async () => {
		const { authorize, held } = create_held_authorize();
		const { registry, connect, run } = setup(authorize);
		const a = connect();
		const actor = create_uuid();
		const joined = run(
			'room_join',
			{ room_id: 'line' },
			{ id: a.id, signal: a.controller.signal },
			actor
		);
		await settle();
		assert.strictEqual(registry.evict({ kind: 'actor', actor_id: actor }, 'evicted').pending, 1);
		held.shift()!.release({ allow: true });
		await assert_thrown(joined, JSONRPC_ERROR_CODES.not_found, 'room_not_found');
	});

	test('without a connection the verbs answer method_not_found', async () => {
		const { connect, run } = setup({ authorize: () => ({ allow: true }) });
		connect();
		await assert_thrown(
			run(
				'room_send',
				{ room_id: 'line', to: null, payload: 'x' },
				{
					id: undefined,
					signal: new AbortController().signal
				}
			),
			JSONRPC_ERROR_CODES.method_not_found
		);
	});

	test('the limiter charges joins, sends, and state sets, not watches or leaves', async () => {
		const connections = new ConnectionRegistry({ log: null });
		const registry = new RoomRegistry(connections);
		const limiter = new RoomRateLimiter(
			{ max_requests: 2, max_bytes: DEFAULT_ROOM_RATE_LIMIT.max_bytes, window_ms: 60_000 },
			() => 0
		);
		const actions = create_room_actions({
			registry,
			authorize: { authorize: () => ({ allow: true }) },
			limiter
		});
		const handler = (method: string) => actions.find((a) => a.spec.method === method)!.handler;
		const controller = new AbortController();
		const id = connections.add_connection(
			create_fake_ws().ws,
			create_test_identity({ account_id: create_uuid() }),
			controller
		);
		const ctx = {
			auth: { account: { id: create_uuid() }, actor: { id: create_uuid() }, role_grants: [] },
			connection_id: id,
			db: {},
			signal: controller.signal
		} as unknown as ActionContext;
		await handler('room_join')({ room_id: 'line' }, ctx);
		await handler('room_send')({ room_id: 'line', to: null, payload: 'p' }, ctx);
		await handler('room_watch')({ room_id: 'w' }, ctx);
		await handler('room_unwatch')({ room_id: 'w' }, ctx);
		await handler('room_leave')({ room_id: 'line' }, ctx);
		await assert_thrown(
			Promise.resolve().then(() => handler('room_state_set')({ room_id: 'line', state: 's' }, ctx)),
			JSONRPC_ERROR_CODES.rate_limited
		);
	});
});
