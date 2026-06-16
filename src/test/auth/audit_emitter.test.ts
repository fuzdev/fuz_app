/**
 * Tests for `create_audit_emitter` — resilience of the bound fire-and-forget
 * audit emitter.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach} from 'vitest';
import {wait} from '@fuzdev/fuz_util/async.ts';
import {Logger} from '@fuzdev/fuz_util/log.ts';

import {z} from 'zod';

import {create_audit_emitter} from '$lib/auth/audit_emitter.ts';
import {
	get_audit_metadata_validation_failures,
	get_audit_unknown_event_type_failures,
	reset_audit_metadata_validation_failures,
	reset_audit_unknown_event_type_failures,
} from '$lib/auth/audit_log_queries.ts';
import {
	create_audit_log_config,
	type AuditLogEvent,
	type AuditLogInput,
} from '$lib/auth/audit_log_schema.ts';
import type {Db} from '$lib/db/db.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';

const log = new Logger('test', {level: 'error'});
const noop = (): void => {};

afterEach(() => {
	vi.restoreAllMocks();
});

const create_input = (): AuditLogInput => ({
	event_type: 'login',
	outcome: 'success',
	account_id: 'acct-1' as Uuid,
});

const FAKE_EVENT: AuditLogEvent = {
	id: '00000000-0000-4000-8000-000000000001' as Uuid,
	seq: 1,
	event_type: 'login',
	outcome: 'success',
	actor_id: null,
	account_id: 'acct-1' as Uuid,
	target_account_id: null,
	target_actor_id: null,
	ip: null,
	created_at: '2025-01-01T00:00:00.000Z',
	metadata: null,
};

/** Stub `Db` whose `query` is a configurable mock. */
const create_mock_db = (mock_query?: ReturnType<typeof vi.fn>): Db => {
	const query = mock_query ?? vi.fn(() => Promise.resolve([FAKE_EVENT]));
	return {query, query_one: vi.fn()} as any;
};

const create_ctx = (): {pending_effects: Array<Promise<void>>} => ({pending_effects: []});

describe('create_audit_emitter — emit', () => {
	test('does not throw when query rejects', async () => {
		const db = create_mock_db(vi.fn(() => Promise.reject(new Error('DB connection lost'))));
		const audit = create_audit_emitter({db, log, on_audit_event: noop});
		const ctx = create_ctx();
		const spy_error = vi.spyOn(console, 'error').mockImplementation(() => {});

		// should not throw
		audit.emit(ctx, create_input());

		// wait for the rejected promise to settle
		await wait();

		assert.ok(spy_error.mock.calls.length > 0);
	});

	test('returns immediately without awaiting the query promise', () => {
		let resolve_query: ((value: Array<AuditLogEvent>) => void) | undefined;
		const query_promise = new Promise<Array<AuditLogEvent>>((resolve) => {
			resolve_query = resolve;
		});
		const mock_query = vi.fn(() => query_promise);
		const db = create_mock_db(mock_query);
		const audit = create_audit_emitter({db, log, on_audit_event: noop});
		const ctx = create_ctx();

		audit.emit(ctx, create_input());

		// query was called but its promise is still pending — function returned without awaiting
		assert.strictEqual(mock_query.mock.calls.length, 1);
		resolve_query!([FAKE_EVENT]);
	});

	test('forwards input to query_audit_log()', async () => {
		const mock_query = vi.fn(() => Promise.resolve([]));
		const db = create_mock_db(mock_query);
		const audit = create_audit_emitter({db, log, on_audit_event: noop});
		const ctx = create_ctx();
		const input = create_input();

		audit.emit(ctx, input);
		await wait();

		assert.strictEqual(mock_query.mock.calls.length, 1);
		const call_args = mock_query.mock.calls[0] as unknown as Array<unknown>;
		// query_audit_log passes the SQL string as arg 0 and params as arg 1
		assert.ok(typeof call_args[0] === 'string');
		const params = call_args[1] as Array<unknown>;
		assert.strictEqual(params[0], input.event_type);
		assert.strictEqual(params[1], input.outcome);
		assert.strictEqual(params[3], input.account_id);
	});

	test('successful query produces no console.error', async () => {
		const audit = create_audit_emitter({db: create_mock_db(), log, on_audit_event: noop});
		const ctx = create_ctx();
		const spy_error = vi.spyOn(console, 'error').mockImplementation(() => {});

		audit.emit(ctx, create_input());

		await wait();

		assert.strictEqual(spy_error.mock.calls.length, 0);
	});

	test('pushes promise to pending_effects', () => {
		const audit = create_audit_emitter({db: create_mock_db(), log, on_audit_event: noop});
		const ctx = create_ctx();

		audit.emit(ctx, create_input());

		assert.strictEqual(ctx.pending_effects.length, 1);
	});

	test('calls on_audit_event listener with inserted row after successful write', async () => {
		const received: Array<AuditLogEvent> = [];
		const audit = create_audit_emitter({
			db: create_mock_db(),
			log,
			on_audit_event: (event) => {
				received.push(event);
			},
		});
		const ctx = create_ctx();

		audit.emit(ctx, create_input());

		await wait();

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0]!.id, FAKE_EVENT.id);
		assert.strictEqual(received[0]!.event_type, FAKE_EVENT.event_type);
	});

	test('does not call listener when query rejects', async () => {
		const received: Array<AuditLogEvent> = [];
		const audit = create_audit_emitter({
			db: create_mock_db(vi.fn(() => Promise.reject(new Error('DB down')))),
			log,
			on_audit_event: (event) => {
				received.push(event);
			},
		});
		const ctx = create_ctx();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		audit.emit(ctx, create_input());

		await wait();

		assert.strictEqual(received.length, 0);
	});

	test('listener error does not break the promise chain', async () => {
		const audit = create_audit_emitter({
			db: create_mock_db(),
			log,
			on_audit_event: () => {
				throw new Error('callback boom');
			},
		});
		const ctx = create_ctx();
		const spy_error = vi.spyOn(console, 'error').mockImplementation(() => {});

		audit.emit(ctx, create_input());

		await wait();

		// the promise settled without rejecting (fire-and-forget is resilient)
		assert.strictEqual(ctx.pending_effects.length, 1);
		await Promise.allSettled(ctx.pending_effects);
		// error was logged with the correct message (not "write failed")
		const error_calls = spy_error.mock.calls;
		const has_callback_error = error_calls.some((call) =>
			call.some((arg: unknown) => String(arg).includes('listener failed')),
		);
		assert.ok(has_callback_error, 'should log listener error, not write error');
	});

	test('listener error is distinguished from write error', async () => {
		const audit = create_audit_emitter({
			db: create_mock_db(),
			log,
			on_audit_event: () => {
				throw new Error('callback boom');
			},
		});
		const ctx = create_ctx();
		const spy_error = vi.spyOn(console, 'error').mockImplementation(() => {});

		audit.emit(ctx, create_input());

		await wait();

		const all_args = spy_error.mock.calls.flat().map((arg: unknown) => String(arg));
		assert.ok(
			!all_args.some((msg) => msg.includes('write failed')),
			'should not say "write failed" when the callback failed',
		);
	});

	test('omitted audit_log_config defaults to BUILTIN — builtin event_type emits no drift counter bump', async () => {
		reset_audit_unknown_event_type_failures();
		reset_audit_metadata_validation_failures();
		try {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const audit = create_audit_emitter({db: create_mock_db(), log, on_audit_event: noop});
			const ctx = create_ctx();

			audit.emit(ctx, create_input());
			await wait();

			assert.strictEqual(get_audit_unknown_event_type_failures(), 0);
			assert.strictEqual(get_audit_metadata_validation_failures(), 0);
		} finally {
			reset_audit_unknown_event_type_failures();
			reset_audit_metadata_validation_failures();
		}
	});

	test('unknown event_type bumps unknown-event counter when audit_log_config is omitted', async () => {
		reset_audit_unknown_event_type_failures();
		try {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const audit = create_audit_emitter({db: create_mock_db(), log, on_audit_event: noop});
			const ctx = create_ctx();

			audit.emit(ctx, {
				event_type: 'classroom_create',
				metadata: {ok: true},
			} as AuditLogInput<string>);
			await wait();

			assert.strictEqual(get_audit_unknown_event_type_failures(), 1);
		} finally {
			reset_audit_unknown_event_type_failures();
		}
	});

	test('audit_log_config carrying the event_type suppresses the unknown-event counter bump', async () => {
		reset_audit_unknown_event_type_failures();
		try {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const audit_log_config = create_audit_log_config({
				extra_events: {classroom_create: null},
			});
			const audit = create_audit_emitter({
				db: create_mock_db(),
				log,
				on_audit_event: noop,
				audit_log_config,
			});
			const ctx = create_ctx();

			audit.emit(ctx, {
				event_type: 'classroom_create',
				metadata: {ok: true},
			} as AuditLogInput<string>);
			await wait();

			assert.strictEqual(get_audit_unknown_event_type_failures(), 0);
		} finally {
			reset_audit_unknown_event_type_failures();
		}
	});

	test('metadata mismatch against audit_log_config schema bumps the metadata counter', async () => {
		reset_audit_metadata_validation_failures();
		try {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const audit_log_config = create_audit_log_config({
				extra_events: {
					classroom_create: z.looseObject({classroom_id: z.string(), name: z.string()}),
				},
			});
			const audit = create_audit_emitter({
				db: create_mock_db(),
				log,
				on_audit_event: noop,
				audit_log_config,
			});
			const ctx = create_ctx();

			audit.emit(ctx, {
				event_type: 'classroom_create',
				metadata: {classroom_id: 42, name: 'Period 3'},
			} as AuditLogInput<string>);
			await wait();

			assert.strictEqual(get_audit_metadata_validation_failures(), 1);
		} finally {
			reset_audit_metadata_validation_failures();
		}
	});
});

describe('create_audit_emitter — on_event_chain', () => {
	test('appended listener fires alongside the initial subscriber', async () => {
		const initial: Array<AuditLogEvent> = [];
		const appended: Array<AuditLogEvent> = [];
		const audit = create_audit_emitter({
			db: create_mock_db(),
			log,
			on_audit_event: (event) => initial.push(event),
		});
		audit.on_event_chain.push((event) => appended.push(event));
		const ctx = create_ctx();

		audit.emit(ctx, create_input());
		await wait();

		assert.strictEqual(initial.length, 1);
		assert.strictEqual(appended.length, 1);
	});

	test('listener throw in earlier slot does not skip later listeners', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const reached: Array<AuditLogEvent> = [];
		const audit = create_audit_emitter({
			db: create_mock_db(),
			log,
			on_audit_event: () => {
				throw new Error('first listener boom');
			},
		});
		audit.on_event_chain.push((event) => reached.push(event));
		const ctx = create_ctx();

		audit.emit(ctx, create_input());
		await wait();

		assert.strictEqual(reached.length, 1);
	});
});

describe('create_audit_emitter — notify', () => {
	test('fans pre-written event to every listener on the chain', () => {
		const a: Array<AuditLogEvent> = [];
		const b: Array<AuditLogEvent> = [];
		const audit = create_audit_emitter({
			db: create_mock_db(),
			log,
			on_audit_event: (event) => a.push(event),
		});
		audit.on_event_chain.push((event) => b.push(event));

		audit.notify(FAKE_EVENT);

		assert.strictEqual(a.length, 1);
		assert.strictEqual(b.length, 1);
	});
});

describe('create_audit_emitter — frozen shape', () => {
	// The freeze is the load-bearing invariant that made the pre-decorator
	// `patch_audit_emit_capture` go away — assignment to any of the four
	// method slots used to silently bypass `emit_role_grant_target`'s
	// closure-captured `emit`. The freeze converts that footgun into a
	// loud TypeError. `on_event_chain` is left mutable on purpose so
	// `create_app_server` can `.push(listener)` post-build.
	test('returned object is frozen', () => {
		const audit = create_audit_emitter({db: create_mock_db(), log});
		assert.strictEqual(Object.isFrozen(audit), true);
	});

	test('assignment to emit slot throws in strict mode', () => {
		const audit = create_audit_emitter({db: create_mock_db(), log});
		// `Object.freeze` is a runtime guard — the `emit` slot's interface
		// shape happens to be method-compatible with the replacement, so
		// TypeScript wouldn't flag the write. The freeze still throws at
		// runtime under strict mode (ESM modules are always strict).
		assert.throws(() => {
			(audit as unknown as {emit: () => void}).emit = () => undefined;
		}, TypeError);
	});

	test('on_event_chain.push continues to work post-build', () => {
		// `create_app_server` relies on this; if the array itself got
		// frozen accidentally the production SSE / WS guard composition
		// breaks at server assembly. Keep both invariants pinned.
		const audit = create_audit_emitter({db: create_mock_db(), log});
		const received: Array<AuditLogEvent> = [];
		audit.on_event_chain.push((event) => received.push(event));
		audit.notify(FAKE_EVENT);
		assert.strictEqual(received.length, 1);
	});
});

describe('create_audit_emitter — emit_role_grant_target', () => {
	// Verifies the lift wrapper actually delegates to the inner `emit`
	// and forwards the role-grant-shape envelope unchanged. Direct
	// coverage was missing before the `emit_decorator` refactor — adding
	// it now so a future change to the lift logic surfaces here instead
	// of inside an integration suite.
	const create_auth = (): {
		account: {id: Uuid};
		actor: {id: Uuid};
	} => ({
		account: {id: 'acct-rg' as Uuid},
		actor: {id: 'actor-rg' as Uuid},
	});

	test('delegates to inner emit_pool and pushes onto pending_effects', async () => {
		const db = create_mock_db();
		const audit = create_audit_emitter({db, log});
		const ctx = {pending_effects: [] as Array<Promise<void>>, client_ip: '203.0.113.1'};
		const auth = create_auth();

		audit.emit_role_grant_target(ctx, auth as never, {
			event_type: 'role_grant_create',
			target_account_id: 'tgt-acct' as Uuid,
			target_actor_id: 'tgt-actor' as Uuid,
			metadata: {role: 'admin', scope_id: null},
		});

		assert.strictEqual(ctx.pending_effects.length, 1);
		await Promise.all(ctx.pending_effects);
		// `db.query` is the underlying insert path — one call per emit.
		assert.strictEqual((db.query as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});

	test('lifts actor_id / account_id / ip from auth + ctx into the inner emit input', () => {
		// Intercept the lifted shape via `emit_decorator` — the cleanest
		// view of what `emit_role_grant_target` passes to the closed-over
		// `emit`. The decorator runs inside the closure (see
		// `emit_decorator` tests below), so the lifted input lands here.
		const observed: Array<AuditLogInput> = [];
		const audit = create_audit_emitter({
			db: create_mock_db(),
			log,
			emit_decorator: (inner) => (ctx, input) => {
				observed.push(input as AuditLogInput);
				inner(ctx, input);
			},
		});
		const ctx = {pending_effects: [] as Array<Promise<void>>, client_ip: '198.51.100.7'};
		const auth = create_auth();

		audit.emit_role_grant_target(ctx, auth as never, {
			event_type: 'role_grant_revoke',
			target_account_id: 'tgt-acct' as Uuid,
			target_actor_id: 'tgt-actor' as Uuid,
			metadata: {role: 'admin', role_grant_id: 'rg-1' as Uuid, scope_id: null},
			outcome: 'success',
		});

		assert.strictEqual(observed.length, 1);
		const lifted = observed[0]!;
		assert.strictEqual(lifted.actor_id, auth.actor.id);
		assert.strictEqual(lifted.account_id, auth.account.id);
		assert.strictEqual(lifted.ip, '198.51.100.7');
		assert.strictEqual(lifted.target_account_id, 'tgt-acct');
		assert.strictEqual(lifted.target_actor_id, 'tgt-actor');
		assert.strictEqual(lifted.outcome, 'success');
	});
});

describe('create_audit_emitter — emit_decorator', () => {
	// The decorator was added to close the role-grant-shape ordering
	// blind spot — the previous test helper wrapped `emit` post-build,
	// which `emit_role_grant_target`'s closure-captured `emit` never
	// noticed. The decorator runs INSIDE the closure so both call shapes
	// route through it. These three tests are the executable record of
	// that contract.
	test('wraps emit so the wrapped function is what the slot exposes', () => {
		const calls: Array<{ctx: unknown; input: AuditLogInput}> = [];
		const audit = create_audit_emitter({
			db: create_mock_db(),
			log,
			emit_decorator: (inner) => (ctx, input) => {
				calls.push({ctx, input: input as AuditLogInput});
				inner(ctx, input);
			},
		});

		const ctx = create_ctx();
		audit.emit(ctx, create_input());

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0]!.input.event_type, 'login');
	});

	test('emit_role_grant_target also routes through the decorator', () => {
		// The whole point of the decorator vs the old hot-patch — the
		// inner closure captures the decorated `emit`, so role-grant-shape
		// emissions land in the same capture array as bare `emit` calls.
		// If this ever regresses (decorator stops being captured by the
		// inner closure), the close-vs-emit ordering test in
		// `connection_closer.db.test.ts` would silently skip role-grant
		// markers.
		const calls: Array<AuditLogInput> = [];
		const audit = create_audit_emitter({
			db: create_mock_db(),
			log,
			emit_decorator: (inner) => (ctx, input) => {
				calls.push(input as AuditLogInput);
				inner(ctx, input);
			},
		});

		const ctx = {pending_effects: [] as Array<Promise<void>>, client_ip: '1.2.3.4'};
		audit.emit_role_grant_target(
			ctx,
			{account: {id: 'a' as Uuid}, actor: {id: 'b' as Uuid}} as never,
			{
				event_type: 'role_grant_create',
				target_account_id: null,
				target_actor_id: null,
				metadata: {role: 'admin', scope_id: null},
			},
		);

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0]!.event_type, 'role_grant_create');
	});

	test('default (no decorator) leaves emit semantically unchanged', () => {
		const audit = create_audit_emitter({db: create_mock_db(), log});
		const ctx = create_ctx();
		audit.emit(ctx, create_input());
		// One in-flight write queued — same shape the test suite has
		// relied on since before the decorator existed.
		assert.strictEqual(ctx.pending_effects.length, 1);
	});
});
