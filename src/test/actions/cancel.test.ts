/**
 * Tests for the shared `cancel_action` — the second composable fuz_app
 * primitive. Verifies the spec parses under `RemoteNotificationActionSpec`,
 * the tuple composes, and a client→server `cancel` notification aborts the
 * matching pending handler via the dispatcher's per-connection
 * `{request_id → AbortController}` map. Cross-socket isolation, idempotency
 * on unknown ids, and post-completion late-cancel safety are covered here
 * rather than in `register_action_ws.test.ts` so the cancel semantics have a
 * single, discoverable test file.
 *
 * @module
 */

import {assert, describe, test} from 'vitest';
import {z} from 'zod';

import {RequestResponseActionSpec} from '$lib/actions/action_spec.js';
import {
	CancelNotificationParams,
	cancel_action,
	cancel_action_spec,
	cancel_handler,
} from '$lib/actions/cancel.js';
import {create_ws_test_harness} from '$lib/testing/ws_round_trip.js';

describe('cancel_action', () => {
	test('spec has the expected method + shape', () => {
		assert.strictEqual(cancel_action_spec.method, 'cancel');
		assert.strictEqual(cancel_action_spec.kind, 'remote_notification');
		assert.strictEqual(cancel_action_spec.initiator, 'frontend');
		assert.strictEqual(cancel_action_spec.auth, null);
		assert.strictEqual(cancel_action_spec.side_effects, true);
	});

	test('CancelNotificationParams accepts numeric and string ids; rejects extras and missing', () => {
		assert.strictEqual(CancelNotificationParams.safeParse({request_id: 1}).success, true);
		assert.strictEqual(CancelNotificationParams.safeParse({request_id: 'abc'}).success, true);
		assert.strictEqual(CancelNotificationParams.safeParse({}).success, false);
		assert.strictEqual(
			CancelNotificationParams.safeParse({request_id: 1, stray: 1}).success,
			false,
		);
	});

	test('handler is a no-op (dispatcher owns cancel semantics)', () => {
		assert.doesNotThrow(cancel_handler);
	});

	test('composable tuple carries spec and handler', () => {
		assert.strictEqual(cancel_action.spec, cancel_action_spec);
		assert.strictEqual(cancel_action.handler, cancel_handler);
	});
});

// ------------------------------------------------------------------
// Dispatcher-integration tests. Use a test `slow` spec whose handler
// awaits until its ctx.signal aborts, emits progress via ctx.notify, then
// throws so the dispatcher sends an error frame — mirroring how a real
// streaming handler (e.g. zzz's completion_create) would bail on cancel.
// ------------------------------------------------------------------

const slow_spec = RequestResponseActionSpec.parse({
	method: 'slow',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'none'},
	side_effects: false,
	input: z.strictObject({}),
	output: z.strictObject({}),
	async: true,
	description: 'test — waits until ctx.signal aborts, then throws',
});

const wait_for_abort = (signal: AbortSignal): Promise<void> =>
	new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		signal.addEventListener('abort', () => resolve(), {once: true});
	});

describe('cancel via register_action_ws', () => {
	test('cancel notification aborts the matching in-flight handler', async () => {
		const harness = create_ws_test_harness({
			actions: [
				cancel_action,
				{
					spec: slow_spec,
					handler: async (_input, ctx) => {
						await wait_for_abort(ctx.signal);
						throw new Error('aborted mid-stream');
					},
				},
			],
		});
		const client = await harness.connect();

		void client.send({jsonrpc: '2.0', id: 42, method: 'slow', params: {}});
		// Give the dispatcher a tick to register the pending controller.
		await Promise.resolve();
		await client.send({
			jsonrpc: '2.0',
			method: cancel_action_spec.method,
			params: {request_id: 42},
		});

		// Response should be an error frame for id 42, triggered by the
		// handler bailing on its ctx.signal aborting.
		const frame = await client.wait_for(
			(msg): msg is {jsonrpc: '2.0'; id: number; error: {code: number; message: string}} =>
				typeof msg === 'object' && msg !== null && 'id' in msg && 'error' in msg,
		);
		assert.strictEqual(frame.id, 42);
		assert.match(frame.error.message, /aborted mid-stream/);
	});

	test('cancel for unknown/completed request id is a no-op (idempotent)', async () => {
		const harness = create_ws_test_harness({
			actions: [
				cancel_action,
				{
					spec: slow_spec,
					handler: () => ({}),
				},
			],
		});
		const client = await harness.connect();

		// Cancel for an id that never had a pending request. No error frame
		// is sent back; the dispatcher silently drops it.
		await client.send({
			jsonrpc: '2.0',
			method: cancel_action_spec.method,
			params: {request_id: 99999},
		});
		// Send a real request to prove dispatch is still healthy.
		const result = await client.request(1, 'slow', {});
		assert.deepStrictEqual(result, {});
	});

	test('cancel with invalid params is ignored (no error frame sent)', async () => {
		const harness = create_ws_test_harness({
			actions: [cancel_action, {spec: slow_spec, handler: () => ({})}],
		});
		const client = await harness.connect();

		await client.send({jsonrpc: '2.0', method: cancel_action_spec.method, params: {wrong_key: 1}});
		// No error frame — the dispatcher only rejects malformed envelopes on
		// the request path. Follow-up request still dispatches.
		const result = await client.request(1, 'slow', {});
		assert.deepStrictEqual(result, {});
		// No error frame arrived for the bad cancel.
		const error_frames = client.messages.filter(
			(m) => typeof m === 'object' && m !== null && 'error' in m,
		);
		assert.strictEqual(error_frames.length, 0);
	});

	test('cancel on one socket does not abort a different socket’s pending request', async () => {
		const saw_abort: {a: boolean; b: boolean} = {a: false, b: false};
		const harness = create_ws_test_harness({
			actions: [
				cancel_action,
				{
					spec: slow_spec,
					handler: async (_input, ctx) => {
						const tag = ctx.request_id === 'a' ? 'a' : 'b';
						await wait_for_abort(ctx.signal);
						saw_abort[tag] = true;
						throw new Error(`${tag} aborted`);
					},
				},
			],
		});
		const client_a = await harness.connect();
		const client_b = await harness.connect();

		void client_a.send({jsonrpc: '2.0', id: 'a', method: 'slow', params: {}});
		void client_b.send({jsonrpc: '2.0', id: 'b', method: 'slow', params: {}});
		await Promise.resolve();

		// Client A cancels using id 'b' — a different socket's id. Must not
		// reach client B's controller.
		await client_a.send({
			jsonrpc: '2.0',
			method: cancel_action_spec.method,
			params: {request_id: 'b'},
		});

		// Wait a tick to let any stray abort propagate.
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.strictEqual(saw_abort.a, false);
		assert.strictEqual(saw_abort.b, false);

		// Now client A cancels its own id.
		await client_a.send({
			jsonrpc: '2.0',
			method: cancel_action_spec.method,
			params: {request_id: 'a'},
		});
		const frame = await client_a.wait_for(
			(msg): msg is {id: string | number; error: {message: string}} =>
				typeof msg === 'object' && msg !== null && 'error' in msg && 'id' in msg,
		);
		assert.strictEqual(frame.id, 'a');
		assert.match(frame.error.message, /a aborted/);
		assert.strictEqual(saw_abort.a, true);
		assert.strictEqual(saw_abort.b, false);

		// Clean up client B so its handler doesn't hang the test.
		await client_b.close();
	});

	test('socket close aborts in-flight handler via the socket_abort chain', async () => {
		let signal_at_close: AbortSignal | null = null as any;
		const harness = create_ws_test_harness({
			actions: [
				cancel_action,
				{
					spec: slow_spec,
					handler: async (_input, ctx) => {
						signal_at_close = ctx.signal;
						await wait_for_abort(ctx.signal);
						throw new Error('aborted via close');
					},
				},
			],
		});
		const client = await harness.connect();

		void client.send({jsonrpc: '2.0', id: 7, method: 'slow', params: {}});
		await Promise.resolve();
		assert.ok(signal_at_close);
		assert.strictEqual(signal_at_close.aborted, false);

		await client.close();
		assert.strictEqual(signal_at_close.aborted, true);
	});

	test('per-request signals are isolated — cancel id=1 does not abort id=2', async () => {
		const signals: Map<number, AbortSignal> = new Map();
		const harness = create_ws_test_harness({
			actions: [
				cancel_action,
				{
					spec: slow_spec,
					handler: async (_input, ctx) => {
						signals.set(ctx.request_id as number, ctx.signal);
						await wait_for_abort(ctx.signal);
						throw new Error(`id=${String(ctx.request_id)} aborted`);
					},
				},
			],
		});
		const client = await harness.connect();

		void client.send({jsonrpc: '2.0', id: 1, method: 'slow', params: {}});
		void client.send({jsonrpc: '2.0', id: 2, method: 'slow', params: {}});
		await Promise.resolve();
		await Promise.resolve();
		assert.ok(signals.get(1));
		assert.ok(signals.get(2));

		await client.send({jsonrpc: '2.0', method: cancel_action_spec.method, params: {request_id: 1}});

		const frame = await client.wait_for(
			(msg): msg is {id: number; error: {message: string}} =>
				typeof msg === 'object' &&
				msg !== null &&
				'error' in msg &&
				'id' in msg &&
				(msg as {id: unknown}).id === 1,
		);
		assert.strictEqual(frame.id, 1);
		assert.strictEqual(signals.get(1)!.aborted, true);
		assert.strictEqual(signals.get(2)!.aborted, false);

		// Clean up id=2 so its handler unwinds.
		await client.close();
	});
});
