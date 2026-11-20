/**
 * A `HEAD` request, which Hono answers by running the `GET` route and dropping
 * its body unread: the spine answers a stream's status and headers alone and
 * releases the stream — a raw stream body cancelled, an SSE stream closed
 * with its close listeners run — while a `GET` of the same route gets the
 * stream. A file stream's cancel closes its file handle, which is what
 * releases a disk fact's file on a `HEAD`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, open, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { literal, loose_object } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { apply_route_specs, define_route } from '#lib/http/route_spec.ts';
import { route_ok, route_raw, route_sse } from '#lib/http/route_result.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import { create_sse_stream } from '#lib/realtime/sse.ts';

const shape = {
	method: 'GET',
	auth: { account: 'none', actor: 'none' },
	description: 'x',
	input: literal(null),
	output: loose_object({})
} as const;

/** What the routes saw, reset per test. */
const seen = { cancels: 0, sse_closes: 0, responses: [] as Array<Response> };

const BYTES = new TextEncoder().encode('stream body');

const app = new Hono();
// the response the route built, before Hono's `HEAD` wrapper drops its body
app.use('*', async (c, next) => {
	await next();
	seen.responses.push(c.res);
});
apply_route_specs(
	app,
	[
		define_route({
			...shape,
			path: '/stream',
			handler: () =>
				route_raw({
					status: 200,
					headers: {
						'Content-Type': 'application/octet-stream',
						'Content-Length': String(BYTES.length)
					},
					body: new ReadableStream<Uint8Array>({
						start: (controller) => {
							controller.enqueue(BYTES);
							controller.close();
						},
						cancel: () => {
							seen.cancels++;
						}
					})
				})
		}),
		define_route({
			...shape,
			path: '/sse',
			handler: (route) => {
				const stream = route.open_sse({ keep_alive_ms: null });
				stream.on_close(() => {
					seen.sse_closes++;
				});
				return route_sse(stream);
			}
		}),
		define_route({ ...shape, path: '/ok', handler: () => route_ok({ n: 1 }) })
	],
	fuz_auth_guard_resolver,
	new Logger('test', { level: 'off' }),
	create_stub_db(),
	{ open_sse: create_sse_stream }
);

const reset = (): void => {
	seen.cancels = 0;
	seen.sse_closes = 0;
	seen.responses.length = 0;
};

describe('HEAD on a route answering a stream', () => {
	test('a raw stream body is cancelled, and the head answered without it', async () => {
		reset();
		const res = await app.request('/stream', { method: 'HEAD' });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('content-length'), String(BYTES.length));
		assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream');
		assert.strictEqual(seen.cancels, 1);
		assert.strictEqual(seen.responses.length, 1);
		assert.isNull(seen.responses[0]!.body, 'the spine built the answer with no body');
	});

	test('a GET of the same route streams the body, cancelling nothing', async () => {
		reset();
		const res = await app.request('/stream');
		assert.strictEqual(await res.text(), 'stream body');
		assert.strictEqual(seen.cancels, 0);
	});

	test('an SSE stream is closed, its close listeners run, and the answer ends', async () => {
		reset();
		const res = await app.request('/sse', { method: 'HEAD' });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');
		// no keep-alive to hold a connection with no stream on it
		assert.isNull(res.headers.get('connection'));
		assert.strictEqual(seen.sse_closes, 1);
		assert.isNull(seen.responses[0]!.body);
		assert.strictEqual(await res.text(), '');
	});

	test('a GET of the SSE route keeps its stream open', async () => {
		reset();
		const res = await app.request('/sse');
		assert.strictEqual(res.headers.get('connection'), 'keep-alive');
		assert.strictEqual(seen.sse_closes, 0);
		await res.body!.cancel();
	});

	test('a text answer is built as for a GET, Hono dropping the body', async () => {
		reset();
		const res = await app.request('/ok', { method: 'HEAD' });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(await res.text(), '');
		assert.isNotNull(
			seen.responses[0]!.body,
			'the route built its body; an outer layer can read it'
		);
	});
});

/** This process's open descriptors on `path`, from `/proc/self/fd`; `null` off Linux. */
const count_open_fds = async (path: string): Promise<number | null> => {
	let fds: Array<string>;
	try {
		fds = await readdir('/proc/self/fd');
	} catch {
		return null;
	}
	const target = await realpath(path);
	let count = 0;
	for (const fd of fds) {
		try {
			if ((await readlink(join('/proc/self/fd', fd))) === target) count++;
		} catch {
			// closed while listing
		}
	}
	return count;
};

describe('a file stream as a raw body', () => {
	test('cancelling `Readable.toWeb(handle.createReadStream())` closes the file handle', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fuz_app_head_'));
		try {
			const path = join(dir, 'fact');
			// larger than one read, so the stream holds the handle until it is cancelled
			// (a stream read to its end closes the handle by itself)
			await writeFile(path, new Uint8Array(1 << 20));
			const before = await count_open_fds(path);
			const handle = await open(path, 'r');
			const stream = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
			const during = await count_open_fds(path);
			await stream.cancel();
			// the close is the handle's, a tick after the stream's destroy
			await new Promise((resolve) => setTimeout(resolve, 20));
			const after = await count_open_fds(path);
			if (before === null) return; // no `/proc` to count with
			assert.strictEqual(during, before + 1, 'the handle was open');
			assert.strictEqual(after, before, 'the cancel closed it');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
