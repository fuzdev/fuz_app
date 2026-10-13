import '../assert_dev_env.ts';

/**
 * Cross-backend request-smuggling probe for the body-size limit's connection
 * handling — the security sibling of `body_size.ts`.
 *
 * When the server caps the request body it answers `413` on the
 * `Content-Length` header. The strong (defense-in-depth) posture is to close
 * the connection *without reading the oversized body*: HTTP/1.1 forbids reusing
 * a keep-alive connection whose request body wasn't consumed, because unread
 * body bytes would be parsed as the start of the next request — a classic
 * request-smuggling vector. This suite probes the boundary by **pipelining**:
 * it opens a raw TCP socket and sends, in one write, an oversized `POST`
 * immediately followed by a second `GET`. Every backend must close after the
 * reject, so the pipelined GET goes unanswered and **at most one** response
 * comes back. `<= 1` rather than "exactly the 413" because the impls close
 * differently at the TCP level (a graceful close delivers the 413 first;
 * hyper's RST can drop the in-flight 413 before the client reads it), so
 * demanding a cleanly-read 413 would be flaky.
 *
 * - **Node** closes at once with the body unread — `create_app_server`'s body
 *   limit (`http/body_limit.ts`) refuses on the header and answers
 *   `Connection: close`, which is what makes `@hono/node-server` close.
 * - **Bun** closes at once too, honouring that header. Bun 1.4.3 is the tested
 *   floor: an older Bun kept the connection after the 413 and served the next
 *   request (correctly framed), which fails this suite.
 * - **Deno** closes once the whole declared body has arrived, which this
 *   probe's single write delivers; a client that withholds the body holds a
 *   Deno connection open, and no request behind the body is served either way.
 * - **hyper** (the Rust spine) closes at once.
 *
 * The oversized body is rejected *with* a 413 on every backend — pinned
 * reliably over `fetch` by `describe_body_size_cross_tests`; this test owns
 * only the connection-handling half. A **positive control** (two pipelined
 * requests → `>= 2` responses) proves a second response *would* be seen if a
 * trailing request were processed — without it `<= 1` would be vacuous on a
 * server that never reuses connections — and that the counter isn't
 * undercounting.
 *
 * **`Content-Length` beside `Transfer-Encoding`.** The second probe sends a
 * request carrying both headers — the shape a request-smuggling attack hands a
 * server and a proxy that disagree on which one frames the body — with a
 * `GET` pipelined behind it. What the backends share is the outcome, not the
 * status: the request is refused with `400` (the Node, Deno and Bun parsers)
 * or answered as its chunked body reads (hyper, which drops the
 * `Content-Length`), and either way the server **closes the connection** and
 * the pipelined request is **never served**. The status of the one response
 * is implementation-defined and not asserted.
 *
 * Raw-socket by necessity (the `FetchTransport` can't pipeline two requests on
 * one connection), so — unlike `body_size.ts` — this is **cross-process only**
 * (no in-process leg; there is no socket in-process — the in-process pin is
 * that the reject never reads the request body, in
 * `server/create_app_server.db.test.ts`).
 *
 * Cited property: `docs/security.md` §"Body Size Limiting" (connection handling
 * on oversized reject).
 *
 * @module
 */

import { connect } from 'node:net';

import { describe, test, assert } from 'vitest';

import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** Options for the smuggling probe — needs the raw URL, not a transport. */
export interface BodySizeSmugglingCrossTestOptions {
	/** Base URL the spawned backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** RPC endpoint path to target. Default `/api/rpc`. */
	readonly rpc_path?: string;
}

/** The shared 1 MiB cap (see `body_size.ts` for why it's a local constant). */
const BODY_LIMIT_DEFAULT_BYTES = 1024 * 1024;

/**
 * How long each raw exchange waits for the server to finish answering. An
 * exchange the backend does not end by closing runs the whole window.
 */
const RAW_READ_TIMEOUT_MS = 2000;

/** What a raw exchange read back, and how it ended. */
interface RawExchange {
	/** Every byte the server sent, `latin1`-decoded. */
	readonly received: string;
	/** `true` when the server ended the connection; `false` when the read window ran out first. */
	readonly closed_by_server: boolean;
}

/**
 * Open a raw TCP socket to `base_url`, write `request_bytes` once, and collect
 * everything the server sends back until it closes the connection or
 * `read_timeout_ms` elapses. Write errors are swallowed: the server closing
 * mid-upload (the correct response to an oversized body) surfaces as
 * `EPIPE`/`ECONNRESET` on our unfinished write, which is exactly the behavior
 * under test — what matters is what we *read back*.
 */
const exchange_raw = (
	base_url: string,
	request_bytes: string,
	read_timeout_ms: number
): Promise<RawExchange> =>
	new Promise((resolve) => {
		const url = new URL(base_url);
		const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
		const socket = connect({ host: url.hostname, port });
		let received = '';
		let settled = false;
		const finish = (closed_by_server: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve({ received, closed_by_server });
		};
		const timer = setTimeout(() => finish(false), read_timeout_ms);
		socket.setEncoding('latin1');
		socket.on('connect', () => socket.write(request_bytes));
		socket.on('data', (chunk: string) => {
			received += chunk;
		});
		socket.on('error', () => {}); // EPIPE/ECONNRESET on mid-write close is expected
		socket.on('close', () => finish(true));
	});

/** `exchange_raw`, for a caller that reads only the bytes. */
const send_raw = async (
	base_url: string,
	request_bytes: string,
	read_timeout_ms: number
): Promise<string> => (await exchange_raw(base_url, request_bytes, read_timeout_ms)).received;

/**
 * Count HTTP response status lines in a raw byte stream. Deliberately
 * **unanchored** (no `^`/`m`): a second pipelined response is concatenated
 * straight after the first response's body, which carries no trailing newline,
 * so a line-anchored match would miss it — and missing a smuggled second
 * response is a silent false negative. No response header or JSON error body
 * contains the literal `HTTP/1.x NNN`, so an unanchored match counts exactly
 * the status lines. The positive control below proves this counts 2 when the
 * server genuinely returns 2.
 */
const count_responses = (raw: string): number => (raw.match(/HTTP\/1\.[01] \d{3}/g) ?? []).length;

export const describe_body_size_smuggling_cross_tests = (
	options: BodySizeSmugglingCrossTestOptions
): void => {
	const { base_url } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const host = new URL(base_url).host;

	describe('body-size limit — request-smuggling resistance', () => {
		// Positive control: prove the server returns >1 response on a single
		// connection. Without this the smuggling assertion below would be
		// vacuously green on a server that simply never reuses connections — and
		// it also validates `count_responses` actually counts a second response.
		test('control: two pipelined requests → ≥2 responses (connection reuse is real)', async () => {
			const two_requests =
				`GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\n\r\n` +
				`GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
			const response = await send_raw(base_url, two_requests, RAW_READ_TIMEOUT_MS);
			const n = count_responses(response);
			assert.ok(
				n >= 2,
				`expected ≥2 responses on one keep-alive connection (got ${n}); without ` +
					`connection reuse — or with an undercounting matcher — the smuggling ` +
					`assertion below is not a real signal. Raw head: ${response.slice(0, 120)}`
			);
		});

		test('oversized POST + pipelined GET → no request smuggled', async () => {
			const oversized_len = BODY_LIMIT_DEFAULT_BYTES + 1024;
			const pipelined_get = `GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\n\r\n`;
			// One write: an over-cap POST (rejected on Content-Length) immediately
			// followed by a GET.
			const payload =
				`POST ${rpc_path} HTTP/1.1\r\n` +
				`Host: ${host}\r\n` +
				`Content-Type: application/json\r\n` +
				`Content-Length: ${oversized_len}\r\n` +
				`\r\n` +
				'x'.repeat(oversized_len) +
				pipelined_get;

			const response = await send_raw(base_url, payload, RAW_READ_TIMEOUT_MS);
			const n = count_responses(response);

			// The reject closes the connection, so the pipelined GET is never
			// reached — **at most one** response comes back (the 413, or none if
			// the close raced the read). A *second* response means the connection
			// was kept and the GET served. The control above proves a second
			// response *would* be seen, so `<= 1` is a real signal.
			assert.ok(
				n <= 1,
				`expected at most one response (oversized reject closes the connection; the ` +
					`pipelined GET must not be reached). Saw ${n}. Raw head: ${response.slice(0, 120)}`
			);
		});

		// A request carrying both `Content-Length` and `Transfer-Encoding`, with
		// a GET pipelined behind it. The body is a small JSON-RPC envelope,
		// chunked and terminated, so a backend that frames on
		// `Transfer-Encoding` reads a whole request. `Content-Length` disagrees
		// with the chunked length in both cases: framing on it instead would
		// leave body bytes to be parsed as the next request.
		const envelope = JSON.stringify({ jsonrpc: '2.0', id: 'cl-te', method: 'heartbeat' });
		const chunked_envelope = `${envelope.length.toString(16)}\r\n${envelope}\r\n0\r\n\r\n`;
		const framing_cases: ReadonlyArray<readonly [name: string, framing_headers: string]> = [
			[
				'Content-Length ahead of Transfer-Encoding',
				`Content-Length: 5\r\nTransfer-Encoding: chunked\r\n`
			],
			[
				'Transfer-Encoding ahead of Content-Length',
				`Transfer-Encoding: chunked\r\nContent-Length: 5\r\n`
			]
		];
		for (const [name, framing_headers] of framing_cases) {
			test(`${name} + pipelined GET → connection closed, GET never served`, async () => {
				const payload =
					`POST ${rpc_path} HTTP/1.1\r\n` +
					`Host: ${host}\r\n` +
					`Content-Type: application/json\r\n` +
					framing_headers +
					`\r\n` +
					chunked_envelope +
					`GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\n\r\n`;

				const { received, closed_by_server } = await exchange_raw(
					base_url,
					payload,
					RAW_READ_TIMEOUT_MS
				);
				const n = count_responses(received);
				// Refused with 400 or answered — the status is the implementation's.
				// A second response is the pipelined GET served on a connection the
				// ambiguous request should have ended.
				assert.ok(
					n <= 1,
					`expected at most one response to a request carrying both Content-Length ` +
						`and Transfer-Encoding (the pipelined GET must not be served). Saw ${n}. ` +
						`Raw head: ${received.slice(0, 120)}`
				);
				assert.ok(
					closed_by_server,
					`expected the server to close the connection after a request carrying both ` +
						`Content-Length and Transfer-Encoding; it was still open after ` +
						`${RAW_READ_TIMEOUT_MS}ms. Raw head: ${received.slice(0, 120)}`
				);
			});
		}
	});
};
