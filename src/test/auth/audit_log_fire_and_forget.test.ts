/**
 * Tests for `audit_log_fire_and_forget` — resilience of fire-and-forget audit logging.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach} from 'vitest';
import {wait} from '@fuzdev/fuz_util/async.js';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {audit_log_fire_and_forget} from '$lib/auth/audit_log_queries.js';
import type {AuditLogEvent, AuditLogInput} from '$lib/auth/audit_log_schema.js';
import type {RouteContext} from '$lib/http/route_spec.js';

const log = new Logger('test', {level: 'error'});
const noop = (): void => {};

afterEach(() => {
	vi.restoreAllMocks();
});

const create_input = (): AuditLogInput => ({
	event_type: 'login',
	outcome: 'success',
	account_id: 'acct-1',
});

const FAKE_EVENT: AuditLogEvent = {
	id: '00000000-0000-4000-8000-000000000001',
	seq: 1,
	event_type: 'login',
	outcome: 'success',
	actor_id: null,
	account_id: 'acct-1',
	target_account_id: null,
	ip: null,
	created_at: '2025-01-01T00:00:00.000Z',
	metadata: null,
};

const create_mock_route = (
	mock_query?: ReturnType<typeof vi.fn>,
): Pick<RouteContext, 'background_db' | 'pending_effects'> => {
	const query = mock_query ?? vi.fn(() => Promise.resolve([FAKE_EVENT]));
	return {
		background_db: {query, query_one: vi.fn()} as any,
		pending_effects: [],
	};
};

describe('audit_log_fire_and_forget', () => {
	test('does not throw when query rejects', async () => {
		const mock_query = vi.fn(() => Promise.reject(new Error('DB connection lost')));
		const route = create_mock_route(mock_query);
		const spy_error = vi.spyOn(console, 'error').mockImplementation(() => {});

		// should not throw
		void audit_log_fire_and_forget(route, create_input(), log, noop);

		// wait for the rejected promise to settle
		await wait();

		assert.ok(spy_error.mock.calls.length > 0);
	});

	test('logs error via Logger when query rejects', async () => {
		const mock_query = vi.fn(() => Promise.reject(new Error('simulated failure')));
		const route = create_mock_route(mock_query);
		const spy_error = vi.spyOn(console, 'error').mockImplementation(() => {});

		void audit_log_fire_and_forget(route, create_input(), log, noop);

		await wait();

		assert.ok(spy_error.mock.calls.length > 0);
	});

	test('returns immediately without awaiting the query promise', () => {
		let resolve_query: ((value: Array<AuditLogEvent>) => void) | undefined;
		const query_promise = new Promise<Array<AuditLogEvent>>((resolve) => {
			resolve_query = resolve;
		});
		const mock_query = vi.fn(() => query_promise);
		const route = create_mock_route(mock_query);

		void audit_log_fire_and_forget(route, create_input(), log, noop);

		// query was called but its promise is still pending — function returned without awaiting
		assert.strictEqual(mock_query.mock.calls.length, 1);
		resolve_query!([FAKE_EVENT]);
	});

	test('forwards input to query_audit_log()', async () => {
		const mock_query = vi.fn(() => Promise.resolve([]));
		const route = create_mock_route(mock_query);
		const input = create_input();

		void audit_log_fire_and_forget(route, input, log, noop);
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
		const mock_query = vi.fn(() => Promise.resolve([FAKE_EVENT]));
		const route = create_mock_route(mock_query);
		const spy_error = vi.spyOn(console, 'error').mockImplementation(() => {});

		void audit_log_fire_and_forget(route, create_input(), log, noop);

		await wait();

		assert.strictEqual(spy_error.mock.calls.length, 0);
	});

	test('pushes promise to pending_effects', () => {
		const route = create_mock_route();

		void audit_log_fire_and_forget(route, create_input(), log, noop);

		assert.strictEqual(route.pending_effects.length, 1);
	});

	test('calls on_event callback with inserted row after successful write', async () => {
		const route = create_mock_route();
		const received: Array<AuditLogEvent> = [];

		void audit_log_fire_and_forget(route, create_input(), log, (event) => {
			received.push(event);
		});

		await wait();

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0]!.id, FAKE_EVENT.id);
		assert.strictEqual(received[0]!.event_type, FAKE_EVENT.event_type);
	});

	test('does not call on_event when query rejects', async () => {
		const mock_query = vi.fn(() => Promise.reject(new Error('DB down')));
		const route = create_mock_route(mock_query);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const received: Array<AuditLogEvent> = [];

		void audit_log_fire_and_forget(route, create_input(), log, (event) => {
			received.push(event);
		});

		await wait();

		assert.strictEqual(received.length, 0);
	});

	test('on_event callback error does not break the promise chain', async () => {
		const route = create_mock_route();
		const spy_error = vi.spyOn(console, 'error').mockImplementation(() => {});

		void audit_log_fire_and_forget(route, create_input(), log, () => {
			throw new Error('callback boom');
		});

		await wait();

		// the promise settled without rejecting (fire-and-forget is resilient)
		assert.strictEqual(route.pending_effects.length, 1);
		await Promise.allSettled(route.pending_effects);
		// error was logged with the correct message (not "write failed")
		const error_calls = spy_error.mock.calls;
		const has_callback_error = error_calls.some((call) =>
			call.some((arg: unknown) => String(arg).includes('on_event callback failed')),
		);
		assert.ok(has_callback_error, 'should log on_event callback error, not write error');
	});

	test('on_event callback error is distinguished from write error', async () => {
		const route = create_mock_route();
		const spy_error = vi.spyOn(console, 'error').mockImplementation(() => {});

		void audit_log_fire_and_forget(route, create_input(), log, () => {
			throw new Error('callback boom');
		});

		await wait();

		const all_args = spy_error.mock.calls.flat().map((arg: unknown) => String(arg));
		assert.ok(
			!all_args.some((msg) => msg.includes('write failed')),
			'should not say "write failed" when the callback failed',
		);
	});
});
