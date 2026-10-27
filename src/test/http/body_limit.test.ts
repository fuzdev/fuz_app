/**
 * Tests for `http/body_limit.ts` — the request body size cap and its refusal
 * of a `Content-Length` it cannot read, over a bare Hono app.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Hono } from 'hono';

import { create_body_limit_middleware } from '#lib/http/body_limit.ts';
import { ERROR_INVALID_CONTENT_LENGTH, ERROR_PAYLOAD_TOO_LARGE } from '#lib/http/error_schemas.ts';

const MAX_SIZE = 100;

interface TestApp {
	app: Hono;
	/** How many requests reached the handler. */
	handled: () => number;
}

/** A bare app whose only route echoes the length of the body it read. */
const create_test_app = (): TestApp => {
	let handled = 0;
	const app = new Hono();
	app.use(create_body_limit_middleware(MAX_SIZE));
	app.all('/echo', async (c) => {
		handled++;
		return c.json({ length: (await c.req.text()).length });
	});
	return { app, handled: () => handled };
};

/** A request body with no `Content-Length`, delivered in the given chunk sizes. */
const create_body_stream = (...chunk_sizes: Array<number>): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			for (const size of chunk_sizes) {
				controller.enqueue(new TextEncoder().encode('x'.repeat(size)));
			}
			controller.close();
		}
	});

const post = (
	app: Hono,
	headers: Record<string, string>,
	body: string | ReadableStream<Uint8Array>
): Response | Promise<Response> =>
	app.request('/echo', {
		method: 'POST',
		headers,
		body,
		// a stream body needs `duplex`
		...(typeof body === 'string' ? {} : { duplex: 'half' })
	});

/**
 * A `Request` that records whether anything read its `body` — the getter
 * alone counts, since reading it is what makes a runtime take the body off
 * the socket.
 */
const create_body_spy_request = (
	init: RequestInit
): { request: Request; body_read: () => boolean } => {
	let body_read = false;
	class BodySpyRequest extends Request {
		override get body(): Request['body'] {
			body_read = true;
			return super.body;
		}
	}
	return {
		request: new BodySpyRequest('http://localhost/echo', init),
		body_read: () => body_read
	};
};

describe('create_body_limit_middleware', () => {
	describe('max_size', () => {
		for (const max_size of [NaN, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			test(`${max_size} throws rather than building an uncapped middleware`, () => {
				assert.throws(
					() => create_body_limit_middleware(max_size),
					/max_size must be a safe integer/
				);
			});
		}

		test('0 refuses any body', async () => {
			const app = new Hono();
			app.use(create_body_limit_middleware(0));
			app.post('/echo', (c) => c.json({ ok: true }));
			const res = await post(app, { 'content-type': 'text/plain' }, 'x');
			assert.strictEqual(res.status, 413);
		});
	});

	describe('Content-Length', () => {
		test('a body exactly at the cap passes', async () => {
			const { app } = create_test_app();
			const res = await post(app, { 'content-length': String(MAX_SIZE) }, 'x'.repeat(MAX_SIZE));
			assert.strictEqual(res.status, 200);
			assert.deepEqual(await res.json(), { length: MAX_SIZE });
			assert.strictEqual(res.headers.get('connection'), null);
		});

		test('a body one byte over the cap is refused with 413 and Connection: close', async () => {
			const { app, handled } = create_test_app();
			const { request, body_read } = create_body_spy_request({
				method: 'POST',
				headers: { 'content-length': String(MAX_SIZE + 1) },
				body: 'x'.repeat(MAX_SIZE + 1)
			});
			const res = await app.request(request);
			assert.strictEqual(res.status, 413);
			assert.deepEqual(await res.json(), { error: ERROR_PAYLOAD_TOO_LARGE });
			assert.strictEqual(res.headers.get('connection'), 'close');
			assert.strictEqual(handled(), 0);
			assert.strictEqual(body_read(), false, 'the 413 must not read the request body');
		});

		test('leading zeros do not change the value', async () => {
			const { app } = create_test_app();
			const at_cap = await post(app, { 'content-length': `000${MAX_SIZE}` }, 'x'.repeat(MAX_SIZE));
			assert.strictEqual(at_cap.status, 200);
			const over = await post(
				app,
				{ 'content-length': `000${MAX_SIZE + 1}` },
				'x'.repeat(MAX_SIZE + 1)
			);
			assert.strictEqual(over.status, 413);
		});

		test('a digit run too long to represent exactly is over the cap', async () => {
			const { app, handled } = create_test_app();
			for (const digits of ['9'.repeat(30), '1' + '0'.repeat(400)]) {
				const res = await post(app, { 'content-length': digits }, 'x');
				assert.strictEqual(res.status, 413, digits);
				assert.strictEqual(res.headers.get('connection'), 'close', digits);
			}
			assert.strictEqual(handled(), 0);
		});
	});

	describe('malformed Content-Length', () => {
		const malformed: Array<[label: string, value: string]> = [
			['non-numeric', 'abc'],
			['negative', '-1'],
			['signed', '+5'],
			['exponent', '1e9'],
			['hex', '0x1F4'],
			['trailing junk', '5abc'],
			['decimal', '5.0'],
			['inner space', '5 0'],
			['empty', ''],
			['combined differing values', '5, 500'],
			['combined equal values', '5, 5'],
			['non-ASCII byte', '5\xb2']
		];

		for (const [label, value] of malformed) {
			test(`${label} is refused with 400 before the handler or the body`, async () => {
				const { app, handled } = create_test_app();
				const { request, body_read } = create_body_spy_request({
					method: 'POST',
					headers: { 'content-length': value },
					body: 'x'.repeat(MAX_SIZE * 5)
				});
				assert.strictEqual(request.headers.get('content-length'), value);
				const res = await app.request(request);
				assert.strictEqual(res.status, 400);
				assert.deepEqual(await res.json(), { error: ERROR_INVALID_CONTENT_LENGTH });
				assert.strictEqual(res.headers.get('connection'), 'close');
				assert.strictEqual(handled(), 0);
				assert.strictEqual(body_read(), false, 'the 400 must not read the request body');
			});
		}

		test('two differing Content-Length headers are refused as their combined value', async () => {
			const { app, handled } = create_test_app();
			const headers = new Headers();
			headers.append('content-length', '5');
			headers.append('content-length', '500');
			const res = await app.request('/echo', { method: 'POST', headers, body: 'x'.repeat(500) });
			assert.strictEqual(res.status, 400);
			assert.deepEqual(await res.json(), { error: ERROR_INVALID_CONTENT_LENGTH });
			assert.strictEqual(handled(), 0);
		});

		test('is refused beside Transfer-Encoding too', async () => {
			const { app, handled } = create_test_app();
			const res = await post(
				app,
				{ 'content-length': 'abc', 'transfer-encoding': 'chunked' },
				create_body_stream(10)
			);
			assert.strictEqual(res.status, 400);
			assert.deepEqual(await res.json(), { error: ERROR_INVALID_CONTENT_LENGTH });
			assert.strictEqual(handled(), 0);
		});
	});

	describe('streamed body (no Content-Length)', () => {
		test('a body exactly at the cap passes', async () => {
			const { app } = create_test_app();
			const res = await post(app, {}, create_body_stream(MAX_SIZE));
			assert.strictEqual(res.status, 200);
			assert.deepEqual(await res.json(), { length: MAX_SIZE });
		});

		test('a body one byte over the cap is refused with 413', async () => {
			const { app, handled } = create_test_app();
			const res = await post(app, {}, create_body_stream(MAX_SIZE, 1));
			assert.strictEqual(res.status, 413);
			assert.deepEqual(await res.json(), { error: ERROR_PAYLOAD_TOO_LARGE });
			// sent after the count passed the cap, so the body has been read;
			// only the header refusals ask for the close
			assert.strictEqual(res.headers.get('connection'), null);
			assert.strictEqual(handled(), 0);
		});
	});

	describe('Transfer-Encoding beside Content-Length', () => {
		test('an oversized Content-Length with a small stream passes on the bytes that arrive', async () => {
			const { app } = create_test_app();
			const res = await post(
				app,
				{ 'content-length': String(MAX_SIZE * 5), 'transfer-encoding': 'chunked' },
				create_body_stream(10)
			);
			assert.strictEqual(res.status, 200);
			assert.deepEqual(await res.json(), { length: 10 });
		});

		test('a small Content-Length with an oversized stream is refused with 413', async () => {
			const { app, handled } = create_test_app();
			const res = await post(
				app,
				{ 'content-length': '2', 'transfer-encoding': 'chunked' },
				create_body_stream(MAX_SIZE, MAX_SIZE)
			);
			assert.strictEqual(res.status, 413);
			assert.deepEqual(await res.json(), { error: ERROR_PAYLOAD_TOO_LARGE });
			assert.strictEqual(handled(), 0);
		});
	});

	describe('GET', () => {
		test('with no body passes', async () => {
			const { app } = create_test_app();
			const res = await app.request('/echo');
			assert.strictEqual(res.status, 200);
			assert.deepEqual(await res.json(), { length: 0 });
		});

		test('declaring a Content-Length over the cap is refused with 413, body or not', async () => {
			const { app, handled } = create_test_app();
			const res = await app.request('/echo', {
				headers: { 'content-length': String(MAX_SIZE + 1) }
			});
			assert.strictEqual(res.status, 413);
			assert.deepEqual(await res.json(), { error: ERROR_PAYLOAD_TOO_LARGE });
			assert.strictEqual(res.headers.get('connection'), 'close');
			assert.strictEqual(handled(), 0);
		});

		test('with a malformed Content-Length is refused with 400', async () => {
			const { app, handled } = create_test_app();
			const res = await app.request('/echo', { headers: { 'content-length': 'abc' } });
			assert.strictEqual(res.status, 400);
			assert.strictEqual(handled(), 0);
		});
	});
});
