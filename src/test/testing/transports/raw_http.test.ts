import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { afterEach, assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	raw_http_count_responses,
	raw_http_exchange,
	raw_http_first_status,
	raw_http_parse_response,
	raw_http_send_head
} from '#lib/testing/transports/raw_http.ts';

const RESPONSE_413 =
	'HTTP/1.1 413 Payload Too Large\r\n' +
	'Content-Type: application/json\r\n' +
	'Content-Length: 29\r\n' +
	'\r\n' +
	'{"error":"payload_too_large"}';

describe('raw_http_parse_response', () => {
	test('parses a Content-Length response', () => {
		const response = raw_http_parse_response(RESPONSE_413);
		assert.ok(response);
		assert.strictEqual(response.status, 413);
		assert.strictEqual(response.headers['content-type'], 'application/json');
		assert.strictEqual(response.body, '{"error":"payload_too_large"}');
	});

	test('stops the body at Content-Length, leaving a pipelined response behind', () => {
		const response = raw_http_parse_response(RESPONSE_413 + RESPONSE_413);
		assert.strictEqual(response?.body, '{"error":"payload_too_large"}');
	});

	test('answers null until the head is whole', () => {
		assert.strictEqual(raw_http_parse_response(''), null);
		assert.strictEqual(raw_http_parse_response('HTTP/1.1 413 Payload Too Large\r\nContent-'), null);
	});

	test('answers null until the declared body has arrived', () => {
		assert.strictEqual(raw_http_parse_response(RESPONSE_413.slice(0, -1)), null);
	});

	test('answers null for bytes that are not a response', () => {
		assert.strictEqual(raw_http_parse_response('GET / HTTP/1.1\r\nHost: a\r\n\r\n'), null);
	});

	test('decodes a chunked body once its terminating chunk has arrived', () => {
		const head = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n';
		const chunks = '5\r\nhello\r\n6;ext=1\r\n world\r\n';
		assert.strictEqual(raw_http_parse_response(head + chunks), null);
		assert.strictEqual(raw_http_parse_response(head + chunks + '0\r\n'), null);
		assert.strictEqual(raw_http_parse_response(head + chunks + '0\r\n\r\n')?.body, 'hello world');
	});

	test('takes what followed the head as the body when nothing frames it', () => {
		const response = raw_http_parse_response('HTTP/1.0 200 OK\r\nX-A: 1\r\n\r\npartial');
		assert.ok(response);
		assert.strictEqual(response.status, 200);
		assert.strictEqual(response.body, 'partial');
	});
});

describe('raw_http_count_responses / raw_http_first_status', () => {
	test('counts a response concatenated straight after a body', () => {
		assert.strictEqual(raw_http_count_responses(''), 0);
		assert.strictEqual(raw_http_count_responses(RESPONSE_413), 1);
		assert.strictEqual(raw_http_count_responses(RESPONSE_413 + 'HTTP/1.0 200 OK\r\n\r\n'), 2);
	});

	test('reads the first status, or null when there is none', () => {
		assert.strictEqual(raw_http_first_status(''), null);
		assert.strictEqual(raw_http_first_status(RESPONSE_413 + 'HTTP/1.1 200 OK\r\n\r\n'), 413);
	});
});

describe('raw_http_exchange', () => {
	let server: Server | undefined;
	const sockets: Array<Socket> = [];

	/** Listen on a free loopback port with `on_data` handling each socket's first bytes. */
	const listen = (on_data: (socket: Socket, data: string) => void): Promise<string> =>
		new Promise((resolve) => {
			server = createServer((socket) => {
				sockets.push(socket);
				socket.setEncoding('latin1');
				socket.on('error', () => {});
				socket.once('data', (data: string) => on_data(socket, data));
			});
			server.listen(0, '127.0.0.1', () => {
				resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
			});
		});

	afterEach(async () => {
		for (const socket of sockets.splice(0)) socket.destroy();
		await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
		server = undefined;
	});

	test('sends the bytes as given and reads until the server closes', async () => {
		let seen = '';
		const base_url = await listen((socket, data) => {
			seen = data;
			socket.end(RESPONSE_413);
		});
		const request = 'POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\n';
		const exchange = await raw_http_exchange(base_url, request, { read_timeout_ms: 2000 });
		assert.strictEqual(seen, request);
		assert.strictEqual(exchange.received, RESPONSE_413);
		assert.strictEqual(exchange.closed_by_server, true);
	});

	test("until 'response' stops at a whole response on a connection the server keeps", async () => {
		const base_url = await listen((socket) => socket.write(RESPONSE_413));
		const started = Date.now();
		const exchange = await raw_http_exchange(base_url, 'GET / HTTP/1.1\r\n\r\n', {
			read_timeout_ms: 5000,
			until: 'response'
		});
		assert.strictEqual(exchange.received, RESPONSE_413);
		assert.strictEqual(exchange.closed_by_server, false);
		assert.ok(Date.now() - started < 4000, 'must not have waited out the read timeout');
	});

	test("until 'response' keeps reading a response that arrives in pieces", async () => {
		const base_url = await listen((socket) => {
			socket.write(RESPONSE_413.slice(0, 40));
			setTimeout(() => socket.write(RESPONSE_413.slice(40)), 30);
		});
		const exchange = await raw_http_exchange(base_url, 'GET / HTTP/1.1\r\n\r\n', {
			read_timeout_ms: 5000,
			until: 'response'
		});
		assert.strictEqual(exchange.received, RESPONSE_413);
	});

	test('gives up at the read timeout when the server neither answers nor closes', async () => {
		const base_url = await listen(() => {});
		const exchange = await raw_http_exchange(base_url, 'GET / HTTP/1.1\r\n\r\n', {
			read_timeout_ms: 50,
			until: 'response'
		});
		assert.deepEqual(exchange, { received: '', closed_by_server: false });
	});
});

describe('raw_http_send_head', () => {
	let server: Server | undefined;
	const sockets: Array<Socket> = [];

	/** Listen on a free loopback port, handing each socket's first bytes to `on_data`. */
	const listen = (on_data: (socket: Socket, data: string) => void): Promise<string> =>
		new Promise((resolve) => {
			server = createServer((socket) => {
				sockets.push(socket);
				socket.setEncoding('latin1');
				socket.on('error', () => {});
				socket.once('data', (data: string) => on_data(socket, data));
			});
			server.listen(0, '127.0.0.1', () => {
				resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
			});
		});

	afterEach(async () => {
		for (const socket of sockets.splice(0)) socket.destroy();
		await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
		server = undefined;
	});

	test('sends the head alone and reads the response on a connection the server keeps', async () => {
		let seen = '';
		const base_url = await listen((socket, data) => {
			seen = data;
			socket.write(RESPONSE_413);
		});
		const response = await raw_http_send_head(base_url, {
			method: 'PATCH',
			path: '/x',
			headers: { origin: 'http://a' },
			content_length: 9
		});
		assert.strictEqual(
			seen,
			`PATCH /x HTTP/1.1\r\nHost: ${new URL(base_url).host}\r\norigin: http://a\r\n` +
				'Content-Length: 9\r\n\r\n'
		);
		assert.strictEqual(response.status, 413);
		assert.strictEqual(response.body, '{"error":"payload_too_large"}');
	});

	test('defaults to POST', async () => {
		let seen = '';
		const base_url = await listen((socket, data) => {
			seen = data;
			socket.write(RESPONSE_413);
		});
		await raw_http_send_head(base_url, { path: '/x', headers: {}, content_length: 1 });
		assert.ok(seen.startsWith('POST /x HTTP/1.1\r\n'), seen);
	});

	test('throws when no whole response arrives in time', async () => {
		const base_url = await listen(() => {});
		await assert_rejects(
			() =>
				raw_http_send_head(base_url, {
					path: '/x',
					headers: {},
					content_length: 1,
					read_timeout_ms: 50
				}),
			/none arrived within 50ms/
		);
	});

	test('throws when the server closes without answering', async () => {
		const base_url = await listen((socket) => socket.end());
		await assert_rejects(
			() => raw_http_send_head(base_url, { path: '/x', headers: {}, content_length: 1 }),
			/connection refused or closed before any response/
		);
	});

	test('throws a refused-or-closed error when nothing is listening', async () => {
		await assert_rejects(
			() =>
				raw_http_send_head('http://127.0.0.1:1', { path: '/x', headers: {}, content_length: 1 }),
			/connection refused or closed before any response/
		);
	});

	test('refuses a Host or Content-Length in headers, in any casing', async () => {
		for (const name of ['Host', 'host', 'CONTENT-LENGTH', 'content-length']) {
			await assert_rejects(
				() =>
					raw_http_send_head('http://127.0.0.1:1', {
						path: '/x',
						headers: { [name]: '1' },
						content_length: 1
					}),
				new RegExp(`drop '${name}'`)
			);
		}
	});
});
