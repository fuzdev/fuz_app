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
import { SSE_CONNECTED_COMMENT, SSE_OUTBOUND_QUEUE_BYTES } from '#lib/realtime/sse_constants.ts';
import { SubscriberRegistry } from '#lib/realtime/subscriber_registry.ts';
import { OUTBOUND_FRAME_OVERHEAD_BYTES } from '#lib/realtime/outbound_budget.ts';

const log = new Logger('test', { level: 'off' });

/** Helper — expected prefix for all SSE responses. */
const C = SSE_CONNECTED_COMMENT;

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

	test('stream.comment sends SSE comment format', async () => {
		const app = new Hono();

		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response(c, log);
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

	test('stream.comment is a no-op after close', async () => {
		const app = new Hono();

		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response(c, log);
			stream.comment('before');
			stream.close();
			stream.comment('after'); // should be ignored
			return response;
		});

		const response = await app.request('/sse');
		const text = await response.text();
		assert.strictEqual(text, `${C}: before\n`);
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
		const registry = new SubscriberRegistry<unknown>();
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
		const registry = new SubscriberRegistry<string>();
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

	test('on_close unsubscribes from SubscriberRegistry on close', async () => {
		const app = new Hono();
		const registry = new SubscriberRegistry<string>();

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
		const registry = new SubscriberRegistry<string>();

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
		stream_ref.comment('later');
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

	test('a comment is held to the budget like a data frame', async () => {
		const app = new Hono();
		const { warn_log, warns } = create_warn_log();
		const text = 'k'.repeat(100_000);
		// `: ` before it and a newline after
		const comment_bytes = text.length + 3;
		let closed = 0;
		let written = 0;
		let closed_after = -1;
		app.get('/sse', (c) => {
			const { response, stream } = create_sse_response(c, warn_log);
			stream.on_close(() => {
				closed++;
				closed_after = written;
			});
			// nothing reads the body while these are written
			for (let i = 0; i < 12; i++) {
				stream.comment(text);
				written++;
			}
			return response;
		});
		const response = await app.request('/sse');
		assert.strictEqual(closed, 1, 'the stream ended on the comment that did not fit');
		// the comments before it filled the budget: the connect comment and each
		// one charged its bytes plus the per-frame overhead
		const charge = comment_bytes + OUTBOUND_FRAME_OVERHEAD_BYTES;
		const held = Math.floor(
			(SSE_OUTBOUND_QUEUE_BYTES - C.length - OUTBOUND_FRAME_OVERHEAD_BYTES) / charge
		);
		assert.strictEqual(closed_after, held);
		assert.strictEqual(warns.length, 1);
		assert.strictEqual(warns[0]![0], 'sse: outbound queue overflow, ending the stream');
		assert.deepStrictEqual(warns[0]![1], {
			account_id: null,
			queued_bytes: C.length + held * comment_bytes,
			queued_frames: held + 1,
			frame_bytes: comment_bytes
		});
		// the body ends without the comment that did not fit
		const body = await response.text();
		assert.ok(body.length < C.length + (held + 1) * comment_bytes);
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
		const registry = new SubscriberRegistry<string>();
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
