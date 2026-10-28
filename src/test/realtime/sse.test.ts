/**
 * Tests for backend_sse - SSE streaming utilities.
 *
 * @module
 */

import { describe, assert, test, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	create_sse_response,
	create_validated_broadcaster,
	type SseNotification,
	type EventSpec,
	type SseStream
} from '#lib/realtime/sse.ts';
import {
	SSE_CONNECTED_COMMENT,
	SSE_KEEP_ALIVE_COMMENT,
	SSE_KEEP_ALIVE_INTERVAL_MS,
	SSE_KEEP_ALIVE_INTERVAL_MS_MAX,
	SSE_OUTBOUND_QUEUE_BYTES,
	validate_sse_keep_alive_ms
} from '#lib/realtime/sse_constants.ts';
import { SseRegistry } from '#lib/realtime/sse_registry.ts';
import { OUTBOUND_FRAME_OVERHEAD_BYTES } from '#lib/realtime/outbound_budget.ts';

const log = new Logger('test', { level: 'off' });

/** Helper — expected prefix for all SSE responses. */
const C = SSE_CONNECTED_COMMENT;

/** Bytes of one `send` frame carrying a string of `length` characters. */
const frame_of = (text: string): string => `data: ${JSON.stringify(text)}\n\n`;

/** A logger that records its `warn` calls. */
const create_warn_log = (): { warn_log: Logger; warns: Array<Array<unknown>> } => {
	const warns: Array<Array<unknown>> = [];
	const warn_log = new Logger('test', { level: 'off' });
	warn_log.warn = (...args: Array<unknown>) => {
		warns.push(args);
	};
	return { warn_log, warns };
};

describe('create_sse_response', () => {
	test('returns response with correct SSE headers', async () => {
		const app = new Hono();

		app.get('/sse', (c) => {
			const { response } = create_sse_response(c, log);
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
			const { response, stream } = create_sse_response<{ msg: string }>(c, log);
			stream.send({ msg: 'hello' });
			stream.close();
			return response;
		});

		const response = await app.request('/sse');
		const text = await response.text();
		assert.strictEqual(text, `${C}data: {"msg":"hello"}\n\n`);
	});

	test('stream.send is a no-op after close', async () => {
		const app = new Hono();

		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response<string>(c, log);
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
			const { response, stream } = create_sse_response<number>(c, log);
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
			const { response, stream } = create_sse_response(c, log);
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
			const { response, stream } = create_sse_response(c, log);
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
			const { response, stream } = create_sse_response(c, log);
			stream.on_close(() => call_count++);
			stream.close();
			stream.close();
			return response;
		});

		await app.request('/sse');
		assert.strictEqual(call_count, 1);
	});

	test('on_close registered after close runs at once, and only that once', async () => {
		const app = new Hono();
		let calls = 0;

		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response(c, log);
			stream.close();
			stream.on_close(() => {
				calls++;
			});
			assert.strictEqual(calls, 1, 'a late listener runs when it is registered');
			stream.close();
			return response;
		});

		await app.request('/sse');
		assert.strictEqual(calls, 1);
	});

	test('a request whose client aborts closes the stream without the body being read', async () => {
		const app = new Hono();
		const registry = new SseRegistry<unknown>();
		const controller = new AbortController();

		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response(c, log);
			stream.on_close(registry.subscribe(stream));
			return response;
		});

		const response = await app.request(
			new Request('http://localhost/sse', { signal: controller.signal })
		);
		assert.strictEqual(registry.count, 1);
		controller.abort();
		assert.strictEqual(registry.count, 0, 'the abort closed and unsubscribed the stream');
		await response.body?.cancel();
	});

	test('a request already aborted yields a closed stream, and a late on_close cleans up', async () => {
		const app = new Hono();
		const registry = new SseRegistry<string>();
		const controller = new AbortController();
		controller.abort();
		let sent_after_close = false;

		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response<string>(c, log);
			const unsubscribe = registry.subscribe(stream);
			stream.on_close(unsubscribe);
			stream.send('dropped');
			sent_after_close = true;
			return response;
		});

		const response = await app.request(
			new Request('http://localhost/sse', { signal: controller.signal })
		);
		assert.ok(sent_after_close);
		assert.strictEqual(registry.count, 0);
		assert.strictEqual(await response.text(), C, 'nothing follows the connect comment');
	});

	test('on_close unsubscribes from SseRegistry on close', async () => {
		const app = new Hono();
		const registry = new SseRegistry<string>();

		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response<string>(c, log);
			const unsubscribe = registry.subscribe(stream, { channels: ['ch'] });
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
			const { response, stream } = create_sse_response(c, log);
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
			const { response, stream } = create_sse_response(c, log);
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
		const registry = new SseRegistry<string>();

		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response<string>(c, log);
			const unsubscribe = registry.subscribe(stream, { channels: ['ch'] });
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

describe('create_sse_response outbound budget', () => {
	test('the budget is 1 MiB', () => {
		assert.strictEqual(SSE_OUTBOUND_QUEUE_BYTES, 1024 * 1024);
	});

	test('a burst within the budget is delivered whole', async () => {
		const app = new Hono();
		// ten frames a little under a tenth of the budget each, overhead included
		const payload = 'x'.repeat(100_000);
		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response<string>(c, log);
			for (let i = 0; i < 10; i++) stream.send(payload);
			stream.close();
			return response;
		});
		const response = await app.request('/sse');
		assert.strictEqual(await response.text(), C + frame_of(payload).repeat(10));
	});

	test('a frame past the budget ends the stream with no final frame', async () => {
		const app = new Hono();
		const { warn_log, warns } = create_warn_log();
		const payload = 'x'.repeat(100_000);
		const tag = (i: number): string => String(i).padStart(2, '0');
		let closed = 0;
		let stream_ref!: SseStream<string>;
		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response<string>(c, warn_log, {
				account_id: 'acc_1'
			});
			stream_ref = stream;
			stream.on_close(() => closed++);
			// nothing reads the body while these are sent: the unread frames pass
			// the budget before the last ones
			for (let i = 0; i < 12; i++) stream.send(`${tag(i)}:${payload}`);
			stream.send('after the overflow');
			return response;
		});
		const response = await app.request('/sse');
		assert.strictEqual(closed, 1, 'the stream ended on the frame that did not fit');

		// one warning, naming the account and what was unread
		assert.strictEqual(warns.length, 1);
		assert.strictEqual(warns[0]![0], 'sse: outbound queue overflow, ending the stream');
		const detail = warns[0]![1] as {
			account_id: unknown;
			queued_bytes: number;
			queued_frames: number;
			frame_bytes: number;
		};
		assert.strictEqual(detail.account_id, 'acc_1');
		// unread: the connect comment and every data frame before the one that
		// did not fit — charged their bytes as written plus the per-frame overhead
		const frame_bytes = frame_of(`${tag(0)}:${payload}`).length;
		const admitted = detail.queued_frames - 1;
		assert.strictEqual(detail.queued_bytes, C.length + admitted * frame_bytes);
		assert.strictEqual(detail.frame_bytes, frame_bytes);
		const charged = detail.queued_bytes + detail.queued_frames * OUTBOUND_FRAME_OVERHEAD_BYTES;
		assert.ok(charged <= SSE_OUTBOUND_QUEUE_BYTES, 'what was unread fit the budget');
		assert.ok(
			charged + frame_bytes + OUTBOUND_FRAME_OVERHEAD_BYTES > SSE_OUTBOUND_QUEUE_BYTES,
			'and the next frame did not'
		);

		// the body ends on its own — no final frame, nothing after the overflow
		const text = await response.text();
		assert.ok(!text.includes('after the overflow'));
		assert.ok(!text.includes(`"${tag(admitted)}:`), 'the frame that did not fit is not delivered');
		// whatever arrived is a prefix of the stream, cut at a frame boundary
		let full = C;
		for (let i = 0; i < admitted; i++) full += frame_of(`${tag(i)}:${payload}`);
		assert.ok(full.startsWith(text));
		assert.ok(text === '' || text.endsWith('\n\n'));
		// what was unread is dropped, not flushed behind the overflow
		assert.ok(text.length < full.length);

		// an ended stream takes nothing more and warns no more
		stream_ref.send('later');
		assert.strictEqual(warns.length, 1);
	});

	test('a frame is charged its UTF-8 length, exact at the boundary', async () => {
		// 'é' is one UTF-16 code unit and two UTF-8 bytes, and JSON leaves it as is
		// unread behind the connect comment, the largest frame the budget holds
		const room = SSE_OUTBOUND_QUEUE_BYTES - C.length - 2 * OUTBOUND_FRAME_OVERHEAD_BYTES;
		// an ASCII character where the room left by two-byte characters is odd
		const pad = 'a'.repeat((room - frame_of('').length) % 2);
		const payload_of = (chars: number): string => pad + 'é'.repeat(chars);
		const frame_bytes_of = (chars: number): number => frame_of(payload_of(chars)).length + chars;
		const fits = (room - frame_bytes_of(0)) / 2;
		assert.strictEqual(frame_bytes_of(fits), room, 'the frame fills the budget to the byte');

		const run = async (
			chars: number
		): Promise<{ closed: number; warns: Array<Array<unknown>> }> => {
			const app = new Hono();
			const { warn_log, warns } = create_warn_log();
			let closed = 0;
			let stream_ref!: SseStream<string>;
			app.get('/sse', (c) => {
				const { response, stream } = create_sse_response<string>(c, warn_log);
				stream_ref = stream;
				stream.on_close(() => closed++);
				// nothing has read the connect comment yet
				stream.send(payload_of(chars));
				return response;
			});
			const response = await app.request('/sse');
			const result = { closed, warns };
			stream_ref.close();
			await response.body?.cancel();
			return result;
		};

		const at_the_budget = await run(fits);
		assert.strictEqual(at_the_budget.closed, 0);
		assert.deepStrictEqual(at_the_budget.warns, []);

		// one more character is two more bytes: counted in UTF-16 it would fit
		// with half the budget to spare
		const past_it = await run(fits + 1);
		assert.strictEqual(past_it.closed, 1);
		assert.strictEqual(past_it.warns.length, 1);
		assert.deepStrictEqual(past_it.warns[0]![1], {
			account_id: null,
			queued_bytes: C.length,
			queued_frames: 1,
			frame_bytes: room + 2
		});
	});

	test('a frame larger than the whole budget is delivered when nothing is unread', async () => {
		const app = new Hono();
		let stream_ref!: SseStream<string>;
		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response<string>(c, log);
			stream_ref = stream;
			return response;
		});
		const response = await app.request('/sse');
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		// the client takes the connect comment: nothing is unread
		assert.strictEqual(decoder.decode((await reader.read()).value), C);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const huge = 'x'.repeat(2 * SSE_OUTBOUND_QUEUE_BYTES);
		stream_ref.send(huge);
		let received = '';
		while (received.length < frame_of(huge).length) {
			const { value, done } = await reader.read();
			assert.strictEqual(done, false, 'the stream stays open');
			received += decoder.decode(value, { stream: true });
		}
		assert.strictEqual(received, frame_of(huge));
		stream_ref.close();
	});

	test('a stream whose client is not reading ends while one beside it gets every frame', async () => {
		const app = new Hono();
		const registry = new SseRegistry<string>();
		const closed: Array<string> = [];
		app.get('/sse/:name', (c) => {
			const name = c.req.param('name');
			const { response, stream } = create_sse_response<string>(c, log);
			const unsubscribe = registry.subscribe(stream, { channels: ['ch'] });
			stream.on_close(unsubscribe);
			stream.on_close(() => closed.push(name));
			return response;
		});
		const healthy = await app.request('/sse/healthy');
		// never read
		const stalled = await app.request('/sse/stalled');
		assert.strictEqual(registry.count, 2);

		const reader = healthy.body!.getReader();
		const decoder = new TextDecoder();
		let received = '';
		const read_until = async (length: number): Promise<void> => {
			while (received.length < length) {
				const { value, done } = await reader.read();
				assert.strictEqual(done, false, 'the healthy stream stays open');
				received += decoder.decode(value, { stream: true });
			}
		};

		const payload = 'x'.repeat(100_000);
		let expected = C;
		for (let i = 0; i < 30; i++) {
			const data = `${i}:${payload}`;
			// the producer never throws and never waits on the stalled stream
			registry.broadcast('ch', data);
			expected += frame_of(data);
			// the healthy client keeps reading between broadcasts
			await read_until(expected.length);
		}
		assert.strictEqual(received, expected);

		// the stalled stream ended on its budget and left the registry; the
		// healthy one is still subscribed
		assert.deepStrictEqual(closed, ['stalled']);
		assert.strictEqual(registry.count, 1);
		const stalled_text = await stalled.text();
		assert.ok(stalled_text.length < expected.length);
		assert.ok(!stalled_text.includes('"29:'));
		await reader.cancel();
	});
});

describe('create_validated_broadcaster', () => {
	const test_specs: Array<EventSpec> = [
		{
			method: 'run_created',
			params: z.strictObject({ run_id: z.string(), status: z.string() }),
			description: 'A run was created',
			channel: 'runs'
		},
		{
			method: 'run_updated',
			params: z.strictObject({ run_id: z.string(), status: z.string() }),
			description: 'A run was updated'
		}
	];

	test('passes valid data through to broadcaster', () => {
		const calls: Array<{ channel: string; data: SseNotification }> = [];
		const inner = {
			broadcast: (channel: string, data: SseNotification) => calls.push({ channel, data })
		};
		const validated = create_validated_broadcaster(inner, test_specs, log);

		validated.broadcast('runs', {
			method: 'run_created',
			params: { run_id: '1', status: 'running' }
		});
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0]!.channel, 'runs');
		assert.strictEqual(calls[0]!.data.method, 'run_created');
	});

	test('warns on unknown method', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const inner = { broadcast: vi.fn() };
		const warn_log = new Logger('test', { level: 'warn' });
		const validated = create_validated_broadcaster(inner, test_specs, warn_log);

		validated.broadcast('runs', { method: 'unknown_method', params: {} });
		assert.strictEqual(warn.mock.calls.length, 1);
		assert.include(String(warn.mock.calls[0]![1]), 'unknown_method');
		// still broadcasts
		assert.strictEqual(inner.broadcast.mock.calls.length, 1);
		warn.mockRestore();
	});

	test('warns on invalid params', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const inner = { broadcast: vi.fn() };
		const warn_log = new Logger('test', { level: 'warn' });
		const validated = create_validated_broadcaster(inner, test_specs, warn_log);

		validated.broadcast('runs', { method: 'run_created', params: { bad: true } });
		assert.strictEqual(warn.mock.calls.length, 1);
		assert.include(String(warn.mock.calls[0]![1]), 'run_created');
		// still broadcasts even on validation failure
		assert.strictEqual(inner.broadcast.mock.calls.length, 1);
		warn.mockRestore();
	});

	test('always broadcasts even on validation failure', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const calls: Array<SseNotification> = [];
		const inner = { broadcast: (_ch: string, data: SseNotification) => calls.push(data) };
		const validated = create_validated_broadcaster(inner, test_specs, log);

		validated.broadcast('runs', { method: 'unknown', params: {} });
		assert.strictEqual(calls.length, 1);
		warn.mockRestore();
	});

	test('empty event_specs list still works', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const inner = { broadcast: vi.fn() };
		const warn_log = new Logger('test', { level: 'warn' });
		const validated = create_validated_broadcaster(inner, [], warn_log);

		validated.broadcast('ch', { method: 'anything', params: {} });
		// warns because no specs match
		assert.strictEqual(warn.mock.calls.length, 1);
		assert.strictEqual(inner.broadcast.mock.calls.length, 1);
		warn.mockRestore();
	});

	test('broadcasts through SseRegistry to subscribed streams', () => {
		const registry = new SseRegistry<SseNotification>();
		const validated = create_validated_broadcaster(registry, test_specs, log);

		// subscribe two mock streams to different channels
		const runs_received: Array<SseNotification> = [];
		const all_received: Array<SseNotification> = [];
		const make_stream = (bucket: Array<SseNotification>): SseStream<SseNotification> => ({
			send: (data) => bucket.push(data),
			close: () => {},
			on_close: () => {}
		});
		const unsub_runs = registry.subscribe(make_stream(runs_received), { channels: ['runs'] });
		registry.subscribe(make_stream(all_received)); // no filter = all channels

		// broadcast to 'runs' channel through validated broadcaster
		const notification: SseNotification = {
			method: 'run_created',
			params: { run_id: '1', status: 'running' }
		};
		validated.broadcast('runs', notification);

		assert.strictEqual(runs_received.length, 1);
		assert.deepStrictEqual(runs_received[0], notification);
		assert.strictEqual(all_received.length, 1);
		assert.deepStrictEqual(all_received[0], notification);

		// after unsubscribe, stream no longer receives
		unsub_runs();
		validated.broadcast('runs', { method: 'run_updated', params: { run_id: '1', status: 'done' } });
		assert.strictEqual(runs_received.length, 1);
		assert.strictEqual(all_received.length, 2);
	});
});

describe('create_sse_response keep-alive', () => {
	/**
	 * Open a stream under fake timers and read its body as it arrives. Nothing
	 * is sent but what the stream writes on its own.
	 */
	const open = async (
		options?: Parameters<typeof create_sse_response>[2],
		target_log: Logger = log
	): Promise<{
		stream: SseStream<string>;
		read: () => Promise<string>;
		closed: () => number;
		cancel: () => Promise<void>;
	}> => {
		const app = new Hono();
		let stream_ref!: SseStream<string>;
		let closed = 0;
		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response<string>(c, target_log, options);
			stream_ref = stream;
			stream.on_close(() => closed++);
			return response;
		});
		const response = await app.request('/sse');
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		return {
			stream: stream_ref,
			read: async () => decoder.decode((await reader.read()).value),
			closed: () => closed,
			cancel: async () => {
				await reader.cancel();
			}
		};
	};

	test('an idle stream writes the keep-alive comment every interval', async () => {
		vi.useFakeTimers();
		try {
			const { stream, read, cancel } = await open();
			assert.strictEqual(await read(), C);
			await vi.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS - 1);
			stream.send('marker');
			// nothing but the data frame before the interval elapses
			assert.strictEqual(await read(), 'data: "marker"\n\n');
			await vi.advanceTimersByTimeAsync(1);
			assert.strictEqual(await read(), SSE_KEEP_ALIVE_COMMENT);
			await vi.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS);
			assert.strictEqual(await read(), SSE_KEEP_ALIVE_COMMENT);
			stream.close();
			await cancel();
		} finally {
			vi.useRealTimers();
		}
	});

	test('the comment is a blank-line-terminated SSE comment', () => {
		assert.strictEqual(SSE_KEEP_ALIVE_COMMENT, ': keepalive\n\n');
		assert.strictEqual(SSE_KEEP_ALIVE_INTERVAL_MS, 15_000);
	});

	test('keep_alive_ms sets the interval and null turns it off', async () => {
		vi.useFakeTimers();
		try {
			const custom = await open({ keep_alive_ms: 1_000 });
			assert.strictEqual(await custom.read(), C);
			await vi.advanceTimersByTimeAsync(1_000);
			assert.strictEqual(await custom.read(), SSE_KEEP_ALIVE_COMMENT);
			custom.stream.close();
			await custom.cancel();

			const timers_before = vi.getTimerCount();
			const off = await open({ keep_alive_ms: null });
			assert.strictEqual(vi.getTimerCount(), timers_before, 'no keep-alive timer is set');
			assert.strictEqual(await off.read(), C);
			await vi.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS * 4);
			off.stream.send('marker');
			assert.strictEqual(await off.read(), 'data: "marker"\n\n', 'no keep-alive came first');
			off.stream.close();
			await off.cancel();
		} finally {
			vi.useRealTimers();
		}
	});

	test('a keep_alive_ms a timer cannot honor throws', async () => {
		for (const keep_alive_ms of [
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			SSE_KEEP_ALIVE_INTERVAL_MS_MAX + 1
		]) {
			assert.throws(() => validate_sse_keep_alive_ms(keep_alive_ms), /keep_alive_ms/);
			const app = new Hono();
			let thrown: unknown = null;
			app.get('/sse', (c) => {
				try {
					return create_sse_response(c, log, { keep_alive_ms }).response;
				} catch (error) {
					thrown = error;
					return c.text('refused', 500);
				}
			});
			await app.request('/sse');
			assert.instanceOf(thrown, Error, String(keep_alive_ms));
		}
		for (const keep_alive_ms of [undefined, null, 0.5, 15_000, SSE_KEEP_ALIVE_INTERVAL_MS_MAX]) {
			validate_sse_keep_alive_ms(keep_alive_ms);
		}
	});

	test('the timer stops when the stream closes', async () => {
		vi.useFakeTimers();
		try {
			const timers_before = vi.getTimerCount();
			const { stream, read, cancel } = await open();
			assert.strictEqual(vi.getTimerCount(), timers_before + 1);
			assert.strictEqual(await read(), C);
			stream.close();
			assert.strictEqual(vi.getTimerCount(), timers_before, 'the keep-alive timer is cleared');
			await cancel();
		} finally {
			vi.useRealTimers();
		}
	});

	test('a keep-alive is held to the outbound budget like a data frame', async () => {
		vi.useFakeTimers();
		try {
			const { warn_log, warns } = create_warn_log();
			const keep_alive_charge = SSE_KEEP_ALIVE_COMMENT.length + OUTBOUND_FRAME_OVERHEAD_BYTES;
			// the room behind the unread connect comment, less the filler's overhead
			const room = SSE_OUTBOUND_QUEUE_BYTES - C.length - 2 * OUTBOUND_FRAME_OVERHEAD_BYTES;
			const run = async (spare: number): Promise<number> => {
				const app = new Hono();
				let closed = 0;
				app.get('/sse', (c) => {
					const { response, stream } = create_sse_response<string>(c, warn_log);
					stream.on_close(() => closed++);
					// one synchronous run, so nothing the client could have read is
					// released: fill the budget to `spare` bytes short of one more
					// keep-alive, then let its interval elapse
					stream.send('f'.repeat(room - frame_of('').length - keep_alive_charge + spare));
					vi.advanceTimersByTime(SSE_KEEP_ALIVE_INTERVAL_MS);
					return response;
				});
				const response = await app.request('/sse');
				const closed_before_cancel = closed;
				await response.body?.cancel();
				return closed_before_cancel;
			};
			assert.strictEqual(await run(0), 0, 'a keep-alive that fits is written');
			assert.deepStrictEqual(warns, []);
			assert.strictEqual(await run(1), 1, 'a keep-alive that does not fit ends the stream');
			assert.strictEqual(warns.length, 1);
			assert.strictEqual(warns[0]![0], 'sse: outbound queue overflow, ending the stream');
		} finally {
			vi.useRealTimers();
		}
	});
});
