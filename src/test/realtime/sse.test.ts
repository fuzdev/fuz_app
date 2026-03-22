/**
 * Tests for backend_sse - SSE streaming utilities.
 *
 * @module
 */

import {describe, assert, test, vi} from 'vitest';
import {Hono} from 'hono';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {
	create_sse_response,
	create_validated_broadcaster,
	SSE_CONNECTED_COMMENT,
	type SseNotification,
	type SseEventSpec,
	type SseStream,
} from '$lib/realtime/sse.js';
import {SubscriberRegistry} from '$lib/realtime/subscriber_registry.js';

const log = new Logger('test', {level: 'off'});

/** Helper — expected prefix for all SSE responses. */
const C = SSE_CONNECTED_COMMENT;

describe('create_sse_response', () => {
	test('returns response with correct SSE headers', async () => {
		const app = new Hono();

		app.get('/sse', (c) => {
			const {response} = create_sse_response(c, log);
			return response;
		});

		const response = await app.request('/sse');

		assert.strictEqual(response.headers.get('Content-Type'), 'text/event-stream');
		assert.strictEqual(response.headers.get('Cache-Control'), 'no-cache');
		assert.strictEqual(response.headers.get('Connection'), 'keep-alive');
		assert.strictEqual(response.headers.get('Transfer-Encoding'), 'chunked');
	});

	test('stream.send serializes data as JSON SSE format', async () => {
		const app = new Hono();

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response<{msg: string}>(c, log);
			stream.send({msg: 'hello'});
			stream.close();
			return response;
		});

		const response = await app.request('/sse');
		const text = await response.text();
		assert.strictEqual(text, `${C}data: {"msg":"hello"}\n\n`);
	});

	test('stream.comment sends SSE comment format', async () => {
		const app = new Hono();

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response(c, log);
			stream.comment('keep-alive');
			stream.close();
			return response;
		});

		const response = await app.request('/sse');
		const text = await response.text();
		assert.strictEqual(text, `${C}: keep-alive\n`);
	});

	test('stream.send is a no-op after close', async () => {
		const app = new Hono();

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response<string>(c, log);
			stream.send('before');
			stream.close();
			stream.send('after'); // should be ignored
			return response;
		});

		const response = await app.request('/sse');
		const text = await response.text();
		assert.strictEqual(text, `${C}data: "before"\n\n`);
	});

	test('multiple sends produce multiple SSE events', async () => {
		const app = new Hono();

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response<number>(c, log);
			stream.send(1);
			stream.send(2);
			stream.send(3);
			stream.close();
			return response;
		});

		const response = await app.request('/sse');
		const text = await response.text();
		assert.strictEqual(text, `${C}data: 1\n\ndata: 2\n\ndata: 3\n\n`);
	});

	test('close is idempotent', async () => {
		const app = new Hono();

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response(c, log);
			stream.close();
			stream.close(); // should not throw
			return response;
		});

		const response = await app.request('/sse');
		const text = await response.text();
		assert.strictEqual(text, C);
	});

	test('on_close listeners fire on close', async () => {
		const app = new Hono();
		const calls: Array<string> = [];

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response(c, log);
			stream.on_close(() => calls.push('a'));
			stream.on_close(() => calls.push('b'));
			stream.close();
			return response;
		});

		await app.request('/sse');
		assert.deepStrictEqual(calls, ['a', 'b']);
	});

	test('on_close listeners fire only once on multiple close calls', async () => {
		const app = new Hono();
		let call_count = 0;

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response(c, log);
			stream.on_close(() => call_count++);
			stream.close();
			stream.close();
			return response;
		});

		await app.request('/sse');
		assert.strictEqual(call_count, 1);
	});

	test('stream.comment is a no-op after close', async () => {
		const app = new Hono();

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response(c, log);
			stream.comment('before');
			stream.close();
			stream.comment('after'); // should be ignored
			return response;
		});

		const response = await app.request('/sse');
		const text = await response.text();
		assert.strictEqual(text, `${C}: before\n`);
	});

	test('on_close registered after close does not fire', async () => {
		const app = new Hono();
		let called = false;

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response(c, log);
			stream.close();
			stream.on_close(() => {
				called = true;
			});
			return response;
		});

		await app.request('/sse');
		assert.strictEqual(called, false);
	});

	test('on_close unsubscribes from SubscriberRegistry on close', async () => {
		const app = new Hono();
		const registry = new SubscriberRegistry<string>();

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response<string>(c, log);
			const unsubscribe = registry.subscribe(stream, ['ch']);
			stream.on_close(unsubscribe);
			stream.send('before');
			assert.strictEqual(registry.count, 1);
			stream.close();
			assert.strictEqual(registry.count, 0);
			return response;
		});

		const response = await app.request('/sse');
		const text = await response.text();
		assert.strictEqual(text, `${C}data: "before"\n\n`);
	});

	test('body.cancel() triggers on_close via abort', async () => {
		const app = new Hono();
		let closed = false;

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response(c, log);
			stream.on_close(() => {
				closed = true;
			});
			// NOT calling stream.close() — relies on abort path
			return response;
		});

		const response = await app.request('/sse');
		assert.strictEqual(closed, false);
		await response.body?.cancel();
		assert.strictEqual(closed, true);
	});

	test('throwing on_close listener does not prevent other listeners', async () => {
		const app = new Hono();
		const calls: Array<string> = [];

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response(c, log);
			stream.on_close(() => calls.push('a'));
			stream.on_close(() => {
				throw new Error('boom');
			});
			stream.on_close(() => calls.push('c'));
			stream.close();
			return response;
		});

		await app.request('/sse');
		assert.deepStrictEqual(calls, ['a', 'c']);
	});

	test('broadcast after close does not throw', async () => {
		const app = new Hono();
		const registry = new SubscriberRegistry<string>();

		app.get('/sse', (c) => {
			const {response, stream} = create_sse_response<string>(c, log);
			const unsubscribe = registry.subscribe(stream, ['ch']);
			stream.on_close(unsubscribe);
			stream.close();
			// broadcast to empty registry — should not throw
			registry.broadcast('ch', 'orphaned');
			return response;
		});

		const response = await app.request('/sse');
		const text = await response.text();
		assert.strictEqual(text, C);
	});
});

describe('create_validated_broadcaster', () => {
	const test_specs: Array<SseEventSpec> = [
		{
			method: 'run_created',
			params: z.strictObject({run_id: z.string(), status: z.string()}),
			description: 'A run was created',
			channel: 'runs',
		},
		{
			method: 'run_updated',
			params: z.strictObject({run_id: z.string(), status: z.string()}),
			description: 'A run was updated',
		},
	];

	test('passes valid data through to broadcaster', () => {
		const calls: Array<{channel: string; data: SseNotification}> = [];
		const inner = {
			broadcast: (channel: string, data: SseNotification) => calls.push({channel, data}),
		};
		const validated = create_validated_broadcaster(inner, test_specs, log);

		validated.broadcast('runs', {method: 'run_created', params: {run_id: '1', status: 'running'}});
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0]!.channel, 'runs');
		assert.strictEqual(calls[0]!.data.method, 'run_created');
	});

	test('warns on unknown method', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const inner = {broadcast: vi.fn()};
		const warn_log = new Logger('test', {level: 'warn'});
		const validated = create_validated_broadcaster(inner, test_specs, warn_log);

		validated.broadcast('runs', {method: 'unknown_method', params: {}});
		assert.strictEqual(warn.mock.calls.length, 1);
		assert.include(String(warn.mock.calls[0]![1]), 'unknown_method');
		// still broadcasts
		assert.strictEqual(inner.broadcast.mock.calls.length, 1);
		warn.mockRestore();
	});

	test('warns on invalid params', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const inner = {broadcast: vi.fn()};
		const warn_log = new Logger('test', {level: 'warn'});
		const validated = create_validated_broadcaster(inner, test_specs, warn_log);

		validated.broadcast('runs', {method: 'run_created', params: {bad: true}});
		assert.strictEqual(warn.mock.calls.length, 1);
		assert.include(String(warn.mock.calls[0]![1]), 'run_created');
		// still broadcasts even on validation failure
		assert.strictEqual(inner.broadcast.mock.calls.length, 1);
		warn.mockRestore();
	});

	test('always broadcasts even on validation failure', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const calls: Array<SseNotification> = [];
		const inner = {broadcast: (_ch: string, data: SseNotification) => calls.push(data)};
		const validated = create_validated_broadcaster(inner, test_specs, log);

		validated.broadcast('runs', {method: 'unknown', params: {}});
		assert.strictEqual(calls.length, 1);
		warn.mockRestore();
	});

	test('empty event_specs list still works', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const inner = {broadcast: vi.fn()};
		const warn_log = new Logger('test', {level: 'warn'});
		const validated = create_validated_broadcaster(inner, [], warn_log);

		validated.broadcast('ch', {method: 'anything', params: {}});
		// warns because no specs match
		assert.strictEqual(warn.mock.calls.length, 1);
		assert.strictEqual(inner.broadcast.mock.calls.length, 1);
		warn.mockRestore();
	});

	test('broadcasts through SubscriberRegistry to subscribed streams', () => {
		const registry = new SubscriberRegistry<SseNotification>();
		const validated = create_validated_broadcaster(registry, test_specs, log);

		// subscribe two mock streams to different channels
		const runs_received: Array<SseNotification> = [];
		const all_received: Array<SseNotification> = [];
		const make_stream = (bucket: Array<SseNotification>): SseStream<SseNotification> => ({
			send: (data) => bucket.push(data),
			comment: () => {},
			close: () => {},
			on_close: () => {},
		});
		const unsub_runs = registry.subscribe(make_stream(runs_received), ['runs']);
		registry.subscribe(make_stream(all_received)); // no filter = all channels

		// broadcast to 'runs' channel through validated broadcaster
		const notification: SseNotification = {
			method: 'run_created',
			params: {run_id: '1', status: 'running'},
		};
		validated.broadcast('runs', notification);

		assert.strictEqual(runs_received.length, 1);
		assert.deepStrictEqual(runs_received[0], notification);
		assert.strictEqual(all_received.length, 1);
		assert.deepStrictEqual(all_received[0], notification);

		// after unsubscribe, stream no longer receives
		unsub_runs();
		validated.broadcast('runs', {method: 'run_updated', params: {run_id: '1', status: 'done'}});
		assert.strictEqual(runs_received.length, 1);
		assert.strictEqual(all_received.length, 2);
	});
});
