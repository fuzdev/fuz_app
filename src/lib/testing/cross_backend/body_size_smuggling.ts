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
 * reliably by `describe_body_size_cross_tests`, which sends the over-cap
 * request's head and no body, so no upload races the close; this test owns
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

import { describe, test, assert } from 'vitest';

import {
	raw_http_count_responses,
	raw_http_exchange,
	RAW_HTTP_READ_TIMEOUT_MS
} from '../transports/raw_http.ts';
import { SPINE_BODY_LIMIT_DEFAULT_BYTES, SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** Options for the smuggling probe — needs the raw URL, not a transport. */
export interface BodySizeSmugglingCrossTestOptions {
	/** Base URL the spawned backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** RPC endpoint path to target. Default `/api/rpc`. */
	readonly rpc_path?: string;
}

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
		// it also validates `raw_http_count_responses` actually counts a second response.
		test('control: two pipelined requests → ≥2 responses (connection reuse is real)', async () => {
			const two_requests =
				`GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\n\r\n` +
				`GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
			const { received: response } = await raw_http_exchange(base_url, two_requests, {
				read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS
			});
			const n = raw_http_count_responses(response);
			assert.ok(
				n >= 2,
				`expected ≥2 responses on one keep-alive connection (got ${n}); without ` +
					`connection reuse — or with an undercounting matcher — the smuggling ` +
					`assertion below is not a real signal. Raw head: ${response.slice(0, 120)}`
			);
		});

		test('oversized POST + pipelined GET → no request smuggled', async () => {
			const oversized_len = SPINE_BODY_LIMIT_DEFAULT_BYTES + 1024;
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

			const { received: response } = await raw_http_exchange(base_url, payload, {
				read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS
			});
			const n = raw_http_count_responses(response);

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

				const { received, closed_by_server } = await raw_http_exchange(base_url, payload, {
					read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS
				});
				const n = raw_http_count_responses(received);
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
						`${RAW_HTTP_READ_TIMEOUT_MS}ms. Raw head: ${received.slice(0, 120)}`
				);
			});
		}
	});
};
