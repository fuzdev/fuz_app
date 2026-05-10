/**
 * Tests for `create_audit_emitter` — resilience of the bound fire-and-forget
 * audit emitter.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach} from 'vitest';
import {wait} from '@fuzdev/fuz_util/async.js';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {z} from 'zod';

import {create_audit_emitter} from '$lib/auth/audit_emitter.js';
import {
	get_audit_metadata_validation_failures,
	get_audit_unknown_event_type_failures,
	reset_audit_metadata_validation_failures,
	reset_audit_unknown_event_type_failures,
} from '$lib/auth/audit_log_queries.js';
import {
	create_audit_log_config,
	type AuditLogEvent,
	type AuditLogInput,
} from '$lib/auth/audit_log_schema.js';
import type {Db} from '$lib/db/db.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

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
